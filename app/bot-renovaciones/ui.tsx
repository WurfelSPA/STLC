"use client";

import type { Estado, Prioridad } from "@/app/lib/renovaciones/tipos";
import { ESTADO_LABEL } from "@/app/lib/renovaciones/tipos";

export const COLOR_ESTADO: Record<Estado, string> = {
  PENDIENTE: "bg-gray-100 text-gray-700 border-gray-300",
  CONTACTADO: "bg-sky-50 text-sky-800 border-sky-200",
  EN_CONVERSACION: "bg-indigo-50 text-indigo-800 border-indigo-200",
  INTERESADO: "bg-violet-50 text-violet-800 border-violet-200",
  PAGO_PENDIENTE: "bg-amber-50 text-amber-800 border-amber-200",
  PAGO_POR_VALIDAR: "bg-orange-100 text-orange-900 border-orange-300",
  RENOVADO: "bg-green-100 text-green-800 border-green-300",
  NO_RENUEVA: "bg-red-50 text-red-800 border-red-200",
  CAMBIO_VEHICULO: "bg-teal-50 text-teal-800 border-teal-200",
  REQUIERE_EJECUTIVO: "bg-pink-50 text-pink-800 border-pink-200",
  SIN_RESPUESTA: "bg-stone-200 text-stone-800 border-stone-300",
};

export function BadgeEstado({ estado }: { estado: Estado }) {
  return <span className={`text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap ${COLOR_ESTADO[estado]}`}>{ESTADO_LABEL[estado]}</span>;
}

const COLOR_PRIORIDAD: Record<Prioridad, string> = {
  ALTA: "bg-red-600 text-white",
  MEDIA: "bg-amber-400 text-black",
  BAJA: "bg-gray-300 text-gray-800",
};

export function BadgePrioridad({ p }: { p: Prioridad }) {
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${COLOR_PRIORIDAD[p]}`}>{p}</span>;
}

export function fechaCorta(f: string) {
  const [y, m, d] = f.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export function pesosCL(n: number) {
  return "$" + n.toLocaleString("es-CL");
}
