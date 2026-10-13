// Armado de Tracky como marioneta a partir de las piezas del diseñador
// (cada original es 427×640 con la pieza sobre fondo blanco; ver
// scripts/tracky-piezas.mts). Escenario en coordenadas de 1024×1536, las
// mismas del render de cuerpo entero, para respetar sus proporciones.

export const ESCENARIO = { ancho: 1024, alto: 1536 };

export type Pieza = {
  id: string;
  original: string;
  ancho: number; alto: number;                 // tamaño del original
  caja: { x: number; y: number; w: number; h: number };   // la pieza dentro del original
  destino: { x: number; y: number; w: number };            // dónde va su caja en el escenario
  capa: number;                                // orden de pintado (mayor = encima)
  espejo?: boolean;
  pivote?: [number, number];                   // punto de giro, en % de la imagen (para brazos/cabeza)
};

const ORIG = { ancho: 427, alto: 640 };

export const PIEZAS: Pieza[] = [
  { id: "rueda-izq", original: "Tracky_rueda.jpg", ...ORIG, caja: { x: 49, y: 113, w: 322, h: 411 },
    destino: { x: 232, y: 1080, w: 190 }, capa: 1 },
  { id: "rueda-der", original: "Tracky_rueda.jpg", ...ORIG, caja: { x: 56, y: 113, w: 322, h: 411 },
    destino: { x: 602, y: 1080, w: 190 }, capa: 1, espejo: true },
  { id: "tronco", original: "Tracky_tronco.jpg", ...ORIG, caja: { x: 78, y: 94, w: 270, h: 451 },
    destino: { x: 312, y: 600, w: 400 }, capa: 2 },
  { id: "brazo-izq", original: "Tracky_brazo_derecho.jpg", ...ORIG, caja: { x: 25, y: 115, w: 380, h: 390 },
    destino: { x: 70, y: 640, w: 290 }, capa: 3, pivote: [78, 27] },
  { id: "brazo-der", original: "Tracky_brazo_izquierdo.jpg", ...ORIG, caja: { x: 12, y: 122, w: 408, h: 360 },
    destino: { x: 664, y: 640, w: 305 }, capa: 3, pivote: [21, 27] },
  { id: "cabeza", original: "Tracky_cabeza.jpg", ...ORIG, caja: { x: 8, y: 150, w: 411, h: 306 },
    destino: { x: 167, y: 112, w: 690 }, capa: 4, pivote: [50, 72] },
  { id: "perfil", original: "Tracky_perfil.jpg", ...ORIG, caja: { x: 8, y: 150, w: 411, h: 306 },
    destino: { x: 167, y: 112, w: 690 }, capa: 4, pivote: [50, 72] },
];

// Posición del ORIGINAL completo (no solo la caja) en el escenario, para
// que la pieza caiga en su destino.
export function posicionPieza(p: Pieza) {
  const s = p.destino.w / p.caja.w;
  const cajaX = p.espejo ? p.ancho - (p.caja.x + p.caja.w) : p.caja.x;
  return { x: p.destino.x - cajaX * s, y: p.destino.y - p.caja.y * s, ancho: p.ancho * s, escala: s };
}

const pct = (n: number) => `${+n.toFixed(3)}%`;

function estilo(p: Pieza): string {
  const pos = posicionPieza(p);
  const alto = pos.ancho * (p.alto / p.ancho);
  const origen = p.pivote ? `;transform-origin:${p.pivote[0]}% ${p.pivote[1]}%` : "";
  return `left:${pct((pos.x / ESCENARIO.ancho) * 100)};top:${pct((pos.y / ESCENARIO.alto) * 100)};` +
    `width:${pct((pos.ancho / ESCENARIO.ancho) * 100)};height:${pct((alto / ESCENARIO.alto) * 100)}${origen}`;
}

const pieza = (id: string) => PIEZAS.find(p => p.id === id)!;

// HTML interno de la marioneta (lo usan el componente React y la vista
// previa autocontenida). `src` resuelve la URL de cada pieza; `cara` es el
// SVG de la cara para la cabeza completa (427×640). Animaciones: clases tk-m-*
// en globals.css.
export function marionetaHtml(src: (id: string) => string, cara: string): string {
  const img = (id: string, clase = "") =>
    `<img src="${src(id)}" alt="" draggable="false" class="tk-m-img ${clase}">`;
  // tk-m-escenario deja un margen proporcional para que la mano no se corte
  // en el punto alto del saludo.
  return `<div class="tk-m-escenario">
<div class="tk-m-pieza tk-m-rueda" style="${estilo(pieza("rueda-izq"))}">${img("rueda-izq")}</div>
<div class="tk-m-pieza tk-m-rueda" style="${estilo(pieza("rueda-der"))}">${img("rueda-der")}</div>
<div class="tk-m-cuerpo">
  <div class="tk-m-pieza" style="${estilo(pieza("tronco"))}">${img("tronco")}</div>
  <div class="tk-m-pieza tk-m-brazo-izq" style="${estilo(pieza("brazo-izq"))}">${img("brazo-izq")}</div>
  <div class="tk-m-pieza tk-m-brazo-der" style="${estilo(pieza("brazo-der"))}">${img("brazo-der")}</div>
  <div class="tk-m-pieza tk-m-cabeza" style="${estilo(pieza("cabeza"))}">
    ${img("cabeza")}<svg viewBox="0 0 427 640" class="tk-m-img" aria-hidden="true">${cara}</svg>
  </div>
</div>
</div>`;
}
