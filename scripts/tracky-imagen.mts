// Genera las imágenes web de Tracky desde los originales del diseñador y,
// opcionalmente, vistas de control con la cara vectorial encima (para revisar
// que calce):
//   npx tsx scripts/tracky-imagen.mts <carpeta originales> [carpeta-control]
// Originales esperados: Tracky.jpeg (cuerpo 1024×1536), Tracky_cabeza.jpg y
// Tracky_perfil.jpg (427×640, fondo blanco).
import sharp from "sharp";
import { CABEZA, CUERPO, trackyCaraSvg, type GeometriaTracky } from "../app/components/trackyOverlay";

const [dir, control] = process.argv.slice(2);
const RECORTE_CABEZA = { left: 0, top: 95, width: 427, height: 427 };

// La cabeza y el perfil se usan con su fondo blanco dentro de un avatar
// circular blanco: quitar el fondo automáticamente se come la carcasa, que
// es igual de blanca y no tiene borde oscuro que la separe.
await sharp(`${dir}/Tracky.jpeg`).resize(512, 768).webp({ quality: 86 }).toFile("public/tracky.webp");
await sharp(`${dir}/Tracky_cabeza.jpg`).extract(RECORTE_CABEZA).webp({ quality: 88 }).toFile("public/tracky-cabeza.webp");
await sharp(`${dir}/Tracky_perfil.jpg`).extract(RECORTE_CABEZA).webp({ quality: 88 }).toFile("public/tracky-perfil.webp");

if (control) {
  const vista = async (base: sharp.Sharp, g: GeometriaTracky, salida: string, recorte?: sharp.Region) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${g.ancho}" height="${g.alto}" viewBox="0 0 ${g.ancho} ${g.alto}">${trackyCaraSvg(g, { clases: false })}</svg>`;
    // sharp aplica extract antes que composite: componer primero a un buffer.
    const compuesto = await base.composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    const s = sharp(compuesto);
    await (recorte ? s.extract(recorte) : s).png().toFile(`${control}/${salida}`);
  };
  await vista(sharp(`${dir}/Tracky.jpeg`), CUERPO, "control-cuerpo.png", { left: 180, top: 100, width: 680, height: 620 });
  await vista(sharp(`${dir}/Tracky_cabeza.jpg`).extract(RECORTE_CABEZA), CABEZA, "control-cabeza.png");
}
console.log("ok");
