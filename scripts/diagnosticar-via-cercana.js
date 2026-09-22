#!/usr/bin/env node
'use strict';
/**
 * diagnosticar-via-cercana.js
 *
 * Diagnóstico puntual (no toca nada de producción, no escribe archivos):
 * consulta Overpass con TODOS los tags de las vías dentro de un radio chico
 * alrededor de una coordenada, para saber exactamente qué vía real está
 * matcheando como "principal"/"rampa"/"otra" en map-matching.js -- el
 * archivo cacheado en geometria-corredores/ solo guarda oneway+clase, no
 * el nombre, así que no alcanza para depurar esto desde el JSON guardado.
 *
 * Motivo (2026-09-22): 5.1/5.3 (Vespucio Sur, Grecia-Quilín-Las Torres) dan
 * "principal" a 8-13m después de refrescar la geometría -- pero el usuario
 * confirmó con capturas de Google Maps que iba por la caletera (Av. Américo
 * Vespucio Sur), no por la autopista tarificada (Autop. Vespucio Sur), dos
 * vías distintas que corren pegadas en ese tramo. Hay que confirmar si OSM
 * tiene la caletera mal clasificada como motorway/trunk, o si de verdad las
 * dos vías están a <15m entre sí (ninguna de las dos opciones es evidente
 * sin ver el nombre real de la vía que matchea).
 *
 * Uso: node scripts/diagnosticar-via-cercana.js <lat> <lon> [radioMetros]
 */
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const FILTRO = 'motorway|trunk|motorway_link|trunk_link|primary|primary_link|secondary';

async function consultarOverpass(query, intentos = 3) {
  for (let i = 1; i <= intentos; i++) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'STLC-geometria-corredores/1.0 (github.com/WurfelSPA/STLC)',
        'Accept': 'application/json, text/plain, */*',
      },
      body: `data=${encodeURIComponent(query)}`,
    });
    const texto = await res.text();
    try {
      return JSON.parse(texto);
    } catch {
      console.log(`  [!] Intento ${i}/${intentos} falló (HTTP ${res.status}). ${texto.slice(0, 200).replace(/\n/g, ' ')}`);
      if (i < intentos) await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  throw new Error('Overpass no respondió JSON válido tras reintentar');
}

// Haversine + distancia punto-segmento, copiado liviano (sin depender de
// geo-utils.js para que este script sea standalone y facil de correr suelto).
function haversineMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function distanciaPuntoASegmentoMetros(pLat, pLon, aLat, aLon, bLat, bLon) {
  // Aproximación simple (suficiente para depurar a esta escala de metros):
  // proyecta en un plano local equirectangular centrado en el punto.
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const cosLat = Math.cos(toRad(pLat));
  const toXY = (lat, lon) => [(toRad(lon) - toRad(pLon)) * cosLat * R, (toRad(lat) - toRad(pLat)) * R];
  const [px, py] = [0, 0];
  const [ax, ay] = toXY(aLat, aLon);
  const [bx, by] = toXY(bLat, bLon);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

async function main() {
  const [, , latStr, lonStr, radioStr] = process.argv;
  const lat = Number(latStr), lon = Number(lonStr), radio = Number(radioStr || 300);
  if (!lat || !lon) throw new Error('Uso: node diagnosticar-via-cercana.js <lat> <lon> [radioMetros]');

  console.log(`Consultando Overpass: radio ${radio}m alrededor de ${lat},${lon}...`);
  const query = `[out:json][timeout:60];(way["highway"~"${FILTRO}"](around:${radio},${lat},${lon}););out geom;`;
  const json = await consultarOverpass(query);
  const elementos = json.elements || [];
  console.log(`${elementos.length} vías encontradas dentro de ${radio}m.\n`);

  const filas = [];
  for (const e of elementos) {
    const geom = e.geometry || [];
    if (geom.length < 2) continue;
    let min = Infinity;
    for (let i = 0; i < geom.length - 1; i++) {
      const d = distanciaPuntoASegmentoMetros(lat, lon, geom[i].lat, geom[i].lon, geom[i + 1].lat, geom[i + 1].lon);
      if (d < min) min = d;
    }
    filas.push({
      id: e.id,
      highway: e.tags?.highway || '(sin tag highway)',
      name: e.tags?.name || '(sin nombre)',
      ref: e.tags?.ref || '(sin ref)',
      toll: e.tags?.toll || '(sin tag toll)',
      lanes: e.tags?.lanes || '(sin tag lanes)',
      oneway: e.tags?.oneway || '(sin tag oneway)',
      distanciaM: Math.round(min),
    });
  }

  filas.sort((a, b) => a.distanciaM - b.distanciaM);
  console.log('Ordenado por distancia al punto (más cercana primero):\n');
  for (const f of filas) {
    console.log(
      `${String(f.distanciaM).padStart(5)}m | highway=${f.highway.padEnd(14)} | name="${f.name}" | ref=${f.ref} | toll=${f.toll} | lanes=${f.lanes} | oneway=${f.oneway} | osm_id=${f.id} (https://www.openstreetmap.org/way/${f.id})`
    );
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
