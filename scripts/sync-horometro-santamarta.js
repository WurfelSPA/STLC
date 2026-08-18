#!/usr/bin/env node
'use strict';
/**
 * sync-horometro-santamarta.js
 *
 * Complementa /api/sync (HealthCheck) con dos campos que Santa Marta pidió
 * con urgencia (2026-08-18) y que TrackGTS NO expone por HealthCheck:
 *   - Horómetro (horas de motor) — HealthCheck no lo trae en absoluto.
 *   - Odómetro con decimales — HealthCheck lo devuelve redondeado a entero
 *     (confirmado en vivo: 344 en vez de 344.x).
 *
 * Ambos SÍ están disponibles vía el endpoint interno que usa la pantalla
 * "Mapa" de TrackGTS: POST /api/reportUnitsAndLastPosition/{userId}/16/{hash}
 * — pero ese endpoint exige un hash de sesión de login real (cookie-based),
 * no el accessToken Bearer que usa /api/Authenticate/Auth (confirmado en
 * vivo: el Bearer token devuelve {"idResult":-3,"message":"error"} en este
 * endpoint específico). Por eso este script hace login real con Puppeteer,
 * igual que los pipelines de Kadel/Enerfrost, en vez de reusar la
 * autenticación simple de /api/sync.
 *
 * Corre en GitHub Actions (no en Vercel — Puppeteer no cabe bien en una
 * función serverless) y escribe directo a Supabase; el endpoint
 * /api/clientes/santamarta ya expone estas columnas nuevas automáticamente
 * porque hace select("*").
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

// unitId (TrackGTS) -> IMEI (clave de la tabla Tracklink en Supabase).
// Mapeo confirmado 2026-08-18 contra la pantalla "Maquinarias RFID" de
// Santa Marta y la tabla Tracklink existente. Si Santa Marta agrega
// unidades nuevas, sumarlas aquí.
const UNIDADES_SANTAMARTA = [
  { unitId: 6702, imei: '868589061400860', alias: 'CATERPILAR 1250 Bulldozer' },
  { unitId: 6567, imei: '868589061200856', alias: 'KOMATSU 1550 Retroexcavadora' },
  { unitId: 6700, imei: '868589061490010', alias: 'MERCEDES-BENZ-4144-HKSX-54' },
  { unitId: 6568, imei: '868589061373570', alias: 'BULLDOZER-KOMTASU-D155-AC' },
  { unitId: 5969, imei: '868589061071729', alias: 'EXCAVADORA-KOMATSU-1401-PC-220' },
];

// Corre con relativa frecuencia (cada ~25-30 min) — a diferencia del
// pipeline semanal de Kadel/Enerfrost, no vale la pena reintentar mucho
// tiempo si falla: la próxima corrida programada lo intenta de nuevo pronto.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 90_000;

async function loginYConsultar({ TL_USER, TL_PASSWORD, TL_DOMAIN, unitIds }) {
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
      console.log(`[2] URL actual: ${page.url()}`);

      console.log('[3] Consultando reportUnitsAndLastPosition...');
      const result = await page.evaluate(async (ids) => {
        const h = JSONUSER.hash;
        const userId = JSONUSER.userId;
        const res = await fetch(
          `https://www.trackgts.com:82/api/reportUnitsAndLastPosition/${userId}/16/${h}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' }, body: JSON.stringify(ids) }
        );
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch (e) {
          return { error: `Respuesta no-JSON: ${text.slice(0, 300)}` };
        }
        if (json && json.idResult !== undefined) {
          return { error: `idResult=${json.idResult} (sesión inválida o sin datos)` };
        }
        if (!Array.isArray(json)) {
          return { error: `Respuesta inesperada (no es array): ${JSON.stringify(json).slice(0, 300)}` };
        }
        return { rows: json };
      }, unitIds);

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

  const unitIds = UNIDADES_SANTAMARTA.map((u) => u.unitId);
  console.log(`=== Sync Horómetro/Odómetro Santa Marta: unidades ${unitIds.join(', ')} ===`);

  const rows = await loginYConsultar({ TL_USER, TL_PASSWORD, TL_DOMAIN, unitIds });
  console.log(`[4] Filas recibidas: ${rows.length}`);

  const porUnitId = new Map(rows.map((r) => [r.unitIdA0, r]));

  const registros = [];
  for (const u of UNIDADES_SANTAMARTA) {
    const r = porUnitId.get(u.unitId);
    if (!r) {
      console.log(`[!] Sin datos para ${u.alias} (unitId ${u.unitId}) en la respuesta.`);
      continue;
    }
    registros.push({
      IMEI: u.imei,
      'Horómetro': r.hourmeterC15 ?? null,
      'Odómetro Decimal': r.odometerC14 ?? null,
    });
    console.log(`  ${u.alias}: Horómetro=${r.hourmeterC15} | Odómetro=${r.odometerC14}`);
  }

  if (!registros.length) {
    throw new Error('No se obtuvo ningún registro válido — no se actualiza Supabase.');
  }

  const { error } = await supabase.from('Tracklink').upsert(registros, { onConflict: 'IMEI' });
  if (error) throw new Error(`Error al guardar en Supabase: ${error.message}`);

  console.log(`[5] ✅ ${registros.length} unidades actualizadas en Supabase.`);
}

main().catch((err) => {
  console.error('ERROR FATAL:', err.message);
  process.exit(1);
});
