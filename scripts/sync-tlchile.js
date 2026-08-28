#!/usr/bin/env node
'use strict';
/**
 * sync-tlchile.js
 *
 * ÚNICO punto de contacto con TrackGTS para la cuenta "amelendez"/"tlchile".
 * Reemplaza a sync-historial-santamarta.js + sync-porticos.js + el cron de
 * /api/sync (Vercel) — los tres autenticaban esta misma cuenta por separado
 * y coincidieron en logins simultáneos, lo que activó el rate-limit de
 * TrackGTS y dejó sin datos a un cliente real (2026-08-27). TrackGTS es una
 * empresa muy cerrada — ya se le pidió reiteradas veces bajar ese límite y
 * no es negociable — así que la solución es de nuestro lado: UNA sola
 * sesión por corrida, y todo lo demás (paneles internos, futuros clientes
 * de pórticos) lee exclusivamente de Supabase, nunca de TrackGTS en vivo.
 *
 * Por corrida:
 *   1) Un solo login clásico (Puppeteer) + una sola llamada a reportTravel
 *      con los unitIds de Santa Marta Y de pórticos juntos → se separan las
 *      filas por unitIdA0 y se guardan en SantaMartaHistorial /
 *      porticos_pasadas_reales (con geocercas + Telegram para pórticos).
 *   2) Authenticate + HealthCheck (API REST, mismo dominio) para los
 *      clientes "tlchile" y "mconnect" → Tracklink / MZDConnect. Antes vivía
 *      en /api/sync (Vercel, cron propio); ahora corre acá para que sea la
 *      MISMA sesión/ventana de rate-limit la que se reserva una sola vez.
 *
 * Variables de entorno esperadas (GitHub Secrets):
 *   TL_USER, TL_PASSWORD, TL_DOMAIN, SUPABASE_SERVICE_ROLE_KEY,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (opcionales, solo para pórticos)
 */

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY');
}
const supabase = createClient(
  'https://lomkolhgmkvshucqjuhf.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Candado / marca de última corrida exitosa -----------------------------
// Ya no hace falta para evitar choques entre procesos (solo queda este), pero
// se mantiene como red de seguridad ante un disparo manual (forzar-sync) que
// coincida con el cron, y "tlchile_last_success" alimenta el panel interno
// de STLC (botón "Sincronizar" ahora es de solo lectura, ver Navbar.tsx).
const TLCHILE_LOCK_KEY = 'tlchile_auth_lock';
const TLCHILE_LOCK_WINDOW_MS = 20 * 60_000;
const TLCHILE_LAST_SUCCESS_KEY = 'tlchile_last_success';

async function intentarReservarTlchile() {
  const { data } = await supabase
    .from('SyncCheckpoints')
    .select('value')
    .eq('key', TLCHILE_LOCK_KEY)
    .maybeSingle();
  const ultimo = data?.value ? new Date(data.value).getTime() : 0;
  if (Date.now() - ultimo < TLCHILE_LOCK_WINDOW_MS) return false;
  await supabase.from('SyncCheckpoints').upsert({ key: TLCHILE_LOCK_KEY, value: new Date().toISOString() });
  return true;
}

// --- Santa Marta -------------------------------------------------------------
const UNIDADES_SANTAMARTA = [
  { unitId: 6702, imei: '868589061400860', alias: 'CATERPILAR 1250 Bulldozer' },
  { unitId: 6567, imei: '868589061200856', alias: 'KOMATSU 1550 Retroexcavadora' },
  { unitId: 6700, imei: '868589061490010', alias: 'MERCEDES-BENZ-4144-HKSX-54' },
  { unitId: 6568, imei: '868589061373570', alias: 'BULLDOZER-KOMTASU-D155-AC' },
  { unitId: 5969, imei: '868589061071729', alias: 'EXCAVADORA-KOMATSU-1401-PC-220' },
];
const SANTAMARTA_CHECKPOINT_KEY = 'santamarta_pull';

// --- Pórticos ------------------------------------------------------------
const PORTICOS_CHECKPOINT_KEY = 'porticos_pull';
const PATENTES_NOTIFICAR_TELEGRAM = ['VVJG-14'];
const RADIO_GEOCERCA_M = 150;
const MIN_GAP_MS = 2 * 60 * 1000;

const PORTICOS = [
  { codigo: 'P3',   concesionaria: 'Costanera Norte',   tramo: 'Puente Lo Saldes – Vivaceta',                lat: -33.4240, lon: -70.6220 },
  { codigo: 'P8',   concesionaria: 'Vespucio Norte',    tramo: 'Ruta 5 Norte – Condell',                     lat: -33.3730, lon: -70.7113 },
  { codigo: 'P11',  concesionaria: 'Vespucio Norte',    tramo: 'Pedro Fontova – Ruta 5 Norte',                lat: -33.3658, lon: -70.6951 },
  { codigo: 'P13',  concesionaria: 'Vespucio Norte',    tramo: 'Recoleta – Pedro Fontova',                    lat: -33.3734, lon: -70.6646 },
  // PA19 — coordenada actualizada 2026-08-28 (la anterior nunca se validó con
  // una pasada real). Nueva coordenada calculada por distancia acumulada real
  // sobre el track GPS de VVJG-14, entre 2.2 y el resto de pórticos de
  // Autopista Central (Eje Gral. Velásquez) — ver PA21/PA23/PA25 abajo.
  { codigo: 'PA19', concesionaria: 'Autopista Central', tramo: 'Ruta 5 Sur – Américo Vespucio',               lat: -33.510753, lon: -70.699381 },
  { codigo: 'PA21', concesionaria: 'Autopista Central', tramo: 'Américo Vespucio – Carlos Valdovinos',        lat: -33.473049, lon: -70.687728 },
  { codigo: 'PA23', concesionaria: 'Autopista Central', tramo: 'Carlos Valdovinos – Alameda',                 lat: -33.438662, lon: -70.691992 },
  { codigo: 'PA25', concesionaria: 'Autopista Central', tramo: 'Alameda – Río Mapocho',                       lat: -33.408249, lon: -70.694405 },
  { codigo: '2.2',  concesionaria: 'Vespucio Sur',      tramo: 'Gral. Velásquez – Ruta 5',                    lat: -33.5263, lon: -70.6941 },
  { codigo: '5.2',  concesionaria: 'Vespucio Sur',      tramo: 'Quilín – Grecia',                             lat: -33.4810, lon: -70.5788 },
  // Vespucio Sur 4.1/3.1/3.3 — agregados 2026-08-28. Coordenadas tomadas del
  // propio track GPS real de VVJG-14 (frenada/parada del vehículo justo en
  // ese punto), confirmadas porque el monto coincide EXACTO con la tarifa
  // oficial investigada (311,52 / 665,24 / 520,53 — ver dashboard.html) y el
  // usuario anotó ese mismo monto en pantalla del pórtico el 2026-08-28.
  { codigo: '4.1',  concesionaria: 'Vespucio Sur',      tramo: 'Gnmo. de Alderete – Santa Julia',            lat: -33.541545, lon: -70.640163 },
  { codigo: '3.1',  concesionaria: 'Vespucio Sur',      tramo: 'Santa Rosa – Gran Avenida',                  lat: -33.538576, lon: -70.658991 },
  { codigo: '3.3',  concesionaria: 'Vespucio Sur',      tramo: 'Gran Avenida – Ruta 5',                      lat: -33.534718, lon: -70.672764 },
  // Ruta 5 Norte — agregados 2026-08-27. Únicos peajes interurbanos con
  // coordenadas confiables encontradas (OpenStreetMap, cruzadas con el km
  // oficial MOP/concesionaria) — el resto del catálogo nacional (Tarifas)
  // no tiene coordenadas publicadas y queda solo de referencia.
  { codigo: 'LAMPA',        concesionaria: 'Ruta 5 Norte (Aconcagua)', tramo: 'Km 26, Lampa',                lat: -33.2356, lon: -70.7589 },
  { codigo: 'LASVEGAS',     concesionaria: 'Ruta 5 Norte (Aconcagua)', tramo: 'Km 89, Llay-Llay',             lat: -32.8433, lon: -70.9893 },
  { codigo: 'PICHIDANGUI',  concesionaria: 'Ruta 5 Norte (Aconcagua)', tramo: 'Km 163, La Ligua',             lat: -32.1750, lon: -71.5207 },
  { codigo: 'TRONCALSUR',   concesionaria: 'Ruta 5 Norte (Ruta del Elqui)', tramo: 'Km 283, Canela (Troncal Sur)', lat: -31.4200, lon: -71.5704 },
  { codigo: 'TONGOY',       concesionaria: 'Ruta 5 Norte (Ruta del Elqui)', tramo: 'Acceso sur Tongoy (Lateral)',  lat: -30.3517, lon: -71.4323 },
  { codigo: 'GUANAQUEROS',  concesionaria: 'Ruta 5 Norte (Ruta del Elqui)', tramo: 'Guanaqueros (Lateral)',        lat: -30.1974, lon: -71.3880 },
  { codigo: 'PTACOLORADA',  concesionaria: 'Ruta 5 Norte (Ruta del Algarrobo)', tramo: 'Km 554, La Higuera (Punta Colorada)', lat: -29.3710, lon: -71.0732 },
  { codigo: 'TOTORAL',      concesionaria: 'Ruta 5 Norte (Valles del Desierto)', tramo: 'Km 732, norte de Vallenar (Totoral)', lat: -27.9971, lon: -70.5658 },
  { codigo: 'PTOVIEJO',     concesionaria: 'Ruta 5 Norte (Valles del Desierto)', tramo: 'Km 841, norte de Copiapó (Puerto Viejo)', lat: -27.3482, lon: -70.6364 },
];

// Algunos pares de pórticos de Vespucio Sur comparten prácticamente la
// misma posición física (las dos calzadas — ida y vuelta — quedan lo
// bastante cerca como para caer en el mismo radio de 150m), pero el código
// y la tarifa oficial correcta dependen del sentido de viaje. Confirmado en
// vivo el 2026-08-28 con el track GPS real de VVJG-14: mismo punto exacto,
// "4.1" a la ida (longitud GPS decreciente, viajando hacia el poniente) y
// "4.3" a la vuelta (longitud creciente, hacia el oriente) — mismo patrón
// para 3.1↔3.4 y 3.3↔3.2. El monto anotado en pantalla por el usuario en
// ambos viajes coincidió exacto con la tarifa oficial de cada código.
const PARES_DIRECCIONALES_VESPUCIO_SUR = {
  '4.1': { alterno: '4.3', tramoAlterno: 'Coronel – Santa Julia' },
  '3.1': { alterno: '3.4', tramoAlterno: 'Ruta 5 – Gran Avenida' },
  '3.3': { alterno: '3.2', tramoAlterno: 'Gran Avenida – Santa Rosa' },
};

// anterior/actual son los dos puntos GPS consecutivos que generaron la
// detección — si no hay "anterior" (primer punto de la corrida) se asume
// el código base por defecto, no se puede determinar sentido.
function resolverCodigoDireccional(portico, anterior, actual) {
  const par = PARES_DIRECCIONALES_VESPUCIO_SUR[portico.codigo];
  if (!par || !anterior) return { codigo: portico.codigo, tramo: portico.tramo };
  const tendencia = actual.lon - anterior.lon; // positivo = longitud creciente = hacia el oriente
  if (tendencia > 0) return { codigo: par.alterno, tramo: par.tramoAlterno };
  return { codigo: portico.codigo, tramo: portico.tramo };
}

const TARIFAS = {
  // P3/2.2/5.2 actualizados 2026-08-27 al tarifario 2026 vigente (ver dashboard.html
  // para la fuente/detalle). P8/P11/P13/PA19 quedan sin cambios — la última
  // investigación de Vespucio Norte devolvió cifras contradictorias.
  P3:   { TBFP: 719, TBP: 1384, TS: 2097 },
  P8:   { TBFP: 631, TBP: 1263, TS: 1263 },
  P11:  { TBFP: 291, TBP: 583,  TS: 874  },
  P13:  { TBFP: 398, TBP: 797,  TS: 797  },
  // PA19/21/23/25 actualizados 2026-08-28 con el tarifario oficial 2026 de
  // autopistacentral.cl (texto limpio, no imagen — alta confianza). PA19 y
  // PA21 son tarifa plana (sin banda horaria definida). PA23/PA25 sí tienen
  // banda punta (07:00-10:00 y 07:00-09:30/14:30-15:00/19:00-19:30
  // respectivamente) — el monto TBP coincidió exacto con lo que el usuario
  // anotó en pantalla (576 y 844) el mismo día en ese horario.
  PA19: { TBFP: 413, TBP: 413,  TS: 413  },
  PA21: { TBFP: 512, TBP: 512,  TS: 512  },
  PA23: { TBFP: 288, TBP: 576,  TS: 576  },
  PA25: { TBFP: 422, TBP: 844,  TS: 844  },
  '2.2':{ TBFP: 251, TBP: 502,  TS: 754  },
  '5.2':{ TBFP: 290, TBP: 581,  TS: 871  },
  '4.1':{ TBFP: 312, TBP: 623,  TS: 623  },
  '3.1':{ TBFP: 333, TBP: 665,  TS: 998  },
  '3.3':{ TBFP: 260, TBP: 521,  TS: 781  },
  // Códigos "alternos" (sentido contrario) de 4.1/3.1/3.3 — ver
  // PARES_DIRECCIONALES_VESPUCIO_SUR. Confirmados 2026-08-28 con el monto
  // real anotado por el usuario al volver por el mismo tramo.
  '4.3':{ TBFP: 45,  TBP: 90,   TS: 136  },
  '3.4':{ TBFP: 121, TBP: 241,  TS: 362  },
  '3.2':{ TBFP: 472, TBP: 945,  TS: 1417 },
  // Ruta 5 Norte — tarifas planas (sin banda horaria oficial), mismo monto
  // en las 3 columnas para que el cálculo de banda no cambie el resultado.
  LAMPA:       { TBFP: 900,  TBP: 900,  TS: 900  },
  LASVEGAS:    { TBFP: 2900, TBP: 2900, TS: 2900 },
  PICHIDANGUI: { TBFP: 2900, TBP: 2900, TS: 2900 },
  TRONCALSUR:  { TBFP: 4250, TBP: 4250, TS: 4250 },
  TONGOY:      { TBFP: 1100, TBP: 1100, TS: 1100 },
  GUANAQUEROS: { TBFP: 1100, TBP: 1100, TS: 1100 },
  PTACOLORADA: { TBFP: 3150, TBP: 3150, TS: 3150 },
  TOTORAL:     { TBFP: 2900, TBP: 2900, TS: 2900 },
  PTOVIEJO:    { TBFP: 1750, TBP: 1750, TS: 1750 },
};

// --- HealthCheck (Tracklink / MZDConnect) -----------------------------------
const HEALTHCHECK_CUSTOMERS = [
  { customer: 'tlchile',  tabla: 'Tracklink' },
  { customer: 'mconnect', tabla: 'MZDConnect' },
];

async function notificarTelegram(texto) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID no configurados, se omite notificación.');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto, parse_mode: 'HTML' }),
  });
  if (!res.ok) console.log(`[telegram] Error enviando mensaje: HTTP ${res.status} ${await res.text()}`);
}

function fmtFechaHoraChile(iso) {
  const d = new Date(new Date(iso).getTime() - 4 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function clp(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

function fmtTL(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Postgres no permite que un mismo upsert() incluya dos filas que apunten
// al mismo conflicto cuando se resuelve con DO UPDATE (a diferencia de
// ignoreDuplicates/DO NOTHING) — revienta con "ON CONFLICT DO UPDATE command
// cannot affect row a second time". reportTravel puede devolver más de un
// punto con el mismo (IMEI, gpsUtcTime) dentro de una misma consulta, así
// que hay que des-duplicar el lote ANTES de cada upsert (se queda con la
// última ocurrencia, que trae los datos más frescos).
function dedupePorClave(filas, claveDe) {
  const porClave = new Map();
  for (const f of filas) porClave.set(claveDe(f), f);
  return Array.from(porClave.values());
}

function haversineMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Distancia mínima entre un punto (el pórtico) y el TRAMO RECTO entre dos
// lecturas GPS consecutivas — no solo la distancia a cada lectura suelta.
// Con GPS que reporta cada 30-60+ segundos, un auto a velocidad de autopista
// puede cruzar un círculo de 150m ENTRE dos lecturas sin que ninguna caiga
// adentro; revisando el tramo se detecta igual. Aproximación plana (válida
// para segmentos de unos pocos km, muy por sobre la distancia real entre
// dos puntos GPS consecutivos de un mismo vehículo).
function distanciaPuntoASegmentoMetros(latP, lonP, latA, lonA, latB, lonB) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
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
  return Math.hypot(cx, cy);
}

// HEURÍSTICA de banda horaria (no es la ventana oficial exacta de cada concesionaria).
function bandaHeuristica(fecha) {
  const dow = fecha.getDay();
  const h = fecha.getHours();
  if (dow === 0 || dow === 6) return 'TBFP';
  if ((h >= 7 && h < 9) || (h >= 18 && h < 21)) return 'TBP';
  return 'TBFP';
}

async function obtenerCheckpoint(key, lookbackMs) {
  const { data, error } = await supabase.from('SyncCheckpoints').select('value').eq('key', key).maybeSingle();
  if (error) throw new Error(`Error leyendo checkpoint ${key}: ${error.message}`);
  if (data?.value) return new Date(data.value);
  return new Date(Date.now() - lookbackMs);
}

async function guardarCheckpoint(key, fecha) {
  const { error } = await supabase.from('SyncCheckpoints').upsert({ key, value: fecha.toISOString() });
  if (error) throw new Error(`Error guardando checkpoint ${key}: ${error.message}`);
}

async function obtenerVehiculosPorticos() {
  const { data, error } = await supabase.from('porticos_vehiculos').select('id, patente, unit_id, imei, empresa');
  if (error) throw new Error(`Error leyendo vehiculos: ${error.message}`);
  return data || [];
}

// El alias del vehículo en Tracklink puede cambiar (ej. "DEMOGV58LAU" ->
// "ALMELENDEZ", mismo IMEI/patente) — se refleja solo en el portal de
// pórticos en vez de quedar pegado al valor que tenía al agregarlo.
async function sincronizarAliasVehiculos(vehiculosPorticos) {
  const imeis = vehiculosPorticos.map((v) => v.imei).filter(Boolean);
  if (!imeis.length) return;
  const { data: filasTracklink, error } = await supabase
    .from('Tracklink')
    .select('"IMEI", "Alias"')
    .in('IMEI', imeis);
  if (error) { console.log(`[alias] Error leyendo Tracklink: ${error.message}`); return; }
  const aliasPorImei = new Map((filasTracklink || []).map((f) => [f['IMEI'], f['Alias']]));

  for (const v of vehiculosPorticos) {
    const aliasNuevo = aliasPorImei.get(v.imei);
    if (aliasNuevo && aliasNuevo !== v.empresa) {
      const { error: errUpdate } = await supabase
        .from('porticos_vehiculos')
        .update({ empresa: aliasNuevo })
        .eq('id', v.id);
      if (errUpdate) console.log(`[alias] Error actualizando ${v.patente}: ${errUpdate.message}`);
      else console.log(`[alias] ${v.patente}: "${v.empresa}" → "${aliasNuevo}"`);
    }
  }
}

async function loginYConsultarTravel({ TL_USER, TL_PASSWORD, TL_DOMAIN, startDate, endDate, unitIds }) {
  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 90_000;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      const loginUrl = `https://${TL_DOMAIN}.trackgts.com/admin/login.html`;
      console.log(`[login] Intento ${attempt}/${MAX_ATTEMPTS} — ${loginUrl}`);
      await page.goto(loginUrl, { waitUntil: 'networkidle0', timeout: 60_000 });
      await page.waitForSelector('#username', { timeout: 30_000 });

      await page.evaluate(() => localStorage.setItem('sltLanguage', '0'));
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('#username', { timeout: 30_000 });

      await page.evaluate((user, password, domain) => {
        const K = 'd5fg4df5sg4ds5fg';
        const S = { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6', g: '7', h: '8', i: '9' };
        const k = CryptoJS.enc.Utf8.parse(K);
        const iv = CryptoJS.enc.Utf8.parse(K);
        const a = [];
        for (const c of password) {
          a.push(
            CryptoJS.AES.encrypt(
              CryptoJS.enc.Utf8.parse(S[c] || c), k,
              { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
            ).toString()
          );
        }
        ARRAYPSWD = a;
        document.getElementById('username').value = user;
        document.getElementById('domain').value = domain;
        document.getElementById('password').value = '********';
        LOGININPROCESS = false;
        onLoginOn();
      }, TL_USER, TL_PASSWORD, TL_DOMAIN);

      console.log('[login] Esperando sesión (15s)...');
      await new Promise((r) => setTimeout(r, 15_000));

      console.log(`[travel] Consultando reportTravel: ${startDate} → ${endDate}`);
      const result = await page.evaluate(async (startStr, endStr, unitIdsStr) => {
        const h = JSONUSER.hash;
        const res = await fetch(`https://www.trackgts.com:82/api/reportTravel/${h}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json;charset=utf-8' },
          body: JSON.stringify([{ startDate: startStr, endDate: endStr, unitIds: unitIdsStr }]),
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch (e) {
          return { error: `Respuesta no-JSON: ${text.slice(0, 300)}` };
        }
        if (typeof json === 'string') {
          try { json = JSON.parse(json); } catch (e) {
            return { error: `Doble-parse falló: ${text.slice(0, 300)}` };
          }
        }
        if (json && json.idResult !== undefined) {
          return { error: `idResult=${json.idResult} (sesión inválida)` };
        }
        if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[1])) {
          return { error: `Forma inesperada: ${JSON.stringify(json).slice(0, 300)}` };
        }
        return { rows: json[1] };
      }, startDate, endDate, unitIds);

      if (result.error) throw new Error(result.error);
      return result.rows || [];
    } catch (err) {
      lastError = err;
      console.log(`[!] Intento ${attempt}/${MAX_ATTEMPTS} falló: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`[!] Esperando ${Math.round(RETRY_DELAY_MS / 1000)}s antes de reintentar...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    } finally {
      await browser.close();
    }
  }
  throw lastError;
}

async function sincronizarHealthCheck(TL_USER, TL_PASSWORD, TL_DOMAIN, customer, tabla) {
  const BASE_URL = `https://${TL_DOMAIN}.trackgts.com:8081`;
  const authRes = await fetch(`${BASE_URL}/api/Authenticate/Auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: TL_USER, password: TL_PASSWORD, customer }),
  });
  if (authRes.status === 429) {
    console.log(`[healthcheck:${tabla}] ⚠️ Rate limit al autenticar.`);
    return;
  }
  if (!authRes.ok) {
    console.log(`[healthcheck:${tabla}] ❌ Error de autenticación: HTTP ${authRes.status}`);
    return;
  }
  const authData = await authRes.json();
  const accessToken = authData.data?.accessToken;
  const retailId = authData.data?.user?.parentCustomerId?.toString();
  if (!accessToken || !retailId) {
    console.log(`[healthcheck:${tabla}] ❌ No se obtuvo token o retailId.`);
    return;
  }

  const reportRes = await fetch(`${BASE_URL}/api/HealthCheck/GetReportHealthCheck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ retailId }),
  });
  if (reportRes.status === 429) {
    console.log(`[healthcheck:${tabla}] ⚠️ Rate limit al obtener reporte.`);
    return;
  }
  if (!reportRes.ok) {
    console.log(`[healthcheck:${tabla}] ❌ Error al obtener reporte: HTTP ${reportRes.status}`);
    return;
  }
  const reportData = await reportRes.json();
  const unidades = reportData.data ?? [];
  if (!unidades.length) {
    console.log(`[healthcheck:${tabla}] ❌ La API no devolvió unidades.`);
    return;
  }

  const registros = unidades.map((u) => ({
    'IMEI':                 u.imei,
    'Unit ID':              u.unitId,
    'Serie':                u.serie,
    'Fecha Ultimo Reporte': u.fechaUltimoReporte,
    'Ubicación':            u.ubicacion,
    'Antigüedad (minutos)': u.antiguedadMinutos,
    'Mensaje':              u.mensaje,
    'EstadoGPS':            u.estadoGPS,
    'EstadoIgnición':       u.estadoIgnicion,
    'EstadoMotor':          u.estadoMotor,
    'Velocidad':            String(u.velocidad ?? ''),
    'Odómetro':             String(u.odometro ?? ''),
    'Horómetro':            u.horometro ?? null,
    'VBatExterna':          String(u.vBatExterna ?? ''),
    '%BatExterna':          u.porcentBatInterna,
    'Fabricante AVL':       u.fabricanteAVL,
    'Modelo AVL':           u.modeloAVL,
    'Modelo AVL Ref':       u.modeloAVLRef,
    'Protocolo':            u.protocolo,
    'Teléfono SIM':         u.telefonoSim,
    'Serie SIM':            u.serieSim,
    'GPRS':                 u.gprs,
    'Servicio':             u.servicio,
    'Servicio Comercial':   u.servicioComercial,
    'Serv. Desde':          u.servDesde,
    'Serv. Hasta':          u.servHasta,
    'TipoInstalacion':      u.tipoInstalacion,
    'Alias':                u.alias,
    'Tipo':                 u.tipo,
    'Marca':                u.marca,
    'Modelo':               u.modelo,
    'Año':                  u.anio,
    'Placa':                u.placa,
    'Color':                u.color,
    'Chasis':               u.chasis,
    'Motor':                u.motor,
    'Cliente/Empresa':      u.clienteEmpresa,
    'Cust ID':              u.custId,
    'Nombre':               u.nombre,
    'Apellido':             u.apellido,
    'Direccion':            u.direccion,
    'Pais':                 u.pais,
    'Correo':               u.correo,
    'Usuario':              u.usuario,
    'Telefono':             u.telefono,
    'ClienteAdicional1':    u.clienteAdicional1 ?? '',
    'ClienteAdicional2':    u.clienteAdicional2 ?? '',
    'ClienteAdicional3':    u.clienteAdicional3 ?? '',
    'ClienteAdicional4':    u.clienteAdicional4 ?? '',
  }));

  const { error } = await supabase.from(tabla).upsert(registros, { onConflict: 'IMEI' });
  if (error) {
    console.log(`[healthcheck:${tabla}] ❌ Error al guardar: ${error.message}`);
    return;
  }
  console.log(`[healthcheck:${tabla}] ✅ ${unidades.length} unidades sincronizadas.`);
}

async function main() {
  const { TL_USER, TL_PASSWORD, TL_DOMAIN } = process.env;
  if (!TL_USER || !TL_PASSWORD || !TL_DOMAIN) throw new Error('Faltan TL_USER, TL_PASSWORD o TL_DOMAIN');

  const tlchileDisponible = await intentarReservarTlchile();
  if (!tlchileDisponible) {
    console.log('⏭️  Omitido: la cuenta tlchile fue usada hace menos de 20 min (candado activo).');
    return;
  }

  // --- 1) Una sola sesión clásica: Santa Marta + Pórticos juntos -----------
  const vehiculosPorticos = await obtenerVehiculosPorticos();
  const santamartaCheckpoint = await obtenerCheckpoint(SANTAMARTA_CHECKPOINT_KEY, 2 * 60 * 60_000);
  const porticosCheckpoint = await obtenerCheckpoint(PORTICOS_CHECKPOINT_KEY, 2 * 60 * 60_000);
  const OVERLAP_MS = 5 * 60_000;
  const ahora = new Date();
  const startMs = Math.min(santamartaCheckpoint.getTime(), porticosCheckpoint.getTime()) - OVERLAP_MS;
  const start = new Date(startMs);

  const unitIds = [
    ...UNIDADES_SANTAMARTA.map((u) => u.unitId),
    ...vehiculosPorticos.map((v) => v.unit_id),
  ].join(',');

  console.log(`=== Sync tlchile: ${fmtTL(start)} → ${fmtTL(ahora)} (${UNIDADES_SANTAMARTA.length} Santa Marta + ${vehiculosPorticos.length} pórticos) ===`);

  const rows = await loginYConsultarTravel({
    TL_USER, TL_PASSWORD, TL_DOMAIN,
    startDate: fmtTL(start), endDate: fmtTL(ahora),
    unitIds,
  });
  console.log(`[travel] ${rows.length} posiciones GPS recibidas (todas las unidades)`);

  // --- Santa Marta -----------------------------------------------------------
  const porUnitIdSantaMarta = new Map(UNIDADES_SANTAMARTA.map((u) => [u.unitId, u]));
  const registrosSantaMarta = rows
    .filter((r) => porUnitIdSantaMarta.has(r.unitIdA0))
    .map((r) => {
      const u = porUnitIdSantaMarta.get(r.unitIdA0);
      return {
        'IMEI': u.imei,
        'Unit ID': r.unitIdA0,
        'Alias': u.alias,
        'gpsUtcTime': r.gpsUtcTimeC13,
        'Odómetro': r.odometerC14 ?? null,
        'Horómetro': r.hourmeterC15 ?? null,
        'Velocidad': r.speedC8 ?? null,
        'Latitud': r.latC12 ?? null,
        'Longitud': r.lonC11 ?? null,
      };
    });
  console.log(`[santamarta] ${registrosSantaMarta.length} filas válidas`);
  if (registrosSantaMarta.length) {
    const registrosSantaMartaSinDuplicar = dedupePorClave(registrosSantaMarta, (r) => `${r['IMEI']}|${r['gpsUtcTime']}`);
    const { error } = await supabase
      .from('SantaMartaHistorial')
      // ignoreDuplicates:false (default) = ON CONFLICT DO UPDATE: si una fila ya
      // existía con algún campo vacío (por una corrida anterior incompleta o con
      // código viejo), esta corrida la corrige sola en vez de dejarla pegada.
      .upsert(registrosSantaMartaSinDuplicar, { onConflict: 'IMEI,gpsUtcTime' });
    if (error) throw new Error(`Error al guardar historial Santa Marta: ${error.message}`);
    console.log(`[santamarta] ✅ ${registrosSantaMartaSinDuplicar.length} registros insertados/verificados.`);
  }
  await guardarCheckpoint(SANTAMARTA_CHECKPOINT_KEY, ahora);

  // --- Pórticos --------------------------------------------------------------
  const porUnitIdPorticos = new Map(vehiculosPorticos.map((v) => [v.unit_id, v]));
  const puntosPorVehiculo = new Map();
  for (const r of rows) {
    const vehiculo = porUnitIdPorticos.get(r.unitIdA0);
    if (!vehiculo) continue;
    if (!puntosPorVehiculo.has(vehiculo.id)) puntosPorVehiculo.set(vehiculo.id, []);
    puntosPorVehiculo.get(vehiculo.id).push({
      time: new Date(r.gpsUtcTimeC13.replace(' ', 'T') + 'Z'),
      lat: r.latC12, lon: r.lonC11, speed: r.speedC8 || 0,
    });
  }

  // Si el vehículo queda estacionado/detenido cerca de un pórtico (ej. su
  // destino final queda al lado), cada corrida futura volvía a "detectar"
  // el mismo pórtico una y otra vez (el dedup de MIN_GAP_MS solo mira dentro
  // de la corrida actual, no recuerda corridas anteriores) — generaba
  // pasadas y notificaciones de Telegram falsas mientras el auto seguía
  // parado ahí. Por eso antes de detectar se consulta cuándo fue la ÚLTIMA
  // pasada real ya guardada de cada vehículo+pórtico, y no se vuelve a
  // contar si pasaron menos de VENTANA_MISMA_PASADA_MS desde esa última vez.
  const VENTANA_MISMA_PASADA_MS = 3 * 60 * 60 * 1000; // 3 horas

  let totalDetecciones = 0;
  for (const vehiculo of vehiculosPorticos) {
    const puntos = (puntosPorVehiculo.get(vehiculo.id) || [])
      .filter((p) => p.lat && p.lon && !isNaN(p.time))
      .sort((a, b) => a.time - b.time);
    console.log(`[porticos] ${vehiculo.patente}: ${puntos.length} puntos GPS válidos`);

    const { data: pasadasPrevias, error: errPrevias } = await supabase
      .from('porticos_pasadas_reales')
      .select('portico_codigo, ts')
      .eq('vehiculo_id', vehiculo.id)
      .gte('ts', new Date(Date.now() - VENTANA_MISMA_PASADA_MS).toISOString());
    if (errPrevias) throw new Error(`Error leyendo pasadas previas de ${vehiculo.patente}: ${errPrevias.message}`);
    const ultimaPasadaPorPortico = new Map();
    for (const row of pasadasPrevias || []) {
      const t = new Date(row.ts).getTime();
      const actual = ultimaPasadaPorPortico.get(row.portico_codigo);
      if (!actual || t > actual) ultimaPasadaPorPortico.set(row.portico_codigo, t);
    }

    const detecciones = [];
    let ultimoPortico = null;
    let ultimoTs = null;
    for (let i = 0; i < puntos.length; i++) {
      const p = puntos[i];
      const anterior = puntos[i - 1];
      for (const portico of PORTICOS) {
        const d = anterior
          ? distanciaPuntoASegmentoMetros(portico.lat, portico.lon, anterior.lat, anterior.lon, p.lat, p.lon)
          : haversineMetros(p.lat, p.lon, portico.lat, portico.lon);
        if (d <= RADIO_GEOCERCA_M) {
          const tsMs = p.time.getTime();
          const resuelto = resolverCodigoDireccional(portico, anterior, p);
          const esNuevoEnEstaCorrida = resuelto.codigo !== ultimoPortico || !ultimoTs || tsMs - ultimoTs > MIN_GAP_MS;
          const ultimaConocida = ultimaPasadaPorPortico.get(resuelto.codigo);
          const esNuevoVsHistorico = !ultimaConocida || tsMs - ultimaConocida > VENTANA_MISMA_PASADA_MS;
          if (esNuevoEnEstaCorrida && esNuevoVsHistorico) {
            detecciones.push({
              vehiculo_id: vehiculo.id,
              ts: p.time.toISOString(),
              portico_codigo: resuelto.codigo,
              concesionaria: portico.concesionaria,
              tramo: resuelto.tramo,
              distancia_m: Math.round(d),
              velocidad_kmh: p.speed,
              lat: p.lat,
              lon: p.lon,
            });
            ultimaPasadaPorPortico.set(resuelto.codigo, tsMs);
          }
          ultimoPortico = resuelto.codigo;
          ultimoTs = tsMs;
        }
      }
    }
    // Dedupe defensivo por si el mismo punto GPS (mismo ts) aparece dos veces
    // en la respuesta de reportTravel — evita el mismo error de Postgres que
    // rompía Santa Marta, y de paso evita notificar dos veces por Telegram.
    const deteccionesSinDuplicar = dedupePorClave(detecciones, (d) => `${d.vehiculo_id}|${d.ts}|${d.portico_codigo}`);
    console.log(`[porticos] ${vehiculo.patente}: ${deteccionesSinDuplicar.length} pasadas nuevas detectadas`);
    totalDetecciones += deteccionesSinDuplicar.length;

    if (deteccionesSinDuplicar.length) {
      const { error } = await supabase
        .from('porticos_pasadas_reales')
        // ignoreDuplicates:false (default) = ON CONFLICT DO UPDATE: si esta misma
        // pasada ya estaba guardada (por el solape de 5 min entre corridas, o por
        // haberse insertado con una versión anterior del código) pero le faltaba
        // lat/lon u otro campo, esta corrida la completa sola — sin depender de
        // un rescate manual ni de un login extra a TrackGTS.
        .upsert(deteccionesSinDuplicar, { onConflict: 'vehiculo_id,ts,portico_codigo' });
      if (error) throw new Error(`Error guardando pasadas de ${vehiculo.patente}: ${error.message}`);
      console.log(`[porticos] ✅ ${vehiculo.patente}: ${deteccionesSinDuplicar.length} pasadas insertadas/verificadas`);

      if (!PATENTES_NOTIFICAR_TELEGRAM.includes(vehiculo.patente)) continue;
      for (const d of deteccionesSinDuplicar) {
        const banda = bandaHeuristica(new Date(new Date(d.ts).getTime() - 4 * 3600 * 1000));
        const monto = TARIFAS[d.portico_codigo][banda];
        const texto =
          `🚗 <b>${vehiculo.patente}</b> — pasada por pórtico\n` +
          `📅 ${fmtFechaHoraChile(d.ts)}\n` +
          `🛣️ Pórtico: ${d.portico_codigo} (${d.concesionaria})\n` +
          `✅ Estado: OK\n` +
          `💰 Facturado: ${clp(monto)}\n` +
          `💰 Correcto: ${clp(monto)}`;
        await notificarTelegram(texto);
      }
    }
  }
  if (!totalDetecciones) console.log('[porticos] Sin pasadas nuevas en el rango consultado.');
  await guardarCheckpoint(PORTICOS_CHECKPOINT_KEY, ahora);

  // --- 2) HealthCheck (API REST) — Tracklink / MZDConnect ---------------------
  // TrackGTS rate-limitó el segundo Authenticate/Auth (mconnect) incluso
  // llamado segundos después del primero (tlchile) dentro de esta MISMA
  // corrida (visto en vivo 2026-08-27) — el límite no es solo "entre
  // procesos", también pega entre llamadas seguidas de la misma corrida.
  // Por eso van con una pausa entre medio en vez de una tras otra.
  const HEALTHCHECK_GAP_MS = 60_000;
  for (let i = 0; i < HEALTHCHECK_CUSTOMERS.length; i++) {
    const { customer, tabla } = HEALTHCHECK_CUSTOMERS[i];
    if (i > 0) {
      console.log(`[healthcheck] Esperando ${HEALTHCHECK_GAP_MS / 1000}s antes de autenticar "${customer}"...`);
      await new Promise((r) => setTimeout(r, HEALTHCHECK_GAP_MS));
    }
    await sincronizarHealthCheck(TL_USER, TL_PASSWORD, TL_DOMAIN, customer, tabla);
  }

  await sincronizarAliasVehiculos(vehiculosPorticos);

  await guardarCheckpoint(TLCHILE_LAST_SUCCESS_KEY, ahora);
  console.log(`=== Sync tlchile completo: ${ahora.toISOString()} ===`);
}

main().catch((err) => {
  console.error('ERROR FATAL:', err.message);
  process.exit(1);
});
