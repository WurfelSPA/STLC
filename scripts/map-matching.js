'use strict';
/**
 * map-matching.js
 *
 * Método NUEVO de detección de pasadas: en vez de medir la distancia a la
 * COORDENADA de un pórtico (radio de 150m, no distingue la autopista de una
 * calle/caletera paralela a 100-150m), mide la distancia a la CALZADA REAL
 * del corredor (geometría de OpenStreetMap, cacheada en
 * scripts/geometria-corredores/). Una calle local simplemente no tiene por
 * qué coincidir con la calzada real de la autopista dentro de una tolerancia
 * ajustada (~30m) — a diferencia del radio de 150m, que si la abarca.
 *
 * Fase actual: corre EN PARALELO al método de radio existente, solo para
 * comparar (ver porticos_comparacion_metodos en sync-tlchile.js). Todavía no
 * reemplaza al método que confirma pasadas reales.
 *
 * Para refrescar la geometría cacheada: node scripts/fetch-geometria-osm.js
 */

const fs = require('fs');
const path = require('path');
const { distanciaPuntoASegmentoMetros } = require('./geo-utils');

const DIR_GEOMETRIA = path.join(__dirname, 'geometria-corredores');
const cache = new Map();

function cargarGrupo(grupo) {
  if (cache.has(grupo)) return cache.get(grupo);
  const archivo = path.join(DIR_GEOMETRIA, `${grupo}.json`);
  let segmentos = null;
  if (fs.existsSync(archivo)) {
    const datos = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    segmentos = [];
    for (const s of datos.segmentos || []) {
      for (let i = 0; i < s.pts.length - 1; i++) {
        segmentos.push({ a: s.pts[i], b: s.pts[i + 1], clase: s.clase || 'otra' });
      }
    }
  }
  cache.set(grupo, segmentos);
  return segmentos;
}

// Distancia mínima (metros) desde (lat, lon) a la calzada real cacheada del
// grupo, sin distinguir clase de vía. null si no hay geometría cacheada para
// ese grupo — el llamador decide qué hacer con "sin dato" (nunca bloquea la
// detección actual).
function distanciaCalzada(grupo, lat, lon) {
  if (!grupo) return null;
  const segmentos = cargarGrupo(grupo);
  if (!segmentos || !segmentos.length) return null;
  let min = Infinity;
  for (const { a, b } of segmentos) {
    const d = distanciaPuntoASegmentoMetros(lat, lon, a[0], a[1], b[0], b[1]);
    if (d < min) min = d;
  }
  return min;
}

// Igual que distanciaCalzada, pero separado por clase de vía (principal =
// motorway/trunk, la calzada tarificada real; rampa = motorway_link/
// trunk_link, un acceso que por definición nace pegado a la vía local de la
// que se desprende). Una rampa puede quedar a los mismos pocos metros que
// una calle/caletera paralela justo antes de separarse de ella — por eso
// "distancia a CUALQUIER vía tarificada" (distanciaCalzada de arriba) no
// alcanza para distinguir "iba en la caletera" de "iba tomando la rampa"; la
// distancia a la calzada PRINCIPAL sí, porque la autopista misma no corre
// pegada a la caletera. Devuelve null por clase sin segmentos de esa clase.
function distanciasPorClase(grupo, lat, lon) {
  if (!grupo) return { principal: null, rampa: null, otra: null };
  const segmentos = cargarGrupo(grupo);
  if (!segmentos || !segmentos.length) return { principal: null, rampa: null, otra: null };
  const min = { principal: Infinity, rampa: Infinity, otra: Infinity };
  for (const { a, b, clase } of segmentos) {
    const d = distanciaPuntoASegmentoMetros(lat, lon, a[0], a[1], b[0], b[1]);
    if (d < min[clase]) min[clase] = d;
  }
  return {
    principal: min.principal === Infinity ? null : min.principal,
    rampa: min.rampa === Infinity ? null : min.rampa,
    otra: min.otra === Infinity ? null : min.otra,
  };
}

module.exports = { distanciaCalzada, distanciasPorClase };
