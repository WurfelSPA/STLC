// Prepara las piezas de Tracky (cabeza, perfil, tronco, brazos, rueda) para
// armarlo como marioneta: fondo blanco -> transparente y WebP en
// public/tracky/. Opcionalmente deja una vista de control de cada pieza sobre
// magenta y el armado completo, para revisar recortes y posiciones.
//   npx tsx scripts/tracky-piezas.mts <carpeta originales> [carpeta-control]
import sharp from "sharp";
import fs from "node:fs";
import { PIEZAS, ESCENARIO, posicionPieza } from "../app/components/trackyPiezas";

const [dir, control] = process.argv.slice(2);
fs.mkdirSync("public/tracky", { recursive: true });

// Relleno desde los bordes sobre píxeles casi blancos (umbral estricto: la
// carcasa también es blanca; lo que se pierda de ella queda sobre el
// escenario blanco y no se nota). Borde suave de 236 a 248.
async function sinFondo(archivo: string) {
  const { data, info } = await sharp(archivo).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const claro = (p: number) => Math.min(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
  const visto = new Uint8Array(W * H);
  const pila: number[] = [];
  for (let x = 0; x < W; x++) pila.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) pila.push(y * W, y * W + W - 1);
  while (pila.length) {
    const p = pila.pop()!;
    if (visto[p] || claro(p) < 236) continue;
    visto[p] = 1;
    data[p * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, (248 - claro(p)) / 12)));
    const x = p % W, y = (p / W) | 0;
    if (x > 0) pila.push(p - 1);
    if (x < W - 1) pila.push(p + 1);
    if (y > 0) pila.push(p - W);
    if (y < H - 1) pila.push(p + W);
  }
  return sharp(data, { raw: { width: W, height: H, channels: 4 } });
}

for (const p of PIEZAS) {
  const img = await sinFondo(`${dir}/${p.original}`);
  const salida = img.clone();
  if (p.espejo) salida.flop();
  await salida.webp({ quality: 88, alphaQuality: 90 }).toFile(`public/tracky/${p.id}.webp`);
  if (control) await sharp(`public/tracky/${p.id}.webp`).flatten({ background: "#ff00ff" }).png().toFile(`${control}/pieza-${p.id}.png`);
}

if (control) {
  // Armado de control (sin animación) sobre blanco, en el orden de capas.
  // Lienzo con margen (sharp no acepta posiciones negativas) y recorte final.
  const M = 400;
  const capas = [];
  for (const p of [...PIEZAS].filter(p => p.id !== "perfil").sort((a, b) => a.capa - b.capa)) {
    const pos = posicionPieza(p);
    const w = Math.round(pos.ancho), h = Math.round(pos.ancho * (p.alto / p.ancho));
    capas.push({ input: await sharp(`public/tracky/${p.id}.webp`).resize(w, h).png().toBuffer(), left: Math.round(pos.x) + M, top: Math.round(pos.y) + M });
  }
  const lienzo = await sharp({ create: { width: ESCENARIO.ancho + 2 * M, height: ESCENARIO.alto + 2 * M, channels: 4, background: "#ffffff" } })
    .composite(capas).png().toBuffer();
  const recorte = await sharp(lienzo).extract({ left: M, top: M, width: ESCENARIO.ancho, height: ESCENARIO.alto }).png().toBuffer();
  await sharp(recorte).resize(512).png().toFile(`${control}/armado.png`);
}
console.log("ok");
