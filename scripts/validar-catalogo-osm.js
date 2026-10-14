#!/usr/bin/env node
'use strict';
/**
 * validar-catalogo-osm.js
 *
 * Diagnóstico puntual (SOLO LECTURA: no toca porticos_catalogo ni ninguna
 * otra tabla, no afecta la detección en vivo): compara cada coordenada de
 * porticos_catalogo contra el pórtico/peaje más cercano que encuentre en
 * OpenStreetMap (vía Overpass), y avisa cuando la diferencia supera 100m.
 *
 * Motivo (2026-10-14, "optimización #3" del plan post-piloto AGP): el
 * corrimiento real de 22 pórticos del Eje Gral. Velásquez (PA19-PA28) y del
 * corredor PA5/PA6/PA7/PA32/PA37 -- confirmado y corregido el 2026-10-13 --
 * hubiera aparecido acá de inmediato, en vez de depender de que un cliente
 * externo (AGP) lo detectara primero cruzando tránsitos reales.
 *
 * Limitación conocida, importante: esto SOLO puede validar pórticos donde
 * OSM tiene el nodo mapeado como barrier=toll_booth o highway=toll_gantry
 * dentro del radio de búsqueda. Donde OSM no tiene nada (ej. Gabriela/
 * Tocornal en Ruta del Maipo, sin coordenada confiable todavía) esto NO
 * puede confirmar ni descartar nada -- se reporta aparte como
 * "SIN_DATOS_OSM", no como error.
 *
 * Una consulta Overpass por CONCESIONARIA (bounding box de todos sus puntos
 * + margen), no una por pórtico -- con 99 pórticos en 15 concesionarias,
 * una consulta por pórtico sería lenta y mucho más probable de toparse con
 * el rate-limit/timeout del servidor público de Overpass (visto real varias
 * veces hoy). Reintenta con un mirror si el servidor principal da 504.
 *
 * Uso: node scripts/validar-catalogo-osm.js
 * Requiere: SUPABASE_SERVICE_ROLE_KEY (mismo que sync-tlchile.js).
 */
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const { haversineMetros } = require('./geo-utils');

const UMBRAL_ALERTA_M = 100;
const MARGEN_BBOX_GRADOS = 0.03; // ~3km de margen alrededor de los puntos de cada concesionaria

const OVERPASS_MIRRORS = [
  { host: 'overpass-api.de', path: '/api/interpreter' },
  { host: 'overpass.kumi.systems', path: '/api/interpreter' },
];

function consultarOverpass(query) {
  return new Promise((resolve, reject) => {
    const data = 'data=' + encodeURIComponent(query);
    function intentar(i) {
      if (i >= OVERPASS_MIRRORS.length) { reject(new Error('Todos los mirrors de Overpass fallaron')); return; }
      const mirror = OVERPASS_MIRRORS[i];
      const req = https.request({
        hostname: mirror.host, path: mirror.path, method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data),
          'User-Agent': 'stlc-validar-catalogo-osm/1.0 (amelendez@patagonica.cl)',
        },
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          if (res.statusCode !== 200) { console.log(`[overpass] ${mirror.host} devolvió HTTP ${res.statusCode}, probando siguiente mirror...`); intentar(i + 1); return; }
          try { resolve(JSON.parse(body)); } catch (e) { console.log(`[overpass] ${mirror.host} devolvió algo no-JSON, probando siguiente mirror...`); intentar(i + 1); }
        });
      });
      req.on('error', () => intentar(i + 1));
      req.write(data);
      req.end();
    }
    intentar(0);
  });
}

async function nodosTollEnBbox(minLat, minLon, maxLat, maxLon) {
  const query = `
    [out:json][timeout:50];
    (
      node["barrier"="toll_booth"](${minLat},${minLon},${maxLat},${maxLon});
      node["highway"="toll_gantry"](${minLat},${minLon},${maxLat},${maxLon});
    );
    out tags;
  `;
  const json = await consultarOverpass(query);
  return (json.elements || []).map((el) => ({ lat: el.lat, lon: el.lon, name: el.tags?.name || null }));
}

async function main() {
  const { SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY');
  const supabase = createClient('https://lomkolhgmkvshucqjuhf.supabase.co', SUPABASE_SERVICE_ROLE_KEY);

  const { data: porticos, error } = await supabase.from('porticos_catalogo').select('codigo, concesionaria, tramo, lat, lon');
  if (error) throw new Error(`Error leyendo porticos_catalogo: ${error.message}`);

  const porConcesionaria = new Map();
  for (const p of porticos) {
    if (!porConcesionaria.has(p.concesionaria)) porConcesionaria.set(p.concesionaria, []);
    porConcesionaria.get(p.concesionaria).push(p);
  }

  const resumen = { ok: 0, revisar: [], sinDatos: [] };

  for (const [concesionaria, puntos] of porConcesionaria) {
    const lats = puntos.map((p) => p.lat), lons = puntos.map((p) => p.lon);
    const minLat = Math.min(...lats) - MARGEN_BBOX_GRADOS, maxLat = Math.max(...lats) + MARGEN_BBOX_GRADOS;
    const minLon = Math.min(...lons) - MARGEN_BBOX_GRADOS, maxLon = Math.max(...lons) + MARGEN_BBOX_GRADOS;

    console.log(`\n=== ${concesionaria} (${puntos.length} pórticos) ===`);
    let nodosOsm;
    try {
      nodosOsm = await nodosTollEnBbox(minLat, minLon, maxLat, maxLon);
    } catch (e) {
      console.log(`[overpass] ⚠️ No se pudo consultar esta zona (${e.message}) -- se omite, reintentar más tarde.`);
      continue;
    }
    console.log(`[overpass] ${nodosOsm.length} nodos de peaje encontrados en la zona.`);

    for (const p of puntos) {
      if (!nodosOsm.length) {
        resumen.sinDatos.push(`${p.codigo} (${concesionaria})`);
        console.log(`  SIN_DATOS_OSM  ${p.codigo} — ${p.tramo}`);
        continue;
      }
      let masCercano = null, distMin = Infinity;
      for (const n of nodosOsm) {
        const d = haversineMetros(p.lat, p.lon, n.lat, n.lon);
        if (d < distMin) { distMin = d; masCercano = n; }
      }
      if (distMin > UMBRAL_ALERTA_M) {
        resumen.revisar.push(`${p.codigo} (${concesionaria}): ${Math.round(distMin)}m del nodo OSM más cercano${masCercano.name ? ` ("${masCercano.name}")` : ' (sin nombre)'}`);
        console.log(`  ⚠️ REVISAR     ${p.codigo} — ${p.tramo} — ${Math.round(distMin)}m del nodo OSM más cercano${masCercano.name ? ` ("${masCercano.name}")` : ''}`);
      } else {
        resumen.ok++;
        console.log(`  OK             ${p.codigo} — ${Math.round(distMin)}m`);
      }
    }
    // Pausa chica entre concesionarias para no golpear Overpass seguido.
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`\n=== RESUMEN ===`);
  console.log(`OK: ${resumen.ok}`);
  console.log(`A revisar (>${UMBRAL_ALERTA_M}m): ${resumen.revisar.length}`);
  for (const r of resumen.revisar) console.log(`  - ${r}`);
  console.log(`Sin datos OSM para comparar: ${resumen.sinDatos.length}`);
  for (const s of resumen.sinDatos) console.log(`  - ${s}`);
}

main().catch((err) => { console.error('ERROR FATAL:', err.message); process.exitCode = 1; });
