// Helpers puros de formato/fechas/normalización (sin dependencias de servidor).

import type { Caso, Prioridad } from "./tipos";

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// "Hoy" en Chile como YYYY-MM-DD — el cron corre en UTC y el vencimiento es
// una fecha calendario chilena.
export function hoyChile(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
}

export function diasEntre(desde: string, hasta: string): number {
  const a = Date.UTC(+desde.slice(0, 4), +desde.slice(5, 7) - 1, +desde.slice(8, 10));
  const b = Date.UTC(+hasta.slice(0, 4), +hasta.slice(5, 7) - 1, +hasta.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export function sumarMeses(fecha: string, meses: number): string {
  const d = new Date(Date.UTC(+fecha.slice(0, 4), +fecha.slice(5, 7) - 1 + meses, +fecha.slice(8, 10)));
  return d.toISOString().slice(0, 10);
}

// 2026-10-10 -> "10 de octubre" (o "10 de octubre de 2027" con año)
export function fechaLarga(fecha: string, conAnio = false): string {
  const dia = +fecha.slice(8, 10);
  const mes = MESES[+fecha.slice(5, 7) - 1];
  return conAnio ? `${dia} de ${mes} de ${fecha.slice(0, 4)}` : `${dia} de ${mes}`;
}

export function pesos(n: number): string {
  return "$" + n.toLocaleString("es-CL");
}

// Teléfonos de TrackGTS vienen como 9XXXXXXXX, 569XXXXXXXX, con +, espacios...
// Devuelve 569XXXXXXXX (formato WhatsApp sin "+") o null si no es móvil chileno.
export function normalizarTelefono(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (/^569\d{8}$/.test(d)) return d;
  if (/^9\d{8}$/.test(d)) return "56" + d;
  return null;
}

// RUT empresa: cuerpo >= 50.000.000 (convención SII). "Cust ID" viene con y
// sin guión/DV, a veces basura ("123") -> persona por defecto.
export function esRutEmpresa(raw: string | null | undefined): boolean {
  const s = String(raw ?? "").toUpperCase().replace(/[^0-9K]/g, "");
  if (s.length < 8) return false;
  const cuerpo = Number(s.slice(0, -1));
  return cuerpo >= 50_000_000;
}

export function sinAcentos(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export function nombreCorto(c: Pick<Caso, "nombre" | "usuario">): string {
  const n = (c.nombre ?? "").trim();
  return n || c.usuario;
}

export function patentes(c: Pick<Caso, "vehiculos">): string {
  return c.vehiculos.map(v => v.placa || "(sin patente)").join(", ");
}

// Prioridad para la cola del ejecutivo (sección 6 del spec).
export function calcularPrioridad(c: Caso, hoy: string): Prioridad {
  const dias = diasEntre(hoy, c.fecha_vencimiento);
  const motivo = (c.motivo ?? "").toLowerCase();
  if (["INTERESADO", "PAGO_PENDIENTE", "PAGO_POR_VALIDAR"].includes(c.estado)) return "ALTA"; // quiere renovar
  if (c.contexto?.origen === "C") return "ALTA";                                           // solicitó ejecutivo
  if (motivo.includes("precio") || motivo.includes("descuento")) return "ALTA";            // cancela por precio
  if (c.cantidad_vehiculos > 1 || c.tipo_cliente === "empresa") return "ALTA";             // corporativo
  if (dias <= 3) return "ALTA";
  if (c.requiere_ejecutivo || c.respondio) return "MEDIA";                                 // consultó / evaluando
  return "BAJA";                                                                           // no respondió / >15 días
}
