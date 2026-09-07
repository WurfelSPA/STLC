'use strict';
/**
 * geo-utils.js
 *
 * Matemática de distancias GPS compartida entre sync-tlchile.js y
 * map-matching.js — antes vivía duplicada solo en sync-tlchile.js.
 */

function haversineMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Punto más cercano (y su distancia) entre un punto y el TRAMO RECTO entre
// dos lecturas GPS consecutivas — no solo la distancia a cada lectura
// suelta. Aproximación plana (válida para segmentos de unos pocos km, muy
// por sobre la distancia real entre dos puntos GPS consecutivos de un mismo
// vehículo).
//
// OJO: el punto interpolado {lat, lon} que devuelve esto NO es ninguna de
// las dos lecturas GPS crudas (A ni B) — es el punto de máxima cercanía
// sobre la línea recta entre ambas, que puede quedar a cientos de metros de
// cualquiera de las dos si el GPS reporta cada 30-60s y el vehículo iba
// rápido. Es el punto correcto para guardar como "dónde ocurrió el cruce"
// (bug real encontrado 2026-09-07: usar la lectura B cruda como si fuera el
// punto de cruce hacía que dos pasadas confirmadas del mismo pórtico, ambas
// con distancia_m<30, quedaran guardadas a >400m entre sí — inservible como
// ancla empírica).
function puntoMasCercanoEnSegmento(latP, lonP, latA, lonA, latB, lonB) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const cosRef = Math.cos(toRad(latP));
  const ax = toRad(lonA - lonP) * cosRef * R;
  const ay = toRad(latA - latP) * R;
  const bx = toRad(lonB - lonP) * cosRef * R;
  const by = toRad(latB - latP) * R;
  const dx = bx - ax, dy = by - ay;
  const lenCuadrado = dx * dx + dy * dy;
  let t = lenCuadrado === 0 ? 0 : (-ax * dx - ay * dy) / lenCuadrado;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return {
    lat: latP + toDeg(cy / R),
    lon: lonP + toDeg(cx / (R * cosRef)),
    distancia: Math.hypot(cx, cy),
  };
}

function distanciaPuntoASegmentoMetros(latP, lonP, latA, lonA, latB, lonB) {
  return puntoMasCercanoEnSegmento(latP, lonP, latA, lonA, latB, lonB).distancia;
}

module.exports = { haversineMetros, distanciaPuntoASegmentoMetros, puntoMasCercanoEnSegmento };
