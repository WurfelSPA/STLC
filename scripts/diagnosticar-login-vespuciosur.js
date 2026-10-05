#!/usr/bin/env node
'use strict';
/**
 * diagnosticar-login-vespuciosur.js
 *
 * Diagnóstico puntual (no guarda nada en Supabase, no toca producción):
 * inicia sesión en la oficina virtual de Vespucio Sur y guarda una captura
 * de pantalla + el HTML de la página de tránsitos, para confirmar que el
 * login funciona y ver la estructura real de la tabla antes de construir
 * el scraper completo (sync-vespucio-sur-real.js, pendiente).
 *
 * Motivo (2026-10-05): el usuario pidió poder extraer diariamente los
 * tránsitos reales de VVJG-14 desde los portales de las concesionarias
 * (Vespucio Sur, Costanera Norte, Autopase/Autopista Central) para tener
 * un "dato real" contra el cual calibrar la detección automáticamente, en
 * vez de depender de que comparta un CSV manual cada cierto tiempo.
 *
 * Requiere env vars: VESPUCIO_SUR_RUT, VESPUCIO_SUR_PASSWORD.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const { loginConveniosDll } = require('./lib/login-convenios-dll');

const LOGIN_URL = 'https://oficina.vespuciosur.cl/sucursal_virtual/login.html';
const CARTOLA_URL = 'https://oficina.vespuciosur.cl/Convenios.dll/Cartola';

async function main() {
  const { VESPUCIO_SUR_RUT, VESPUCIO_SUR_PASSWORD } = process.env;
  if (!VESPUCIO_SUR_RUT || !VESPUCIO_SUR_PASSWORD) throw new Error('Faltan env vars VESPUCIO_SUR_RUT/VESPUCIO_SUR_PASSWORD');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);

    await loginConveniosDll(page, { loginUrl: LOGIN_URL, rut: VESPUCIO_SUR_RUT, password: VESPUCIO_SUR_PASSWORD });

    await page.screenshot({ path: 'vespuciosur-02-post-login.png', fullPage: true });
    fs.writeFileSync('vespuciosur-02-post-login.html', await page.content());

    console.log(`[cartola] Navegando a ${CARTOLA_URL}...`);
    await page.goto(CARTOLA_URL, { waitUntil: 'networkidle0' }).catch((e) => console.log(`[cartola] goto falló: ${e.message}`));
    await page.screenshot({ path: 'vespuciosur-03-cartola.png', fullPage: true });
    fs.writeFileSync('vespuciosur-03-cartola.html', await page.content());

    console.log('=== Diagnóstico terminado. Revisar los .png y .html guardados. ===');
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('ERROR FATAL:', err.message); process.exitCode = 1; });
