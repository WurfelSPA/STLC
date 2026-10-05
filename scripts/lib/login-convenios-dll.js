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
    // Se agrega [onclick]/li ademas de button/a/input -- confirmado real
    // 2026-10-05 que "Tránsitos no facturados" en Costanera Norte es
    // javascript:MostrarTransitos() (podria ser <a href="javascript:...">
    // o un elemento con onclick, no siempre un link/boton estandar).
    const elementos = document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [onclick], li');
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

// Confirmado real 2026-10-05: sin esto, un alert() de validación del
// formulario (ej. "RUT requerido") deja la página bloqueada y hasta el
// screenshot termina colgado ("Page.captureScreenshot timed out") -- los
// diálogos nativos de JS bloquean todo el render hasta que algo los cierra.
function descartarDialogosAutomaticamente(page) {
  page.on('dialog', async (dialog) => {
    console.log(`[dialog] ⚠️ Diálogo nativo detectado: "${dialog.message()}" -- se descarta automáticamente.`);
    await dialog.dismiss().catch(() => {});
  });
}

async function loginConveniosDll(page, { loginUrl, rut, password, volcarHtmlInicial }) {
  const [rutNumero, rutDv] = rut.split('-');

  descartarDialogosAutomaticamente(page);

  console.log(`[login] ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'networkidle0' });

  // Se guarda el HTML tal cual llega, ANTES de tocar nada -- si los
  // selectores de abajo fallan (como pasó realmente con "rut"), esto deja
  // ver los nombres reales de los campos en vez de seguir adivinando a
  // ciegas.
  if (volcarHtmlInicial) await volcarHtmlInicial(await page.content());

  // Confirmado real 2026-10-05 (inspeccionado a mano en Costanera Norte):
  // name="RUT" / name="RUTDV", todo en mayúsculas -- no "rut"/"dv" como se
  // había asumido antes. Se dejan los nombres en minúscula como fallback
  // por si Vespucio Sur (mismo sistema, pero no necesariamente el mismo
  // build exacto) los tiene distinto.
  await llenarPrimero(page, ['input[name="RUT"]', 'input#RUT', 'input[name="rut"]', 'input#rut'], rutNumero, 'RUT (número)');
  await llenarPrimero(page, ['input[name="RUTDV"]', 'input#RUTDV', 'input[name="dv"]', 'input#dv', 'input[maxlength="1"]'], rutDv, 'RUT (dígito verificador)');
  await llenarPrimero(page, ['input[name="password"]', 'input#password', 'input[type="password"]'], password, 'Contraseña');

  // Timeout corto a propósito (15s, no los 60s default): si el submit no
  // dispara una navegación completa (ej. falla la validación y se queda en
  // la misma página, o es un alert ya descartado arriba), no vale la pena
  // esperar el default entero -- mejor seguir y que el HTML/captura de
  // después muestre lo que realmente pasó.
  const botonIngresar = await page.$('button[type="submit"], input[type="submit"]');
  if (botonIngresar) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15_000 }).catch(() => null),
      botonIngresar.click(),
    ]);
  } else {
    console.log('[login] No se encontró botón de submit estándar, buscando por texto "Ingresar"...');
    const [, textoEncontrado] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15_000 }).catch(() => null),
      clickPorTexto(page, ['Ingresar']),
    ]);
    console.log(textoEncontrado ? `[login] Click por texto: "${textoEncontrado}"` : '[login] ⚠️ No se encontró ningún elemento con texto "Ingresar".');
  }

  console.log(`[login] URL después de intentar ingresar: ${page.url()}`);
}

module.exports = { loginConveniosDll, clickPorTexto, llenarPrimero };
