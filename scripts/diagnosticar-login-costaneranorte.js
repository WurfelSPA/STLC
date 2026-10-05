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
 * ESTADO (2026-10-05): PAUSADO, mismo motivo que Vespucio Sur --
 * Cloudflare Turnstile (data-sitekey="0x4AAAAAACaPHViWMxm1WwSq") bloquea
 * el login en headless. El click que parecía "entrar a tránsitos" en
 * realidad clickeaba el texto promocional "Revisa los tránsitos no
 * facturados" que aparece en la misma página de login pública (li de la
 * lista de beneficios), no una navegación real -- confirmado revisando
 * el HTML del artifact, que seguía siendo la página de login. No evadir
 * el captcha; se sigue con consulta manual para este portal.
 *
 * Requiere env vars: COSTANERA_NORTE_RUT, COSTANERA_NORTE_PASSWORD.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const { loginConveniosDll, clickPorTexto } = require('./lib/login-convenios-dll');

const LOGIN_URL = 'https://costaneranorte.cl/sucursal_virtual/login.html';

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

    await loginConveniosDll(page, {
      loginUrl: LOGIN_URL, rut: COSTANERA_NORTE_RUT, password: COSTANERA_NORTE_PASSWORD,
      volcarHtmlInicial: (html) => fs.writeFileSync('costaneranorte-00-login-inicial.html', html),
    });

    try { await page.screenshot({ path: 'costaneranorte-02-post-login.png', fullPage: true, timeout: 15_000 }); } catch (e) { console.log(`[screenshot] falló: ${e.message}`); }
    try { fs.writeFileSync('costaneranorte-02-post-login.html', await page.content()); } catch (e) { console.log(`[content] falló: ${e.message}`); }

    // "Tránsitos no facturados" NO es un link con URL -- es
    // javascript:MostrarTransitos() (confirmado real 2026-10-05,
    // inspeccionado a mano), probablemente carga el contenido en la misma
    // página vía AJAX. Se hace click por texto y se espera un poco en vez
    // de navegar a una URL adivinada.
    console.log('[transitos] Buscando "Tránsitos no facturados"...');
    const textoTransitos = await clickPorTexto(page, ['Tránsitos no facturados', 'Transitos no facturados']);
    console.log(textoTransitos ? `[transitos] Click: "${textoTransitos}"` : '[transitos] ⚠️ No se encontró el link/botón por texto.');
    await new Promise((r) => setTimeout(r, 3000));
    try { await page.screenshot({ path: 'costaneranorte-03-transitos.png', fullPage: true, timeout: 15_000 }); } catch (e) { console.log(`[screenshot] falló: ${e.message}`); }
    try { fs.writeFileSync('costaneranorte-03-transitos.html', await page.content()); } catch (e) { console.log(`[content] falló: ${e.message}`); }

    console.log('=== Diagnóstico terminado. Revisar los .png y .html guardados. ===');
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('ERROR FATAL:', err.message); process.exitCode = 1; });
