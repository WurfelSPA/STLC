// Capa SVG de la cara de Tracky (diseño "feliz" del 9-oct: ojos en arco cian,
// mejillas rosadas, boca abierta). Tapa los rasgos del render con el negro de
// la pantalla y los redibuja como vectores para poder animarlos (ojos que se
// achinan, boca que habla, mejillas que brillan, pin GPS con señal) sin tocar
// el resto del dibujo. Medidas sacadas de cada imagen con sharp
// (scripts/tracky-imagen.mts genera una vista de control para revisar el calce).

type Pt = [number, number];
type Ojo = { p0: Pt; c: Pt; p2: Pt; grosor: number };
type Caja = { x: number; y: number; w: number; h: number };
type Elipse = { cx: number; cy: number; rx: number; ry: number };

export type GeometriaTracky = {
  id: string;            // prefijo de ids SVG (dos Tracky en la misma página)
  ancho: number;
  alto: number;
  pantalla: string;      // color del negro de la pantalla en esa imagen
  ojos: [Ojo, Ojo];
  boca: Caja;
  mejillas: [Elipse, Elipse];
  tapas: Elipse[];       // zonas que se cubren (ojos y boca originales)
  pin?: { cx: number; cy: number; r: number };
  brillo: number;        // radio del desenfoque del brillo neón
};

// Tracky de cuerpo entero: public/tracky.webp (render 1024×1536).
export const CUERPO: GeometriaTracky = {
  id: "tkc", ancho: 1024, alto: 1536, pantalla: "#18191b", brillo: 10,
  ojos: [
    { p0: [324, 393], c: [385, 333], p2: [458, 418], grosor: 26 },
    { p0: [582, 444], c: [643, 390], p2: [712, 476], grosor: 26 },
  ],
  boca: { x: 473, y: 452, w: 77, h: 58 },
  mejillas: [{ cx: 339, cy: 442, rx: 33, ry: 20 }, { cx: 674, cy: 519, rx: 32, ry: 19 }],
  tapas: [{ cx: 390, cy: 390, rx: 92, ry: 60 }, { cx: 646, cy: 447, rx: 88, ry: 62 }, { cx: 511, cy: 481, rx: 56, ry: 46 }],
  pin: { cx: 589, cy: 166, r: 28 },
};

// Solo la cabeza, de frente: public/tracky-cabeza.webp (427×427, recorte del original 427×640 desde y=95).
const DY_CABEZA = 95;
export const CABEZA: GeometriaTracky = {
  id: "tkh", ancho: 427, alto: 427, pantalla: "#131514", brillo: 6,
  ojos: [
    { p0: [101, 325 - DY_CABEZA], c: [135, 295 - DY_CABEZA], p2: [178, 333 - DY_CABEZA], grosor: 15 },
    { p0: [252, 344 - DY_CABEZA], c: [285, 318 - DY_CABEZA], p2: [326, 356 - DY_CABEZA], grosor: 15 },
  ],
  boca: { x: 189, y: 354 - DY_CABEZA, w: 46, h: 32 },
  mejillas: [{ cx: 110, cy: 354 - DY_CABEZA, rx: 19, ry: 11 }, { cx: 308, cy: 384 - DY_CABEZA, rx: 19, ry: 11 }],
  tapas: [
    { cx: 140, cy: 320 - DY_CABEZA, rx: 54, ry: 36 }, { cx: 289, cy: 341 - DY_CABEZA, rx: 52, ry: 36 },
    { cx: 212, cy: 370 - DY_CABEZA, rx: 34, ry: 27 },
  ],
  pin: { cx: 237, cy: 184 - DY_CABEZA, r: 16 },
};

// Misma cabeza, en el original completo (427×640): la usa la marioneta, que
// posiciona cada pieza con su imagen entera.
export const CABEZA_COMPLETA: GeometriaTracky = desplazar({ ...CABEZA, id: "tkm" }, DY_CABEZA, 640);

function desplazar(g: GeometriaTracky, dy: number, alto: number): GeometriaTracky {
  const p = ([x, y]: Pt): Pt => [x, y + dy];
  return {
    ...g, alto,
    ojos: g.ojos.map(o => ({ ...o, p0: p(o.p0), c: p(o.c), p2: p(o.p2) })) as [Ojo, Ojo],
    boca: { ...g.boca, y: g.boca.y + dy },
    mejillas: g.mejillas.map(e => ({ ...e, cy: e.cy + dy })) as [Elipse, Elipse],
    tapas: g.tapas.map(e => ({ ...e, cy: e.cy + dy })),
    pin: g.pin && { ...g.pin, cy: g.pin.cy + dy },
  };
}

// Boca abierta (media luna con borde superior recto e inclinado), en su caja.
function pathBoca({ x, y, w, h }: Caja): string {
  const X = (f: number) => (x + f * w).toFixed(1), Y = (f: number) => (y + f * h).toFixed(1);
  return `M${X(0)} ${Y(0.04)} L${X(1)} ${Y(0.31)} C${X(1.03)} ${Y(0.83)} ${X(0.75)} ${Y(1)} ${X(0.46)} ${Y(0.99)} ` +
    `C${X(0.17)} ${Y(0.98)} ${X(0)} ${Y(0.66)} ${X(0)} ${Y(0.04)} Z`;
}

export function trackyCaraSvg(g: GeometriaTracky, opts: { clases?: boolean } = {}): string {
  const c = (nombre: string) => (opts.clases === false ? "" : ` class="${nombre}"`);
  const id = (n: string) => `${g.id}-${n}`;
  const tapas = g.tapas.map(e => `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="url(#${id("tapa")})"/>`).join("");
  const mejillas = g.mejillas.map(e => `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="#ff6fd0"/>`).join("");
  const ojos = g.ojos.map(o =>
    `<g${c("tk-ojos")}><path d="M${o.p0[0]} ${o.p0[1]} Q${o.c[0]} ${o.c[1]} ${o.p2[0]} ${o.p2[1]}" fill="none" stroke="#3fe6ff" stroke-width="${o.grosor}" stroke-linecap="round"/></g>`).join("");
  const pin = g.pin
    ? `<circle${c("tk-pulso")} cx="${g.pin.cx}" cy="${g.pin.cy}" r="${g.pin.r}" fill="none" stroke="#3fe6ff" stroke-width="${g.pin.r / 5}" opacity="0"/>` +
      `<circle${c("tk-pulso tk-pulso-2")} cx="${g.pin.cx}" cy="${g.pin.cy}" r="${g.pin.r}" fill="none" stroke="#3fe6ff" stroke-width="${g.pin.r / 5}" opacity="0"/>`
    : "";
  return `
<defs>
  <radialGradient id="${id("tapa")}" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="${g.pantalla}"/><stop offset="74%" stop-color="${g.pantalla}"/><stop offset="100%" stop-color="${g.pantalla}" stop-opacity="0"/>
  </radialGradient>
  <filter id="${id("glow")}" x="-50%" y="-80%" width="200%" height="260%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="${g.brillo}" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<g>${tapas}</g>
<g${c("tk-mejillas")} filter="url(#${id("glow")})" opacity="0.95">${mejillas}</g>
<g filter="url(#${id("glow")})">${ojos}</g>
<g filter="url(#${id("glow")})"><path${c("tk-boca")} d="${pathBoca(g.boca)}" fill="#3fe6ff" stroke="#3fe6ff" stroke-width="${Math.round(g.boca.h / 7)}" stroke-linejoin="round"/></g>
${pin}`;
}
