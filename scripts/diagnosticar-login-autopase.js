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
    const [botonZona] = await page.$x("//*[contains(text(), 'Zona de clientes')]");
    if (botonZona) {
      await botonZona.click();
      console.log('[login] Click en "Zona de clientes"');
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      console.log('[login] ⚠️ No se encontró el botón/link "Zona de clientes" por texto.');
    }

    await page.screenshot({ path: 'autopase-00-menu-abierto.png', fullPage: true });

    async function llenarPrimero(selectores, valor, nombre) {
      for (const sel of selectores) {
        const el = await page.$(sel);
        if (el) {
          await el.type(valor, { delay: 20 });
          console.log(`[login] ${nombre}: usó selector "${sel}"`);
          return true;
        }
      }
      console.log(`[login] ⚠️ ${nombre}: NINGÚN selector candidato encontró el campo (${selectores.join(', ')})`);
      return false;
    }

    await llenarPrimero(['input[name="rut"]', 'input#rut', 'input[placeholder*="RUT" i]'], AUTOPASE_RUT, 'RUT');
    await llenarPrimero(['input[name="password"]', 'input#password', 'input[type="password"]'], AUTOPASE_PASSWORD, 'Contraseña');

    await page.screenshot({ path: 'autopase-01-formulario-lleno.png', fullPage: true });

    const [botonIngresar] = await page.$x("//button[contains(., 'INGRESAR')] | //button[contains(., 'Ingresar')] | //input[@value='INGRESAR']");
    if (botonIngresar) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null),
        botonIngresar.click(),
      ]);
    } else {
      console.log('[login] ⚠️ No se encontró botón "INGRESAR" por texto.');
    }

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
