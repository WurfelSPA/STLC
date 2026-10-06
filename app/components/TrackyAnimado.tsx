"use client";

import { TRACKY_ALTO, TRACKY_ANCHO, trackyCaraSvg } from "./trackyOverlay";

// Tracky, la mascota del Bot de Renovaciones, animado sobre el render original
// (public/tracky.webp): flota, sus corazones laten y parpadean, el pin de GPS
// emite señal y, en estado "hablando", mueve la boca. Animaciones en
// globals.css (clases tk-*); respeta prefers-reduced-motion.
export type EstadoTracky = "normal" | "hablando" | "feliz";

const CARA = trackyCaraSvg();

export default function TrackyAnimado({ alto = 160, estado = "normal", fondo = true, className = "" }: {
  alto?: number;
  estado?: EstadoTracky;
  fondo?: boolean;            // fondo degradado igual al del render (oculta los bordes al flotar)
  className?: string;
}) {
  const ancho = Math.round((alto * TRACKY_ANCHO) / TRACKY_ALTO);
  return (
    <div
      className={`tk-tracky tk-${estado} relative overflow-hidden shrink-0 ${fondo ? "rounded-xl" : ""} ${className}`}
      style={{ width: ancho, height: alto, background: fondo ? "linear-gradient(#cdcede, #f4f3fc)" : undefined }}
      role="img"
      aria-label="Tracky, el bot de renovaciones"
    >
      <div className="tk-flota absolute inset-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/tracky.webp" alt="" width={ancho} height={alto} className="absolute inset-0 w-full h-full select-none" draggable={false} />
        <svg viewBox={`0 0 ${TRACKY_ANCHO} ${TRACKY_ALTO}`} className="absolute inset-0 w-full h-full" aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: CARA }} />
      </div>
    </div>
  );
}
