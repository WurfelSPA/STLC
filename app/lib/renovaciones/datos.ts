import "server-only";
import { getSupabaseAdmin } from "@/app/lib/supabaseAdmin";
import type { Caso, ConfigBot, ConfigLinea, Linea, Mensaje, Precio } from "./tipos";

// Acceso a las tablas renov_* (service_role; RLS sin policies).

export const LINEAS: Linea[] = ["TRACKLINK", "AUTOBAHN", "TRACKCITY"];

export async function cargarConfig(): Promise<ConfigBot> {
  const sb = getSupabaseAdmin();
  const [{ data: cfgRows }, { data: precioRows }] = await Promise.all([
    sb.from("renov_config").select("clave, valor"),
    sb.from("renov_precios").select("linea, meses, precio").eq("vigente", true).order("meses"),
  ]);
  const lineas = {} as Record<Linea, ConfigLinea>;
  const precios = {} as Record<Linea, Precio[]>;
  for (const l of LINEAS) {
    const row = cfgRows?.find(r => r.clave === `linea:${l}`);
    lineas[l] = (row?.valor as ConfigLinea) ?? { nombre: l, link_pago: null, transferencia: null };
    precios[l] = (precioRows ?? []).filter(p => p.linea === l).map(p => ({ meses: p.meses, precio: p.precio }));
  }
  const general = (cfgRows?.find(r => r.clave === "general")?.valor ?? {}) as { call_center?: string | null };
  return { lineas, precios, callCenter: general.call_center ?? null };
}

export async function cargarGeneral(): Promise<{ usuarios_excluidos: string[] }> {
  const { data } = await getSupabaseAdmin().from("renov_config").select("valor").eq("clave", "general").maybeSingle();
  const v = (data?.valor ?? {}) as { usuarios_excluidos?: string[] };
  return { usuarios_excluidos: v.usuarios_excluidos ?? [] };
}

export async function cargarSegmentos() {
  const { data } = await getSupabaseAdmin().from("renov_segmentos").select("*");
  return (data ?? []) as { servicio_comercial: string; linea: Linea; cotiza_bot: boolean; excluir: boolean; nota: string | null }[];
}

export async function obtenerCaso(id: string): Promise<Caso | null> {
  const { data } = await getSupabaseAdmin().from("renov_casos").select("*").eq("id", id).maybeSingle();
  return (data as Caso) ?? null;
}

// Caso abierto más reciente para un teléfono (mensajes entrantes de WhatsApp).
export async function obtenerCasoPorTelefono(telefono: string, simulacion: boolean): Promise<Caso | null> {
  const { data } = await getSupabaseAdmin().from("renov_casos").select("*")
    .eq("telefono", telefono).eq("simulacion", simulacion)
    .order("fecha_vencimiento", { ascending: false }).limit(1).maybeSingle();
  return (data as Caso) ?? null;
}

export async function actualizarCaso(id: string, patch: Partial<Caso>) {
  const { error } = await getSupabaseAdmin().from("renov_casos")
    .update({ ...patch, actualizado_en: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`No se pudo actualizar el caso: ${error.message}`);
}

export async function registrarMensaje(m: Omit<Mensaje, "id" | "creado_en" | "meta"> & { meta?: Record<string, unknown> }) {
  const { error } = await getSupabaseAdmin().from("renov_mensajes").insert({ ...m, meta: m.meta ?? {} });
  if (error) console.error("[renovaciones] no se pudo registrar mensaje:", error.message);
}

export async function mensajesDeCaso(casoId: string): Promise<Mensaje[]> {
  const { data } = await getSupabaseAdmin().from("renov_mensajes").select("*")
    .eq("caso_id", casoId).order("creado_en").order("id");
  return (data ?? []) as Mensaje[];
}

export async function listarCasos(filtro: { simulacion: boolean; desde?: string; hasta?: string }): Promise<Caso[]> {
  const sb = getSupabaseAdmin();
  let todos: Caso[] = [];
  for (let desde = 0; ; desde += 1000) {
    let q = sb.from("renov_casos").select("*").eq("simulacion", filtro.simulacion);
    if (filtro.desde) q = q.gte("fecha_vencimiento", filtro.desde);
    if (filtro.hasta) q = q.lte("fecha_vencimiento", filtro.hasta);
    const { data, error } = await q.order("fecha_vencimiento").range(desde, desde + 999);
    if (error) throw new Error(error.message);
    todos = todos.concat((data ?? []) as Caso[]);
    if (!data || data.length < 1000) break;
  }
  return todos;
}

// Modo del bot: "simulacion" (default) no envía nada por WhatsApp — los
// mensajes quedan en renov_mensajes y se ven en el simulador del panel.
export function modoSimulacion(): boolean {
  return process.env.RENOV_BOT_MODO !== "produccion";
}
