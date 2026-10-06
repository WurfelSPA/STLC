// Genera una página HTML autocontenida para ver a Tracky animado (misma capa
// SVG y mismas animaciones que el panel). Uso:
//   npx tsx scripts/tracky-preview.mts <salida.html>
import fs from "node:fs";
import { trackyCaraSvg, TRACKY_ANCHO, TRACKY_ALTO } from "../app/components/trackyOverlay";

const salida = process.argv[2];
const img = fs.readFileSync("public/tracky.webp").toString("base64");
const css = fs.readFileSync("app/globals.css", "utf8");
const animaciones = css.slice(css.indexOf("/* ── Tracky animado"));
const cara = trackyCaraSvg();

const tracky = (alto: number, estado: string) => {
  const ancho = Math.round((alto * TRACKY_ANCHO) / TRACKY_ALTO);
  return `<div class="tk-tracky tk-${estado} marco" data-estado="${estado}" style="width:${ancho}px;height:${alto}px" role="img" aria-label="Tracky">
  <div class="tk-flota capa"><img src="data:image/webp;base64,${img}" alt="" class="capa">
  <svg viewBox="0 0 ${TRACKY_ANCHO} ${TRACKY_ALTO}" class="capa" aria-hidden="true">${cara}</svg></div></div>`;
};

const html = `<title>Tracky en movimiento</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;800&display=swap">
<style>
/* Layout: un escenario central con Tracky grande, selector de estado y una fila de usos reales (avatar de chat). */
:root { --bg: #f2f2f8; --fg: #1d2233; --suave: #5b6278; --borde: #dcdcea; --acento: #12b8d6; --tarjeta: #ffffff; --chat: #ece5dd; --burbuja: #ffffff;
  --display: "Nunito", "Trebuchet MS", sans-serif; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #12141c; --fg: #eceef6; --suave: #a3a9bd; --borde: #2a2e3d; --acento: #3fe6ff; --tarjeta: #1a1d28; --chat: #0f1a17; --burbuja: #1f2c28; color-scheme: dark } }
:root[data-theme="dark"] { --bg: #12141c; --fg: #eceef6; --suave: #a3a9bd; --borde: #2a2e3d; --acento: #3fe6ff; --tarjeta: #1a1d28; --chat: #0f1a17; --burbuja: #1f2c28; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font-family: var(--display); }
main { max-width: 880px; margin: 0 auto; padding-inline: 20px; padding-block: 32px 48px; display: grid; gap: 28px; }
h1 { font-size: clamp(28px, 5vw, 40px); font-weight: 800; margin: 0; text-wrap: balance; }
p { margin: 0; color: var(--suave); line-height: 1.5; max-width: 62ch; }
.escenario { display: grid; grid-template-columns: auto 1fr; gap: 28px; align-items: center; }
@media (max-width: 640px) { .escenario { grid-template-columns: 1fr; justify-items: center; } }
.marco { position: relative; overflow: hidden; border-radius: 22px; background: linear-gradient(#cdcede, #f4f3fc); max-width: 100%; flex-shrink: 0; }
.capa { position: absolute; inset: 0; width: 100%; height: 100%; }
.estados { display: grid; gap: 12px; }
.botones { display: flex; flex-wrap: wrap; gap: 8px; }
button { font: inherit; font-weight: 700; border: 1px solid var(--borde); background: var(--tarjeta); color: var(--fg); border-radius: 999px; padding: 8px 16px; cursor: pointer; }
button[aria-pressed="true"] { border-color: var(--acento); box-shadow: 0 0 0 2px var(--acento) inset; }
button:focus-visible { outline: 3px solid var(--acento); outline-offset: 2px; }
.lista { margin: 0; padding-left: 18px; color: var(--suave); display: grid; gap: 4px; }
.chat { background: var(--chat); border-radius: 16px; padding: 16px; display: grid; gap: 10px; }
.fila { display: flex; align-items: flex-end; gap: 10px; }
.burbuja { background: var(--burbuja); color: var(--fg); border-radius: 12px; padding: 8px 12px; font-size: 14px; line-height: 1.45; max-width: 46ch; box-shadow: 0 1px 1px rgba(0,0,0,.08); min-width: 0; }
.etiqueta { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--suave); font-weight: 700; }
${animaciones}
</style>
<main>
  <div><div class="etiqueta">Bot de Renovaciones</div><h1>Tracky en movimiento</h1></div>
  <section class="escenario">
    <div id="grande">${tracky(380, "normal")}</div>
    <div class="estados">
      <p>Es el render original de Tracky con la cara redibujada en vectores encima, para poder animarla sin tocar el resto del dibujo.</p>
      <ul class="lista">
        <li>Flota suave sobre su sombra.</li>
        <li>Los corazones laten y parpadean cada pocos segundos.</li>
        <li>El pin de GPS de la cabeza emite señal.</li>
        <li>Mientras responde, mueve la boca.</li>
      </ul>
      <div class="botones" role="group" aria-label="Estado de Tracky">
        <button id="b-normal" aria-pressed="true" data-e="normal">Esperando</button>
        <button id="b-hablando" aria-pressed="false" data-e="hablando">Escribiendo</button>
        <button id="b-feliz" aria-pressed="false" data-e="feliz">Feliz (renovó)</button>
      </div>
    </div>
  </section>
  <section class="chat" aria-label="Ejemplo en el chat del panel">
    <div class="etiqueta">Así se ve en el chat del panel</div>
    <div class="fila">${tracky(56, "normal")}<div class="burbuja">Hola Alex Meléndez 👋, soy Tracky, tu bot de Tracklink. Quiero informarte que el servicio asociado a la patente PRBA-01 vence el 5 de diciembre.</div></div>
    <div class="fila">${tracky(56, "hablando")}<div class="burbuja">Tracky está escribiendo…</div></div>
  </section>
</main>
<script>
  const grande = document.querySelector("#grande .tk-tracky");
  document.querySelectorAll("button[data-e]").forEach(b => b.addEventListener("click", () => {
    grande.classList.remove("tk-normal", "tk-hablando", "tk-feliz");
    grande.classList.add("tk-" + b.dataset.e);
    document.querySelectorAll("button[data-e]").forEach(o => o.setAttribute("aria-pressed", String(o === b)));
  }));
</script>`;
fs.writeFileSync(salida, html, "utf8");
console.log(`${salida} (${Math.round(html.length / 1024)} KB)`);
