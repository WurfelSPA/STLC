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
const { loginConveniosDll, clickPorTexto } = require('./lib/login-convenios-dll');

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

    await loginConveniosDll(page, {
      loginUrl: LOGIN_URL, rut: VESPUCIO_SUR_RUT, password: VESPUCIO_SUR_PASSWORD,
      volcarHtmlInicial: (html) => fs.writeFileSync('vespuciosur-00-login-inicial.html', html),
    });

    // Cada paso en su propio try/catch -- si algo se cuelga o falla, igual
    // se guarda lo que se alcanzó a conseguir hasta ahí (confirmado real
    // 2026-10-05: un alert sin descartar colgó hasta el screenshot).
    try { await page.screenshot({ path: 'vespuciosur-02-post-login.png', fullPage: true, timeout: 15_000 }); } catch (e) { console.log(`[screenshot] falló: ${e.message}`); }
    try { fs.writeFileSync('vespuciosur-02-post-login.html', await page.content()); } catch (e) { console.log(`[content] falló: ${e.message}`); }

    console.log(`[cartola] Navegando a ${CARTOLA_URL}...`);
    await page.goto(CARTOLA_URL, { waitUntil: 'networkidle0', timeout: 15_000 }).catch((e) => console.log(`[cartola] goto falló: ${e.message}`));

    // La captura que compartió el usuario mostraba la pestaña "Tránsitos"
    // ya activa, pero no hay garantía de que sea la pestaña por defecto --
    // se intenta clickearla por texto, sin bloquear si no se encuentra.
    const textoTransitos = await clickPorTexto(page, ['Tránsitos']);
    if (textoTransitos) { console.log(`[cartola] Click en pestaña: "${textoTransitos}"`); await new Promise((r) => setTimeout(r, 1500)); }

    try { await page.screenshot({ path: 'vespuciosur-03-cartola.png', fullPage: true, timeout: 15_000 }); } catch (e) { console.log(`[screenshot] falló: ${e.message}`); }
    try { fs.writeFileSync('vespuciosur-03-cartola.html', await page.content()); } catch (e) { console.log(`[content] falló: ${e.message}`); }

    console.log('=== Diagnóstico terminado. Revisar los .png y .html guardados. ===');
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('ERROR FATAL:', err.message); process.exitCode = 1; });
