"use client";

import { CABEZA, CUERPO, trackyCaraSvg } from "./trackyOverlay";

// Tracky, la asistente del Bot de Renovaciones, animada sobre los renders del
// diseñador. Animaciones en globals.css (clases tk-*); respetan
// prefers-reduced-motion.
//   - TrackyAnimado: cuerpo entero (flota, ojos que se achinan, mejillas, pin GPS).
//   - TrackyAvatar: solo la cabeza en un círculo, para el chat; cada tanto gira
//     a perfil y vuelve (dos cuadros: frente y perfil).
// En estado "hablando" mueve la boca.
export type EstadoTracky = "normal" | "hablando" | "feliz";

const CARA_CUERPO = trackyCaraSvg(CUERPO);
const CARA_CABEZA = trackyCaraSvg(CABEZA);

export default function TrackyAnimado({ alto = 160, estado = "normal", className = "" }: {
  alto?: number;
  estado?: EstadoTracky;
  className?: string;
}) {
  const ancho = Math.round((alto * CUERPO.ancho) / CUERPO.alto);
  return (
    <div
      className={`tk-tracky tk-${estado} relative overflow-hidden shrink-0 rounded-xl ${className}`}
      style={{ width: ancho, height: alto, background: "linear-gradient(#cdcede, #f4f3fc)" }}
      role="img"
      aria-label="Tracky, la asistente de renovaciones"
    >
      <div className="tk-flota absolute inset-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/tracky.webp" alt="" width={ancho} height={alto} className="absolute inset-0 w-full h-full select-none" draggable={false} />
        <svg viewBox={`0 0 ${CUERPO.ancho} ${CUERPO.alto}`} className="absolute inset-0 w-full h-full" aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: CARA_CUERPO }} />
      </div>
    </div>
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
        <div className="tk-giro-frente absolute inset-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/tracky-cabeza.webp" alt="" className="absolute inset-0 w-full h-full select-none" draggable={false} />
          <svg viewBox={`0 0 ${CABEZA.ancho} ${CABEZA.alto}`} className="absolute inset-0 w-full h-full" aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: CARA_CABEZA }} />
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/tracky-perfil.webp" alt="" className="tk-giro-perfil absolute inset-0 w-full h-full select-none" draggable={false} />
      </div>
    </div>
  );
}
