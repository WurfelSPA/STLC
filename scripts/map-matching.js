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

const UMBRAL_CALZADA_DEFAULT_M = 30;

// Valida si un punto GPS interpolado pertenece geométricamente a la calzada del
// grupo/corredor especificado dentro del umbral dado. Si el grupo no tiene
// geometría cacheada, se considera válido como fallback seguro (para no romper
// pórticos rurales o interurbanos aislados que aún no tienen geometría OSM).
//
// NO CONECTADA a sync-tlchile.js todavía (definida acá para uso futuro, si se
// logra calibrar un umbral confiable). Se intentó usarla 2026-09-15 para
// reemplazar FALSOS_POSITIVOS_CONOCIDOS y los datos reales de
// porticos_comparacion_metodos lo descartaron: el ruido GPS de un vehículo
// ESTACIONADO junto a un pórtico (caso P11, oficina del usuario en Conchalí)
// produce distancia_calzada_m de 2-9m — indistinguible de un cruce real
// confirmado por otro vehículo en el mismo pórtico (1-7m) — mientras que
// cruces reales confirmados en otros pórticos (PA18, P3, P101, PA16, PA21)
// llegan a 44-112m por imprecisión del mapeo OSM de esos corredores. Un
// umbral fijo no habría filtrado el falso positivo que se buscaba resolver
// y sí habría arriesgado rechazar cruces reales en corredores con geometría
// menos precisa. Ver FALSOS_POSITIVOS_CONOCIDOS en sync-tlchile.js y
// [[project_agp_tracklink_integration]] en memoria.
function esCandidatoValidoPorCalzada(grupo, lat, lon, umbral = UMBRAL_CALZADA_DEFAULT_M) {
  if (!grupo) return { valido: true, distancia: null };
  const d = distanciaCalzada(grupo, lat, lon);
  if (d === null) return { valido: true, distancia: null };
  return { valido: d <= umbral, distancia: d };
}

module.exports = { distanciaCalzada, distanciasPorClase, esCandidatoValidoPorCalzada, UMBRAL_CALZADA_DEFAULT_M };
