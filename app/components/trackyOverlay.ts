// Capa SVG de la cara de Tracky, en coordenadas de la imagen original
// (public/tracky.webp, 1024×1536). Tapa los ojos-corazón y la boca del render
// con el negro de la pantalla y los vuelve a dibujar como vectores, para
// poder animarlos (latido, parpadeo, hablar) sin tocar el resto del dibujo.
// Medidas sacadas del render con sharp (componentes rosados/cian).

export const TRACKY_ANCHO = 1024;
export const TRACKY_ALTO = 1536;

const CORAZON = "M50 88 C 20 65, 0 45, 0 27 C 0 10, 13 0, 28 0 C 38 0, 46 6, 50 14 C 54 6, 62 0, 72 0 C 87 0, 100 10, 100 27 C 100 45, 80 65, 50 88 Z";

export function trackyCaraSvg(opts: { clases?: boolean } = {}): string {
  const c = (nombre: string) => (opts.clases === false ? "" : ` class="${nombre}"`);
  return `
<defs>
  <radialGradient id="tk-tapa" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#141316"/><stop offset="72%" stop-color="#141316"/><stop offset="100%" stop-color="#141316" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="tk-rosa" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ffb8f1"/><stop offset="100%" stop-color="#ff62d4"/>
  </linearGradient>
  <filter id="tk-glow-rosa" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="14" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="tk-glow-cian" x="-50%" y="-80%" width="200%" height="260%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<g>
  <ellipse cx="393" cy="411" rx="114" ry="106" fill="url(#tk-tapa)"/>
  <ellipse cx="659" cy="459" rx="108" ry="100" fill="url(#tk-tapa)"/>
  <ellipse cx="508" cy="500" rx="68" ry="48" fill="url(#tk-tapa)"/>
</g>
<g filter="url(#tk-glow-rosa)" opacity="0.95">
  <ellipse cx="331" cy="472" rx="28" ry="17" fill="#ff7fd6"/>
  <ellipse cx="674" cy="554" rx="28" ry="16" fill="#ff7fd6"/>
</g>
<g>
  <g transform="translate(401 402) rotate(9)"><g${c("tk-ojos")}><g${c("tk-latido")}>
    <path d="${CORAZON}" transform="translate(-77 -66) scale(1.54 1.5)" fill="url(#tk-rosa)" filter="url(#tk-glow-rosa)"/>
    <ellipse cx="-38" cy="-36" rx="19" ry="11" fill="#ffffff" opacity="0.55" transform="rotate(-30 -38 -36)"/>
  </g></g></g>
  <g transform="translate(659 461) rotate(9)"><g${c("tk-ojos")}><g${c("tk-latido tk-latido-2")}>
    <path d="${CORAZON}" transform="translate(-74 -62) scale(1.48 1.42)" fill="url(#tk-rosa)" filter="url(#tk-glow-rosa)"/>
    <ellipse cx="-36" cy="-33" rx="18" ry="10" fill="#ffffff" opacity="0.55" transform="rotate(-30 -36 -33)"/>
  </g></g></g>
</g>
<g filter="url(#tk-glow-cian)"><path${c("tk-boca")} d="M466 476 Q508 575 551 490 Q508 507 466 476 Z" fill="#3fe6ff" stroke="#3fe6ff" stroke-width="9" stroke-linejoin="round"/></g>
<circle${c("tk-pulso")} cx="589" cy="166" r="28" fill="none" stroke="#3fe6ff" stroke-width="6" opacity="0"/>
<circle${c("tk-pulso tk-pulso-2")} cx="589" cy="166" r="28" fill="none" stroke="#3fe6ff" stroke-width="6" opacity="0"/>`;
}
