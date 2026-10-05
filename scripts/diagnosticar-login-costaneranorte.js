#!/usr/bin/env node
'use strict';
/**
 * diagnosticar-login-costaneranorte.js
 *
 * Mismo propósito y mecanismo que diagnosticar-login-vespuciosur.js --
 * el usuario confirmó 2026-10-05 que Costanera Norte usa el mismo sistema
 * de oficina virtual (Convenios.dll). URLs exactas sin confirmar todavía
 * (se vio real solo "costaneranorte.cl/Convenios.dll/VerUltimaNotaDeCobro"
 * YA logueado) -- este diagnóstico sirve justamente para confirmarlas o
 * corregirlas con el HTML/capturas reales.
 *
 * Requiere env vars: COSTANERA_NORTE_RUT, COSTANERA_NORTE_PASSWORD.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const { loginConveniosDll } = require('./lib/login-convenios-dll');

// Mejor estimación por ahora -- mismo patrón que Vespucio Sur, sin el
// subdominio "oficina." porque la captura real no lo mostraba.
const LOGIN_URL = 'https://costaneranorte.cl/sucursal_virtual/login.html';
const CARTOLA_URL = 'https://costaneranorte.cl/Convenios.dll/Cartola';

async function main() {
  const { COSTANERA_NORTE_RUT, COSTANERA_NORTE_PASSWORD } = process.env;
  if (!COSTANERA_NORTE_RUT || !COSTANERA_NORTE_PASSWORD) throw new Error('Faltan env vars COSTANERA_NORTE_RUT/COSTANERA_NORTE_PASSWORD');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);

    await loginConveniosDll(page, { loginUrl: LOGIN_URL, rut: COSTANERA_NORTE_RUT, password: COSTANERA_NORTE_PASSWORD });

    await page.screenshot({ path: 'costaneranorte-02-post-login.png', fullPage: true });
    fs.writeFileSync('costaneranorte-02-post-login.html', await page.content());

    console.log(`[cartola] Navegando a ${CARTOLA_URL}...`);
    await page.goto(CARTOLA_URL, { waitUntil: 'networkidle0' }).catch((e) => console.log(`[cartola] goto falló: ${e.message}`));
    await page.screenshot({ path: 'costaneranorte-03-cartola.png', fullPage: true });
    fs.writeFileSync('costaneranorte-03-cartola.html', await page.content());

    console.log('=== Diagnóstico terminado. Revisar los .png y .html guardados. ===');
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('ERROR FATAL:', err.message); process.exitCode = 1; });
