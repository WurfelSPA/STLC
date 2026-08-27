#!/usr/bin/env node
'use strict';
/**
 * sync-porticos.js
 *
 * Sync periódico de pasadas por pórtico para TODOS los vehículos registrados
 * en porticos_vehiculos, de cualquier cliente/cuenta (hoy: KCERDA/DFFD-69 y el
 * vehículo propio de Alex/VVJG-14 — pensado para seguir creciendo a más
 * cuentas). Una sola sesión de login + una sola llamada a reportTravel con
 * todos los unitIds juntos (mismo patrón que usa el sync de Santa Marta con
 * sus 5 unidades), luego se separan las filas por unitIdA0.
 *
 * Igual patrón que sync-historial-santamarta.js: pide a reportTravel "todo
 * desde la última corrida exitosa" (con solape de 5 min), corre el motor de
 * geocercas (Haversine) contra los pórticos reales, calcula banda horaria
 * (heurística — ver nota abajo) y monto con el tarifario real, y hace upsert
 * en Supabase (porticos_pasadas_reales), sin duplicar gracias al constraint
 * único (vehiculo_id, ts, portico_codigo).
 *
 * No puede correr en Vercel (necesita Puppeteer/login real de TrackGTS) —
 * por eso vive en GitHub Actions, igual que el de Santa Marta.
 *
 * Variables de entorno esperadas (GitHub Secrets): TL_USER, TL_PASSWORD, TL_DOMAIN
 */

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

// Las tablas porticos_vehiculos / porticos_pasadas_reales tienen RLS sin
// policies para anon — a diferencia de SantaMartaHistorial/SyncCheckpoints,
// este script necesita la service_role key (misma que usa el portal en Vercel).
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY');
}
const supabase = createClient(
  'https://lomkolhgmkvshucqjuhf.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CHECKPOINT_KEY = 'porticos_pull';
// Solo se notifica por Telegram el vehículo propio de Alex, no las pruebas de otros clientes.
const PATENTES_NOTIFICAR_TELEGRAM = ['VVJG-14'];
const OVERLAP_MS = 5 * 60_000;
const LOOKBACK_DEFAULT_MS = 2 * 60 * 60_000;
const RADIO_GEOCERCA_M = 150;
const MIN_GAP_MS = 2 * 60 * 1000;

// Pórticos reales con coordenadas (subset de porticos-reales.json — AVO queda fuera, sin coords confirmadas)
const PORTICOS = [
  { codigo: 'P3',   concesionaria: 'Costanera Norte',   tramo: 'Puente Lo Saldes – Vivaceta',                lat: -33.4240, lon: -70.6220 },
  { codigo: 'P8',   concesionaria: 'Vespucio Norte',    tramo: 'Ruta 5 Norte – Condell',                     lat: -33.3730, lon: -70.7113 },
  { codigo: 'P11',  concesionaria: 'Vespucio Norte',    tramo: 'Pedro Fontova – Ruta 5 Norte',                lat: -33.3658, lon: -70.6951 },
  { codigo: 'P13',  concesionaria: 'Vespucio Norte',    tramo: 'Recoleta – Pedro Fontova',                    lat: -33.3734, lon: -70.6646 },
  { codigo: 'PA19', concesionaria: 'Autopista Central', tramo: 'Eje Gral. Velásquez: Ruta 5 Sur – Am. Vespucio', lat: -33.5514, lon: -70.7091 },
  { codigo: '2.2',  concesionaria: 'Vespucio Sur',      tramo: 'Gral. Velásquez – Ruta 5',                    lat: -33.5263, lon: -70.6941 },
  { codigo: '5.2',  concesionaria: 'Vespucio Sur',      tramo: 'Quilín – Grecia',                             lat: -33.4810, lon: -70.5788 },
];

const TARIFAS = {
  P3:   { TBFP: 692, TBP: 1337, TS: 2029 },
  P8:   { TBFP: 631, TBP: 1263, TS: 1263 },
  P11:  { TBFP: 291, TBP: 583,  TS: 874  },
  P13:  { TBFP: 398, TBP: 797,  TS: 797  },
  PA19: { TBFP: 365, TBP: 731,  TS: 731  },
  '2.2':{ TBFP: 243, TBP: 486,  TS: 486  },
  '5.2':{ TBFP: 281, TBP: 562,  TS: 842  },
};

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
  const d = new Date(new Date(iso).getTime() - 4 * 3600 * 1000); // aproximación UTC-4
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

function haversineMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// HEURÍSTICA de banda horaria (no es la ventana oficial exacta de cada concesionaria —
// pendiente investigar el detalle real por pórtico). L-V 07-09h y 18-21h = punta.
function bandaHeuristica(fecha) {
  const dow = fecha.getDay();
  const h = fecha.getHours();
  if (dow === 0 || dow === 6) return 'TBFP';
  if ((h >= 7 && h < 9) || (h >= 18 && h < 21)) return 'TBP';
  return 'TBFP';
}

async function obtenerCheckpoint() {
  const { data, error } = await supabase.from('SyncCheckpoints').select('value').eq('key', CHECKPOINT_KEY).maybeSingle();
  if (error) throw new Error(`Error leyendo checkpoint: ${error.message}`);
  if (data?.value) return new Date(data.value);
  return new Date(Date.now() - LOOKBACK_DEFAULT_MS);
}

async function guardarCheckpoint(fecha) {
  const { error } = await supabase.from('SyncCheckpoints').upsert({ key: CHECKPOINT_KEY, value: fecha.toISOString() });
  if (error) throw new Error(`Error guardando checkpoint: ${error.message}`);
}

async function obtenerVehiculos() {
  const { data, error } = await supabase.from('porticos_vehiculos').select('id, patente, unit_id');
  if (error) throw new Error(`Error leyendo vehiculos: ${error.message}`);
  if (!data || !data.length) throw new Error('No hay vehiculos registrados en porticos_vehiculos');
  return data;
}

async function loginYConsultarTravel({ TL_USER, TL_PASSWORD, TL_DOMAIN, startDate, endDate, unitIds }) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    await page.goto(`https://${TL_DOMAIN}.trackgts.com/admin/login.html`, { waitUntil: 'networkidle0', timeout: 60_000 });
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
        a.push(CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(S[c] || c), k, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString());
      }
      ARRAYPSWD = a;
      document.getElementById('username').value = user;
      document.getElementById('domain').value = domain;
      document.getElementById('password').value = '********';
      LOGININPROCESS = false;
      onLoginOn();
    }, TL_USER, TL_PASSWORD, TL_DOMAIN);

    await new Promise((r) => setTimeout(r, 15_000));

    const result = await page.evaluate(async (startStr, endStr, unitIdStr) => {
      const h = JSONUSER.hash;
      const res = await fetch(`https://www.trackgts.com:82/api/reportTravel/${h}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=utf-8' },
        body: JSON.stringify([{ startDate: startStr, endDate: endStr, unitIds: unitIdStr }]),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { return { error: `Respuesta no-JSON: ${text.slice(0, 300)}` }; }
      if (typeof json === 'string') {
        try { json = JSON.parse(json); } catch (e) { return { error: `Doble-parse falló: ${text.slice(0, 300)}` }; }
      }
      if (json && json.idResult !== undefined) return { error: `idResult=${json.idResult} (sesión inválida)` };
      if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[1])) {
        return { error: `Forma inesperada: ${JSON.stringify(json).slice(0, 300)}` };
      }
      return { rows: json[1] };
    }, startDate, endDate, unitIds);

    if (result.error) throw new Error(result.error);
    return result.rows || [];
  } finally {
    await browser.close();
  }
}

async function main() {
  const { TL_USER, TL_PASSWORD, TL_DOMAIN } = process.env;
  if (!TL_USER || !TL_PASSWORD || !TL_DOMAIN) throw new Error('Faltan TL_USER, TL_PASSWORD o TL_DOMAIN');

  const vehiculos = await obtenerVehiculos();
  const porUnitId = new Map(vehiculos.map((v) => [v.unit_id, v]));
  const checkpoint = await obtenerCheckpoint();
  const ahora = new Date();
  const start = new Date(checkpoint.getTime() - OVERLAP_MS);

  console.log(`=== Sync Pórticos (${vehiculos.length} vehículo(s): ${vehiculos.map((v) => v.patente).join(', ')}): ${fmtTL(start)} → ${fmtTL(ahora)} ===`);

  const rows = await loginYConsultarTravel({
    TL_USER, TL_PASSWORD, TL_DOMAIN,
    startDate: fmtTL(start), endDate: fmtTL(ahora),
    unitIds: vehiculos.map((v) => v.unit_id).join(','),
  });
  console.log(`[1] ${rows.length} posiciones GPS recibidas (todos los vehículos)`);

  const puntosPorVehiculo = new Map();
  for (const r of rows) {
    const vehiculo = porUnitId.get(r.unitIdA0);
    if (!vehiculo) continue;
    if (!puntosPorVehiculo.has(vehiculo.id)) puntosPorVehiculo.set(vehiculo.id, []);
    puntosPorVehiculo.get(vehiculo.id).push({
      time: new Date(r.gpsUtcTimeC13.replace(' ', 'T') + 'Z'),
      lat: r.latC12, lon: r.lonC11, speed: r.speedC8 || 0,
    });
  }

  let totalDetecciones = 0;
  for (const vehiculo of vehiculos) {
    const puntos = (puntosPorVehiculo.get(vehiculo.id) || [])
      .filter((p) => p.lat && p.lon && !isNaN(p.time))
      .sort((a, b) => a.time - b.time);
    console.log(`[2] ${vehiculo.patente}: ${puntos.length} puntos GPS válidos`);

    const detecciones = [];
    let ultimoPortico = null;
    let ultimoTs = null;
    for (const p of puntos) {
      for (const portico of PORTICOS) {
        const d = haversineMetros(p.lat, p.lon, portico.lat, portico.lon);
        if (d <= RADIO_GEOCERCA_M) {
          const tsMs = p.time.getTime();
          const esNuevo = portico.codigo !== ultimoPortico || !ultimoTs || tsMs - ultimoTs > MIN_GAP_MS;
          if (esNuevo) {
            // banda horaria y monto se calculan al SERVIR los datos (app/api/pasadas),
            // no acá, para no duplicar la lógica del tarifario en dos lugares.
            detecciones.push({
              vehiculo_id: vehiculo.id,
              ts: p.time.toISOString(),
              portico_codigo: portico.codigo,
              concesionaria: portico.concesionaria,
              tramo: portico.tramo,
              distancia_m: Math.round(d),
              velocidad_kmh: p.speed,
              lat: p.lat,
              lon: p.lon,
            });
          }
          ultimoPortico = portico.codigo;
          ultimoTs = tsMs;
        }
      }
    }
    console.log(`[3] ${vehiculo.patente}: ${detecciones.length} pasadas nuevas detectadas`);
    totalDetecciones += detecciones.length;

    if (detecciones.length) {
      const { error } = await supabase
        .from('porticos_pasadas_reales')
        .upsert(detecciones, { onConflict: 'vehiculo_id,ts,portico_codigo', ignoreDuplicates: true });
      if (error) throw new Error(`Error guardando pasadas de ${vehiculo.patente}: ${error.message}`);
      console.log(`[4] ✅ ${vehiculo.patente}: ${detecciones.length} pasadas insertadas/verificadas`);

      // Notificación a Telegram por cada pasada nueva (estado/facturado/correcto:
      // todo "OK" por ahora porque no hay factura oficial con la que comparar).
      // Solo para las patentes en PATENTES_NOTIFICAR_TELEGRAM (el vehículo propio
      // de Alex) — no se notifica por vehículos de prueba de otros clientes.
      if (!PATENTES_NOTIFICAR_TELEGRAM.includes(vehiculo.patente)) continue;
      for (const d of detecciones) {
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
  if (!totalDetecciones) console.log('[4] Sin pasadas nuevas en el rango consultado (ningún vehículo)');

  await guardarCheckpoint(ahora);
  console.log(`[5] Checkpoint actualizado a: ${ahora.toISOString()}`);
}

main().catch((err) => {
  console.error('ERROR FATAL:', err.message);
  process.exit(1);
});
