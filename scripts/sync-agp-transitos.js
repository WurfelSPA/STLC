#!/usr/bin/env node
'use strict';
/**
 * sync-agp-transitos.js
 *
 * Consulta la API de AGP "tránsitos no facturados" (autopista-nof, ambiente
 * de prueba compartido 2026-09-15) y usa sus montos REALES para rellenar
 * porticos_pasadas_reales.monto_agp — misma idea que sync-smartreport.js
 * pero con otra fuente independiente (viene directo de las concesionarias
 * vía el propio AGP, no de un tercero).
 *
 * IMPORTANTE — esta API solo tiene datos de vehículos que son CLIENTES
 * REALES de AGP (con TAG contratado directamente con ellos), confirmado
 * 2026-09-15: se probó con VVJG-14 (auto de pruebas interno de Tracklink,
 * sin TAG AGP) y devolvió transitos:[] dos veces seguidas (incluso
 * esperando los ~3 min que AGP dijo que tardaba la lectura asíncrona) —
 * no es un problema de timing, es que AGP no tiene nada que reportar para
 * un vehículo que no es su cliente. Ver acuerdo original (27-ago): "las
 * patentes seleccionadas... correspondan a vehículos asociados al cliente
 * de AGP". No agregar acá ninguna patente que no sea confirmada
 * explícitamente como cliente AGP real (ver PATENTES_AGP más abajo, vacía
 * hasta que se instale el primer dispositivo FTC en un vehículo de Renting
 * Lucano — ver [[project_agp_tracklink_integration]] en memoria).
 *
 * La consulta es asíncrona del lado de AGP: la primera llamada para una
 * patente puede devolver transitos:[] mientras encola una lectura nueva
 * (tardó ~2-3 min en su propia prueba). Como este script corre en un cron
 * diario (no una sola vez), no hace falta reintentar dentro de la misma
 * corrida — la corrida de mañana ya trae lo que quedó encolado hoy.
 *
 * Variables de entorno esperadas (GitHub Secrets):
 *   AGP_TRANSITOS_TOKEN, AGP_TRANSITOS_ID_SUCURSAL (opcional, default 3018 =
 *   ambiente de prueba), SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY');
}
if (!process.env.AGP_TRANSITOS_TOKEN) {
  throw new Error('Falta la variable de entorno AGP_TRANSITOS_TOKEN');
}
const supabase = createClient(
  'https://lomkolhgmkvshucqjuhf.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AGP_URL = 'https://apim-agpsa-dev.azure-api.net/autopista-nof/api/consulta';
const AGP_ID_SUCURSAL = Number(process.env.AGP_TRANSITOS_ID_SUCURSAL || 3018);
// Rango amplio (tope real de AGP: 60 días) — la consulta es async del lado
// de ellos, así que un rango generoso cubre lecturas que tardaron más de un
// día en completarse, sin depender de un checkpoint incremental frágil.
const AGP_DIAS_ATRAS = 14;
const VENTANA_EMPAREJAR_MS = 10 * 60 * 1000; // ±10 min, igual que sync-smartreport.js

// Vehículos que son clientes REALES de AGP (con TAG contratado directamente
// con ellos, ver nota arriba) — agregar acá cuando se instale el primer FTC
// en un vehículo de Renting Lucano. "ppu" es como lo espera la API de AGP
// (sin guión); "patente" es como está en porticos_vehiculos.
const PATENTES_AGP = [
  // { patente: 'VLKT57', ppu: 'VLKT57' },
];

// --- Mapeo de códigos de AGP a nuestro portico_codigo -----------------------
// NO VALIDADO todavía contra datos reales superpuestos (VVJG-14 no tiene
// cuenta AGP y el único ejemplo real que dieron, VLKT57, no tiene nuestro
// GPS instalado) — revisar/ajustar apenas exista un vehículo con ambas
// fuentes a la vez. Basado en la respuesta real de ejemplo del 2026-09-15
// (Costanera Norte: "P8.0OP", "SB", "P2.2PO", "P2.1PO", "P3 PO" — sufijo de
// sentido de tránsito, se descarta acá igual que Smart Report ignora el
// suyo). RutaPass (R68/R78/R66/Itata) agrupa varias concesiones en un solo
// campo "autopista" — no tenemos catálogo propio de esos corredores
// todavía, así que esos tránsitos quedan "sin mapear" a propósito.
function codigoInterno(autopista, puntoCobro) {
  const a = (autopista || '').toUpperCase();
  const p = (puntoCobro || '').trim().toUpperCase().replace(/\s*(OP|PO)$/, '');
  if (a === 'COSTANERA NORTE') {
    const MAP_CN = {
      'P8.0': 'P8.0', 'P8.1': 'P8.1', 'P8.2': 'P8.2', 'P8.3': 'P8.3',
      SB: 'SB', EP: 'EP', EV: 'EV',
      'P2.2': 'P2.2CN', 'P2.1': 'P2.1', P3: 'P3', P0: 'P0', P4: 'P4CN', P5: 'P5CN', P7: 'P7CN',
    };
    return MAP_CN[p] || null;
  }
  return null;
}

async function consultarAGP(ppu, desde, hasta) {
  const res = await fetch(AGP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AGP_TRANSITOS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ppu, desde, hasta, id_sucursal: AGP_ID_SUCURSAL, porcentaje: 0 }),
  });
  if (!res.ok) throw new Error(`AGP consulta falló para ${ppu} (HTTP ${res.status}): ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

// AGP documenta que "fecha" puede venir como YYYY-MM-DD o DD-MM-YYYY según
// la concesionaria que la reporta — normalizar antes de combinar con "hora".
function normalizarFecha(fecha) {
  return /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : fecha.split('-').reverse().join('-');
}

async function emparejarYActualizar(vehiculoId, transitos) {
  let actualizadas = 0, sinMapear = 0, sinPasada = 0;
  for (const t of transitos) {
    const codigo = codigoInterno(t.autopista, t.puntoCobro);
    if (!codigo) { sinMapear++; continue; }

    const tsTransito = new Date(`${normalizarFecha(t.fecha)}T${t.hora}:00-03:00`); // hora Chile real
    const { data: candidatas, error } = await supabase
      .from('porticos_pasadas_reales')
      .select('id, ts')
      .eq('vehiculo_id', vehiculoId)
      .eq('confirmado', true)
      .eq('portico_codigo', codigo)
      .is('monto_agp', null)
      .gte('ts', new Date(tsTransito.getTime() - VENTANA_EMPAREJAR_MS).toISOString())
      .lte('ts', new Date(tsTransito.getTime() + VENTANA_EMPAREJAR_MS).toISOString());
    if (error) throw new Error(`Error buscando pasada: ${error.message}`);
    if (!candidatas || !candidatas.length) { sinPasada++; continue; }

    let mejor = candidatas[0];
    let mejorDiff = Math.abs(new Date(mejor.ts).getTime() - tsTransito.getTime());
    for (const c of candidatas.slice(1)) {
      const diff = Math.abs(new Date(c.ts).getTime() - tsTransito.getTime());
      if (diff < mejorDiff) { mejor = c; mejorDiff = diff; }
    }

    const { error: errUpdate } = await supabase
      .from('porticos_pasadas_reales')
      .update({ monto_agp: Number(t.monto) })
      .eq('id', mejor.id);
    if (errUpdate) throw new Error(`Error actualizando pasada ${mejor.id}: ${errUpdate.message}`);
    actualizadas++;
  }
  console.log(`[agp-transitos] ${actualizadas} actualizadas, ${sinPasada} sin pasada confirmada cercana, ${sinMapear} sin código mapeado.`);
}

async function main() {
  if (!PATENTES_AGP.length) {
    console.log('[agp-transitos] PATENTES_AGP vacío — nada que hacer todavía (ver nota arriba, pendiente instalación FTC).');
    return;
  }
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - AGP_DIAS_ATRAS * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  for (const { patente, ppu } of PATENTES_AGP) {
    const { data: vehiculo, error } = await supabase.from('porticos_vehiculos').select('id').eq('patente', patente).maybeSingle();
    if (error) throw new Error(`Error buscando vehículo ${patente}: ${error.message}`);
    if (!vehiculo) { console.log(`[agp-transitos] ${patente} no está en porticos_vehiculos, se omite.`); continue; }

    console.log(`[agp-transitos] Consultando ${ppu} (${fmt(desde)} a ${fmt(hoy)})...`);
    const resultado = await consultarAGP(ppu, fmt(desde), fmt(hoy));
    console.log(`[agp-transitos] ${resultado.transitos.length} tránsito(s) recibido(s).`);
    await emparejarYActualizar(vehiculo.id, resultado.transitos);
  }
}

main().catch((err) => {
  console.error('ERROR FATAL:', err.message);
  process.exit(1);
});
