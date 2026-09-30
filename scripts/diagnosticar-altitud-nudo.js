#!/usr/bin/env node
'use strict';
/**
 * diagnosticar-altitud-nudo.js
 *
 * Diagnóstico puntual (no escribe nada en Supabase, no toca producción):
 * consulta reportTravel de TrackGTS para un rango de fechas pasado y filtra
 * los puntos GPS cerca de una coordenada dada, imprimiendo su altitud
 * (altitudeC10) junto con hora/velocidad -- para acumular evidencia real
 * de qué altitud se lee cuando el vehículo va por el viaducto elevado de
 * AVO vs. si alguna vez pasa realmente por el túnel/rampa de abajo en el
 * mismo nudo (Viaducto El Salto, ver PC101/P201 en sync-tlchile.js).
 *
 * Motivo (2026-09-30): PC101 (Túnel San Cristóbal) y P201 (AVO, ramal
 * Ciudad Empresarial) se disparan como falsos positivos porque en ese nudo
 * la autopista AVO pasa en un viaducto ELEVADO justo encima del túnel/rampa
 * -- misma coordenada 2D, nivel físico distinto, ninguna comparación de
 * lat/lon puede distinguirlos. La altitud sí debería, pero hace falta
 * calibrar con datos reales antes de conectar cualquier fix -- este script
 * sirve para sacar esos datos de corridas PASADAS (antes de que
 * sync-tlchile.js empezara a guardar altitud_m) sin depender del export
 * manual de TrackGTS (confirmado que ese export NO incluye altitud).
 *
 * Uso: node scripts/diagnosticar-altitud-nudo.js <fechaInicio> <fechaFin> <lat> <lon> <radioMetros> <unitIds>
 *   Fechas en formato 'YYYY/MM/DD HH:mm:ss' (hora Chile, mismo formato que fmtTL en sync-tlchile.js).
 *   unitIds: coma-separado, ej "5969,6878" (VVJG-14 principal+FTC927).
 *
 * Requiere las mismas env vars que sync-tlchile.js: TL_USER, TL_PASSWORD, TL_DOMAIN.
 */
const puppeteer = require('puppeteer');
const { haversineMetros } = require('./geo-utils');

async function loginYConsultarTravel({ TL_USER, TL_PASSWORD, TL_DOMAIN, startDate, endDate, unitIds }) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    const loginUrl = `https://${TL_DOMAIN}.trackgts.com/admin/login.html`;
    console.log(`[login] ${loginUrl}`);
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
        a.push(CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(S[c] || c), k, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString());
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

    console.log(`[travel] Consultando reportTravel: ${startDate} → ${endDate} (unitIds=${unitIds})`);
    const result = await page.evaluate(async (startStr, endStr, unitIdsStr) => {
      const h = JSONUSER.hash;
      const res = await fetch(`https://www.trackgts.com:82/api/reportTravel/${h}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=utf-8' },
        body: JSON.stringify([{ startDate: startStr, endDate: endStr, unitIds: unitIdsStr }]),
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
  const [, , fechaInicio, fechaFin, latStr, lonStr, radioStr, unitIds] = process.argv;
  if (!fechaInicio || !fechaFin || !latStr || !lonStr || !unitIds) {
    throw new Error('Uso: node diagnosticar-altitud-nudo.js <fechaInicio> <fechaFin> <lat> <lon> <radioMetros> <unitIds>');
  }
  const lat = Number(latStr), lon = Number(lonStr), radio = Number(radioStr || 300);
  const { TL_USER, TL_PASSWORD, TL_DOMAIN } = process.env;
  if (!TL_USER || !TL_PASSWORD || !TL_DOMAIN) throw new Error('Faltan env vars TL_USER/TL_PASSWORD/TL_DOMAIN');

  const rows = await loginYConsultarTravel({ TL_USER, TL_PASSWORD, TL_DOMAIN, startDate: fechaInicio, endDate: fechaFin, unitIds });
  console.log(`[travel] ${rows.length} posiciones recibidas en total, filtrando a ${radio}m de (${lat},${lon})...`);

  const cercanos = rows
    .map((r) => ({
      unitId: r.unitIdA0, ts: r.gpsUtcTimeC13, lat: r.latC12, lon: r.lonC11,
      altitud: r.altitudeC10, speed: r.speedC8, heading: r.headingC9,
      dist: haversineMetros(lat, lon, r.latC12, r.lonC11),
    }))
    .filter((p) => p.dist <= radio)
    .sort((a, b) => (a.ts > b.ts ? 1 : -1));

  console.log(`${cercanos.length} puntos dentro del radio.\n`);
  for (const p of cercanos) {
    console.log(`unit=${p.unitId} ts=${p.ts} altitud=${p.altitud}m velocidad=${p.speed}km/h rumbo=${p.heading}° dist=${Math.round(p.dist)}m (${p.lat},${p.lon})`);
  }
}

main().catch((err) => { console.error('ERROR FATAL:', err.message); process.exitCode = 1; });
