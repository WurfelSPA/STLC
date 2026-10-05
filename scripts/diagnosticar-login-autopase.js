#!/usr/bin/env node
'use strict';
/**
 * diagnosticar-login-autopase.js
 *
 * Mismo propósito que diagnosticar-login-vespuciosur.js, pero para el
 * portal de Autopista Central (autopase.cl). Ver ese archivo para el
 * contexto completo -- esto es diagnóstico puntual, no toca producción.
 *
 * Requiere env vars: AUTOPASE_RUT, AUTOPASE_PASSWORD.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const { clickPorTexto, llenarPrimero } = require('./lib/login-convenios-dll');

const PORTADA_URL = 'https://www.autopase.cl/';
const CONSUMOS_URL = 'https://www.autopase.cl/cliente/consumos/consumo_peaje_nofacturado';

async function main() {
  const { AUTOPASE_RUT, AUTOPASE_PASSWORD } = process.env;
  if (!AUTOPASE_RUT || !AUTOPASE_PASSWORD) throw new Error('Faltan env vars AUTOPASE_RUT/AUTOPASE_PASSWORD');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    console.log(`[login] ${PORTADA_URL}`);
    await page.goto(PORTADA_URL, { waitUntil: 'networkidle0' });

    // El login está en un menú desplegable "Zona de clientes" (ver captura
    // compartida) -- hay que abrirlo antes de que los campos existan en el DOM.
    // page.$x ya no existe en Puppeteer nuevo ("page.$x is not a function",
    // confirmado real en CI 2026-10-05) -- clickPorTexto busca y clickea
    // DENTRO del navegador (page.evaluate), no depende de esa API.
    const textoZona = await clickPorTexto(page, ['Zona de clientes']);
    if (textoZona) {
      console.log(`[login] Click en "${textoZona}"`);
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      console.log('[login] ⚠️ No se encontró el botón/link "Zona de clientes" por texto.');
    }

    await page.screenshot({ path: 'autopase-00-menu-abierto.png', fullPage: true });

    // El dígito verificador puede ir en una casilla separada (confirmado por
    // el usuario que el patrón se repite en varios logins chilenos, no
    // asumir un solo campo) -- se intenta primero con casilla separada, y
    // si no existe ninguna de esas, se cae al campo único con el RUT
    // completo (con guión).
    const [rutNumero, rutDv] = AUTOPASE_RUT.split('-');
    const huboDvSeparado = await llenarPrimero(
      page, ['input[name="dv"]', 'input#dv', 'input[name="rut_dv"]', 'input[maxlength="1"]'],
      rutDv, 'RUT (dígito verificador)'
    );
    if (huboDvSeparado) {
      await llenarPrimero(page, ['input[name="rut"]', 'input#rut', 'input[name="rut_numero"]'], rutNumero, 'RUT (número)');
    } else {
      await llenarPrimero(page, ['input[name="rut"]', 'input#rut', 'input[placeholder*="RUT" i]'], AUTOPASE_RUT, 'RUT (completo, un solo campo)');
    }
    await llenarPrimero(page, ['input[name="password"]', 'input#password', 'input[type="password"]'], AUTOPASE_PASSWORD, 'Contraseña');

    await page.screenshot({ path: 'autopase-01-formulario-lleno.png', fullPage: true });

    const [, textoIngresar] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null),
      clickPorTexto(page, ['INGRESAR', 'Ingresar']),
    ]);
    console.log(textoIngresar ? `[login] Click por texto: "${textoIngresar}"` : '[login] ⚠️ No se encontró botón "INGRESAR" por texto.');

    console.log(`[login] URL después de intentar ingresar: ${page.url()}`);
    await page.screenshot({ path: 'autopase-02-post-login.png', fullPage: true });
    fs.writeFileSync('autopase-02-post-login.html', await page.content());

    console.log(`[consumos] Navegando a ${CONSUMOS_URL}...`);
    await page.goto(CONSUMOS_URL, { waitUntil: 'networkidle0' }).catch((e) => console.log(`[consumos] goto falló: ${e.message}`));
    await page.screenshot({ path: 'autopase-03-consumos.png', fullPage: true });
    fs.writeFileSync('autopase-03-consumos.html', await page.content());

    console.log('=== Diagnóstico terminado. Revisar los .png y .html guardados. ===');
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('ERROR FATAL:', err.message); process.exitCode = 1; });
