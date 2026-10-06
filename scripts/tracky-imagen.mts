// Genera public/tracky.webp desde el render original y, opcionalmente, una
// vista de control con la cara vectorial encima (para revisar que calce).
//   npx tsx scripts/tracky-imagen.mts <ruta Tracky.jpeg> [carpeta-control]
import sharp from "sharp";
import { trackyCaraSvg } from "../app/components/trackyOverlay";

const [src, control] = process.argv.slice(2);
await sharp(src).resize(512, 768).webp({ quality: 86 }).toFile("public/tracky.webp");
if (control) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536" viewBox="0 0 1024 1536">${trackyCaraSvg({ clases: false })}</svg>`;
  const recorte = { left: 180, top: 100, width: 680, height: 620 };
  // sharp aplica extract antes que composite: componer primero a un buffer.
  const compuesto = await sharp(src).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  await sharp(compuesto).extract(recorte).png().toFile(`${control}/tracky-overlay.png`);
  await sharp(src).extract(recorte).png().toFile(`${control}/tracky-original.png`);
}
console.log("ok");
