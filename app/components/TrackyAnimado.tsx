"use client";

import { CABEZA, CABEZA_COMPLETA, trackyCaraSvg } from "./trackyOverlay";
import { ESCENARIO, marionetaHtml } from "./trackyPiezas";

// Tracky, la asistente del Bot de Renovaciones, animada con las piezas del
// diseñador. Animaciones en globals.css (clases tk-*); respetan
// prefers-reduced-motion.
//   - TrackyAnimado: cuerpo entero armado como marioneta (saluda con un brazo,
//     el otro se mece, la cabeza se mueve de lado a lado, el cuerpo respira
//     sobre las ruedas, la cara se anima).
//   - TrackyAvatar: solo la cabeza en un círculo, para el chat; se mece.
//   (El giro de cabeza a perfil se probó y se descartó a pedido de Tracklink.)
// En estado "hablando" mueve la boca; en "feliz" saluda más seguido.
export type EstadoTracky = "normal" | "hablando" | "feliz";

const CARA_CABEZA = trackyCaraSvg(CABEZA);
const MARIONETA = marionetaHtml(id => `/tracky/${id}.webp`, trackyCaraSvg(CABEZA_COMPLETA));

export default function TrackyAnimado({ alto = 160, estado = "normal", className = "" }: {
  alto?: number;
  estado?: EstadoTracky;
  className?: string;
}) {
  const ancho = Math.round((alto * ESCENARIO.ancho) / ESCENARIO.alto);
  return (
    <div
      className={`tk-tracky tk-${estado} tk-marioneta relative overflow-hidden shrink-0 rounded-xl bg-white ${className}`}
      style={{ width: ancho, height: alto }}
      role="img"
      aria-label="Tracky, la asistente de renovaciones"
      dangerouslySetInnerHTML={{ __html: MARIONETA }}
    />
  );
}

export function TrackyAvatar({ tamano = 48, estado = "normal", className = "" }: {
  tamano?: number;
  estado?: EstadoTracky;
  className?: string;
}) {
  return (
    <div
      className={`tk-tracky tk-${estado} relative overflow-hidden shrink-0 rounded-full bg-white ring-1 ring-black/5 ${className}`}
      style={{ width: tamano, height: tamano }}
      role="img"
      aria-label="Tracky, la asistente de renovaciones"
    >
      <div className="tk-mece absolute inset-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/tracky-cabeza.webp" alt="" className="absolute inset-0 w-full h-full select-none" draggable={false} />
        <svg viewBox={`0 0 ${CABEZA.ancho} ${CABEZA.alto}`} className="absolute inset-0 w-full h-full" aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: CARA_CABEZA }} />
      </div>
    </div>
  );
}
