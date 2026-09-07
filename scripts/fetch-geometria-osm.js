#!/usr/bin/env node
'use strict';
/**
 * fetch-geometria-osm.js
 *
 * Descarga (o refresca) la geometría real de las calzadas tarificadas desde
 * OpenStreetMap (Overpass API) y la cachea en scripts/geometria-corredores/
 * — la usa map-matching.js para el método NUEVO de detección de pasadas
 * (distancia a la calzada real, no a un punto con radio de 150m).
 *
 * Corre manualmente cuando haga falta (nunca en el cron de sync-tlchile —
 * Overpass es lento y con rate-limit propio, no apto para correr cada 30
 * min). Uso: node scripts/fetch-geometria-osm.js
 *
 * Cobertura verificada 2026-09-07: 89/91 pórticos calzan a <60m de la
 * geometría descargada acá (la mayoría a <10m). Los 2 casos "Lateral"
 * (Tongoy, Guanaqueros) necesitan el filtro ampliado (+primary/secondary)
 * porque son accesos laterales, no la vía principal — por eso tienen su
 * propia entrada en GRUPOS con `filtro: 'amplio'`.
 */

const fs = require('fs');
const path = require('path');

const DEST = path.join(__dirname, 'geometria-corredores');

const FILTRO_ESTRICTO = 'motorway|trunk|motorway_link|trunk_link';
const FILTRO_AMPLIO = 'motorway|trunk|motorway_link|trunk_link|primary|primary_link|secondary';

// bbox: [south, west, north, east]. radio: metros alrededor de un punto.
// Un grupo trae bbox O (lat,lon,radio), no ambos.
const GRUPOS = [
  // --- Corredores metropolitanos (varios pórticos comparten la misma calzada) ---
  { grupo: 'costanera-norte', bbox: [-33.4403, -70.8010, -33.3611, -70.5127], filtro: FILTRO_ESTRICTO },
  { grupo: 'vespucio-norte', bbox: [-33.4929, -70.7949, -33.3558, -70.6230], filtro: FILTRO_ESTRICTO },
  { grupo: 'autopista-central', bbox: [-33.6344, -70.7258, -33.3586, -70.6462], filtro: FILTRO_ESTRICTO },
  { grupo: 'vespucio-sur', bbox: [-33.5515, -70.7225, -33.4710, -70.5688], filtro: FILTRO_ESTRICTO },
  { grupo: 'avo', bbox: [-33.4425, -70.6298, -33.3816, -70.5645], filtro: FILTRO_ESTRICTO },
  { grupo: 'tunel-san-cristobal', lat: -33.398616, lon: -70.615725, radio: 1500, filtro: FILTRO_ESTRICTO },
  { grupo: 'amb', lat: -33.416596, lon: -70.792727, radio: 1500, filtro: FILTRO_ESTRICTO },

  // --- Peajes interurbanos aislados (Ruta 5 recorre cientos de km, cada uno es su propia plaza) ---
  { grupo: 'lampa', lat: -33.2356, lon: -70.7589, radio: 1500, filtro: FILTRO_ESTRICTO },
  { grupo: 'lasvegas', lat: -32.8433, lon: -70.9893, radio: 1500, filtro: FILTRO_ESTRICTO },
  { grupo: 'pichidangui', lat: -32.1750, lon: -71.5207, radio: 1500, filtro: FILTRO_ESTRICTO },
  { grupo: 'troncalsur', lat: -31.4200, lon: -71.5704, radio: 1500, filtro: FILTRO_ESTRICTO },
  { grupo: 'ptacolorada', lat: -29.3710, lon: -71.0732, radio: 1500, filtro: FILTRO_ESTRICTO },
  { grupo: 'totoral', lat: -27.9971, lon: -70.5658, radio: 1500, filtro: FILTRO_ESTRICTO },
  { grupo: 'ptoviejo', lat: -27.3482, lon: -70.6364, radio: 2000, filtro: FILTRO_ESTRICTO },
  // Tongoy/Guanaqueros son accesos "Lateral" (ver PORTICOS en sync-tlchile.js)
  // — no la Ruta 5 principal, sino una vía secundaria de acceso. Con el
  // filtro estricto no calzaban (>120m); con primary/secondary calzan a 2-3m.
  { grupo: 'tongoy', lat: -30.3517, lon: -71.4323, radio: 3000, filtro: FILTRO_AMPLIO },
  { grupo: 'guanaqueros', lat: -30.1974, lon: -71.3880, radio: 3000, filtro: FILTRO_AMPLIO },
];

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Overpass público rate-limita agresivo; con margen de sobra entre
// consultas para no gatillarlo (confirmado en vivo 2026-09-07: <20s entre
// consultas devuelve "rate_limited" o "timeout" con esta misma API).
const ESPERA_ENTRE_CONSULTAS_MS = 25_000;

function construirQuery({ bbox, lat, lon, radio, filtro }) {
  const alcance = bbox ? `(${bbox.join(',')})` : `(around:${radio},${lat},${lon})`;
  return `[out:json][timeout:60];(way["highway"~"${filtro}"]${alcance};); out geom;`;
}

async function consultarOverpass(query, intentos = 3) {
  for (let i = 1; i <= intentos; i++) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    const texto = await res.text();
    try {
      return JSON.parse(texto);
    } catch {
      console.log(`  [!] Intento ${i}/${intentos} falló (respuesta no-JSON, probable rate-limit/timeout de Overpass). Reintentando...`);
      if (i < intentos) await new Promise((r) => setTimeout(r, ESPERA_ENTRE_CONSULTAS_MS));
    }
  }
  throw new Error('Overpass no respondió JSON válido tras reintentar');
}

function comprimir(json) {
  const elementos = json.elements || [];
  const segmentos = [];
  for (const e of elementos) {
    const geom = e.geometry || [];
    if (geom.length < 2) continue;
    const oneway = e.tags && (e.tags.oneway === 'yes' || e.tags.oneway === '-1') ? e.tags.oneway : null;
    // Redondeo a 6 decimales (~11cm) — de sobra para esta tolerancia, evita
    // arrastrar ruido de precisión de punto flotante en el archivo cacheado.
    const pts = geom.map((p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]);
    segmentos.push({ pts, oneway });
  }
  return segmentos;
}

async function main() {
  fs.mkdirSync(DEST, { recursive: true });
  for (let i = 0; i < GRUPOS.length; i++) {
    const cfg = GRUPOS[i];
    if (i > 0) await new Promise((r) => setTimeout(r, ESPERA_ENTRE_CONSULTAS_MS));
    console.log(`[${cfg.grupo}] Consultando Overpass...`);
    const query = construirQuery(cfg);
    const json = await consultarOverpass(query);
    const segmentos = comprimir(json);
    const salida = {
      grupo: cfg.grupo,
      fuente: `OpenStreetMap (Overpass API), refrescado ${new Date().toISOString().slice(0, 10)}`,
      ways: segmentos.length,
      segmentos,
    };
    fs.writeFileSync(path.join(DEST, `${cfg.grupo}.json`), JSON.stringify(salida));
    console.log(`[${cfg.grupo}] ✅ ${segmentos.length} vías guardadas.`);
  }
  console.log('=== Geometría OSM actualizada ===');
}

main().catch((err) => {
  console.error('ERROR FATAL:', err.message);
  process.exit(1);
});
