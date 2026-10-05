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
 * (Vespucio Sur y Autopase/Autopista Central) para tener un "dato real"
 * contra el cual calibrar la detección automáticamente, en vez de depender
 * de que comparta un CSV manual cada cierto tiempo.
 *
 * Requiere env vars: VESPUCIO_SUR_RUT, VESPUCIO_SUR_PASSWORD.
 * Guarda screenshot.png y pagina.html en el directorio actual (en CI,
 * subirlos como artifact -- ver workflow).
 */
const puppeteer = require('puppeteer');
const fs = require('fs');

const LOGIN_URL = 'https://oficina.vespuciosur.cl/sucursal_virtual/login.html';
const CARTOLA_URL = 'https://oficina.vespuciosur.cl/Convenios.dll/Cartola';

async function main() {
  const { VESPUCIO_SUR_RUT, VESPUCIO_SUR_PASSWORD } = process.env;
  if (!VESPUCIO_SUR_RUT || !VESPUCIO_SUR_PASSWORD) throw new Error('Faltan env vars VESPUCIO_SUR_RUT/VESPUCIO_SUR_PASSWORD');

  const [rutNumero, rutDv] = VESPUCIO_SUR_RUT.split('-');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    console.log(`[login] ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle0' });

    // No se sabe el selector exacto todavia (sin acceso al DOM real) -- se
    // intenta por varios candidatos razonables y se reporta cuál funcionó,
    // para dejarlo fijo en el script definitivo.
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

    await llenarPrimero(['input[name="rut"]', 'input#rut', 'input[name="Rut"]'], rutNumero, 'RUT (número)');
    await llenarPrimero(['input[name="dv"]', 'input#dv', 'input[name="Dv"]'], rutDv, 'RUT (dígito verificador)');
    await llenarPrimero(['input[name="password"]', 'input#password', 'input[type="password"]'], VESPUCIO_SUR_PASSWORD, 'Contraseña');

    await page.screenshot({ path: 'vespuciosur-01-formulario-lleno.png', fullPage: true });

    const botonIngresar = await page.$('button[type="submit"], input[type="submit"]');
    if (botonIngresar) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null),
        botonIngresar.click(),
      ]);
    } else {
      console.log('[login] ⚠️ No se encontró botón de submit estándar, buscando por texto "Ingresar"...');
      const [boton] = await page.$x("//button[contains(., 'Ingresar')] | //input[@value='Ingresar']");
      if (boton) await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null), boton.click()]);
    }

    console.log(`[login] URL después de intentar ingresar: ${page.url()}`);
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
