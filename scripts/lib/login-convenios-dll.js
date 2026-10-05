'use strict';
/**
 * login-convenios-dll.js
 *
 * Lógica compartida para los portales "Convenios.dll" (ASP clásico) que
 * usan tanto Vespucio Sur como Costanera Norte -- mismo sistema de
 * oficina virtual, confirmado por el usuario 2026-10-05 ("el login es
 * igual al de Vespucio Sur"). Evita duplicar el mismo código de login en
 * cada script de diagnóstico/scraper.
 *
 * No usa page.$x() -- Puppeteer lo sacó en versiones nuevas
 * ("page.$x is not a function", confirmado real en CI 2026-10-05).
 * clickPorTexto busca y hace click DENTRO del contexto de la página
 * (page.evaluate), que no depende de esa API.
 */

async function clickPorTexto(page, textosCandidatos) {
  return page.evaluate((textos) => {
    const elementos = document.querySelectorAll('button, a, input[type="submit"], input[type="button"]');
    for (const texto of textos) {
      for (const el of elementos) {
        const contenido = (el.innerText || el.value || '').trim();
        if (contenido && contenido.toLowerCase().includes(texto.toLowerCase())) {
          el.click();
          return contenido;
        }
      }
    }
    return null;
  }, textosCandidatos);
}

async function llenarPrimero(page, selectores, valor, nombre) {
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

async function loginConveniosDll(page, { loginUrl, rut, password }) {
  const [rutNumero, rutDv] = rut.split('-');

  console.log(`[login] ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'networkidle0' });

  await llenarPrimero(page, ['input[name="rut"]', 'input#rut', 'input[name="Rut"]'], rutNumero, 'RUT (número)');
  await llenarPrimero(page, ['input[name="dv"]', 'input#dv', 'input[name="Dv"]', 'input[name="rut_dv"]', 'input[maxlength="1"]'], rutDv, 'RUT (dígito verificador)');
  await llenarPrimero(page, ['input[name="password"]', 'input#password', 'input[type="password"]'], password, 'Contraseña');

  const botonIngresar = await page.$('button[type="submit"], input[type="submit"]');
  if (botonIngresar) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null),
      botonIngresar.click(),
    ]);
  } else {
    console.log('[login] No se encontró botón de submit estándar, buscando por texto "Ingresar"...');
    const [, textoEncontrado] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null),
      clickPorTexto(page, ['Ingresar']),
    ]);
    console.log(textoEncontrado ? `[login] Click por texto: "${textoEncontrado}"` : '[login] ⚠️ No se encontró ningún elemento con texto "Ingresar".');
  }

  console.log(`[login] URL después de intentar ingresar: ${page.url()}`);
}

module.exports = { loginConveniosDll, clickPorTexto, llenarPrimero };
