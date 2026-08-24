#!/usr/bin/env node
'use strict';
/**
 * sync-historial-santamarta.js
 *
 * Trae el HISTORIAL COMPLETO de reportes (no solo el último) para las 5
 * unidades de Santa Marta, vía reportTravel — pedido explícito del
 * cliente (2026-08-24): con reportUnitsAndLastPosition solo recibían
 * <3% de los ~1.400 registros/día que la plataforma realmente guarda,
 * porque ese endpoint solo da "el último estado conocido" al momento de
 * la consulta, no todo lo ocurrido desde la consulta anterior.
 *
 * reportTravel sí devuelve todos los puntos guardados en un rango de
 * fechas (confirmado en vivo 2026-08-24: respuesta = [metadataUnidades,
 * arrayDePuntos], cada punto con gpsUtcTimeC13/odometerC14/hourmeterC15).
 * Por eso, en vez de subir la frecuencia de sync, cada corrida pide
 * "todo desde la última corrida exitosa" y lo ACUMULA en Supabase
 * (tabla SantaMartaHistorial, nunca se sobrescribe) — el checkpoint de
 * hasta dónde se pidió se guarda en SyncCheckpoints (key
 * "santamarta_pull"). Se pide con 5 min de solape para no perder el
 * borde si una corrida se demora o falla.
 *
 * El endpoint /api/clientes/santamarta expone este historial acumulado
 * con su PROPIO checkpoint de entrega (independiente de este, key
 * "santamarta_delivery"), así el cliente recibe "todo lo nuevo desde su
 * última consulta exitosa" sin tener que cambiar cómo llama a la API.
 *
 * Variables de entorno esperadas (GitHub Secrets):
 *   TL_USER, TL_PASSWORD, TL_DOMAIN — mismas credenciales que /api/sync
 */

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://lomkolhgmkvshucqjuhf.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvbWtvbGhnbWt2c2h1Y3FqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MDUyNTUsImV4cCI6MjA5MDI4MTI1NX0.I_13jMA2DAa6Jzff4VBQitezdR2kfrXSVacaBn0QZbo'
);

// unitId (TrackGTS) -> IMEI/alias, igual que en el resto de Santa Marta.
const UNIDADES_SANTAMARTA = [
  { unitId: 6702, imei: '868589061400860', alias: 'CATERPILAR 1250 Bulldozer' },
  { unitId: 6567, imei: '868589061200856', alias: 'KOMATSU 1550 Retroexcavadora' },
  { unitId: 6700, imei: '868589061490010', alias: 'MERCEDES-BENZ-4144-HKSX-54' },
  { unitId: 6568, imei: '868589061373570', alias: 'BULLDOZER-KOMTASU-D155-AC' },
  { unitId: 5969, imei: '868589061071729', alias: 'EXCAVADORA-KOMATSU-1401-PC-220' },
];

const CHECKPOINT_KEY = 'santamarta_pull';
const OVERLAP_MS = 5 * 60_000; // 5 min de solape para no perder el borde
const LOOKBACK_DEFAULT_MS = 2 * 60 * 60_000; // si no hay checkpoint (primera corrida): últimas 2h

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 90_000;

function fmtTL(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function obtenerCheckpoint() {
  const { data, error } = await supabase
    .from('SyncCheckpoints')
    .select('value')
    .eq('key', CHECKPOINT_KEY)
    .maybeSingle();
  if (error) throw new Error(`Error leyendo checkpoint: ${error.message}`);
  if (data?.value) return new Date(data.value);
  return new Date(Date.now() - LOOKBACK_DEFAULT_MS);
}

async function guardarCheckpoint(fecha) {
  const { error } = await supabase
    .from('SyncCheckpoints')
    .upsert({ key: CHECKPOINT_KEY, value: fecha.toISOString() });
  if (error) throw new Error(`Error guardando checkpoint: ${error.message}`);
}

async function loginYConsultarTravel({ TL_USER, TL_PASSWORD, TL_DOMAIN, startDate, endDate, unitIds }) {
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
      console.log(`[1] Intento ${attempt}/${MAX_ATTEMPTS} — Login en: ${loginUrl}`);
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

      console.log('[2] Esperando sesión (15s)...');
      await new Promise((r) => setTimeout(r, 15_000));

      console.log(`[3] Consultando reportTravel: ${startDate} → ${endDate}`);
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
        // Forma confirmada en vivo: [metadataUnidades, arrayDePuntos]
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

async function main() {
  const { TL_USER, TL_PASSWORD, TL_DOMAIN } = process.env;
  if (!TL_USER || !TL_PASSWORD || !TL_DOMAIN) {
    throw new Error('Faltan variables de entorno: TL_USER, TL_PASSWORD, TL_DOMAIN');
  }

  const checkpoint = await obtenerCheckpoint();
  const ahora = new Date();
  const start = new Date(checkpoint.getTime() - OVERLAP_MS);
  const unitIds = UNIDADES_SANTAMARTA.map((u) => u.unitId).join(',');

  console.log(`=== Sync Historial Santa Marta: ${fmtTL(start)} → ${fmtTL(ahora)} ===`);

  const rows = await loginYConsultarTravel({
    TL_USER, TL_PASSWORD, TL_DOMAIN,
    startDate: fmtTL(start), endDate: fmtTL(ahora),
    unitIds,
  });
  console.log(`[4] Filas recibidas de reportTravel: ${rows.length}`);

  const porUnitId = new Map(UNIDADES_SANTAMARTA.map((u) => [u.unitId, u]));

  const registros = rows
    .filter((r) => porUnitId.has(r.unitIdA0))
    .map((r) => {
      const u = porUnitId.get(r.unitIdA0);
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

  console.log(`[5] Filas válidas de Santa Marta: ${registros.length}`);

  if (registros.length) {
    const { error } = await supabase
      .from('SantaMartaHistorial')
      .upsert(registros, { onConflict: 'IMEI,gpsUtcTime', ignoreDuplicates: true });
    if (error) throw new Error(`Error al guardar historial: ${error.message}`);
    console.log(`[6] ✅ ${registros.length} registros insertados/verificados en el historial.`);
  } else {
    console.log('[6] Sin registros nuevos en el rango consultado.');
  }

  await guardarCheckpoint(ahora);
  console.log(`[7] Checkpoint de pull actualizado a: ${ahora.toISOString()}`);
}

main().catch((err) => {
  console.error('ERROR FATAL:', err.message);
  process.exit(1);
});
