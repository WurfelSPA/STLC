"use server";

import { getSupabaseAdmin } from "@/app/lib/supabaseAdmin";
import { getSession } from "@/app/lib/session";

// Lecturas/escrituras de las tablas "Tracklink" y "MZDConnect" (PII de
// clientes: RUT, teléfono, correo, dirección) para las páginas del panel.
// Antes se hacían desde el navegador con la anon key hardcodeada y policies
// RLS abiertas a "public" — cualquiera con la key (visible en el bundle JS)
// podía leer y modificar toda la base. Ahora todo pasa por acá, server-side
// con service_role y exigiendo sesión; las policies anon se eliminaron.
export type TablaUnidades = "Tracklink" | "MZDConnect";
type Fila = Record<string, unknown>;

const TABLAS: TablaUnidades[] = ["Tracklink", "MZDConnect"];

async function exigirSesion() {
  const session = await getSession();
  if (!session) throw new Error("No autorizado");
}

function validarTabla(tabla: string): TablaUnidades {
  if (!TABLAS.includes(tabla as TablaUnidades)) throw new Error("Tabla inválida");
  return tabla as TablaUnidades;
}

export async function listarUnidadesAction(tabla: TablaUnidades): Promise<{ data: Fila[]; error?: string }> {
  await exigirSesion();
  const supabase = getSupabaseAdmin();
  const t = validarTabla(tabla);
  const pageSize = 1000;
  let todos: Fila[] = [];
  for (let desde = 0; ; desde += pageSize) {
    const { data, error } = await supabase.from(t).select("*").range(desde, desde + pageSize - 1);
    if (error) return { data: todos, error: error.message };
    if (!data || data.length === 0) break;
    todos = todos.concat(data);
    if (data.length < pageSize) break;
  }
  return { data: todos };
}

// Misma lógica de búsqueda que tenía app/page.tsx en el cliente: exacto por
// IMEI/Cust ID/Serie SIM, luego placa (con y sin guión), luego parcial por
// Cliente/Empresa y Usuario. Busca primero en Tracklink y después en MZDConnect.
export async function buscarUnidadesAction(query: string): Promise<{ resultados: Fila[]; tabla: TablaUnidades | null }> {
  await exigirSesion();
  const q = query.trim();
  if (!q) return { resultados: [], tabla: null };
  const supabase = getSupabaseAdmin();
  const qUpper = q.toUpperCase();
  // Evita que comas/paréntesis rompan el filtro .or() de PostgREST.
  const qLike = q.replace(/[,()]/g, " ");

  const buscarEnTabla = async (tabla: TablaUnidades): Promise<Fila[]> => {
    for (const campo of ["IMEI", "Cust ID", "Serie SIM"]) {
      const { data } = await supabase.from(tabla).select("*").eq(campo, q);
      if (data && data.length > 0) return data;
    }
    const placas = [qUpper];
    if (!qUpper.includes("-")) {
      const conGuion = qUpper.replace(/^([A-Z]+)(\d+)$/, "$1-$2");
      if (conGuion !== qUpper) placas.push(conGuion);
    }
    for (const placa of placas) {
      const { data } = await supabase.from(tabla).select("*").eq("Placa", placa);
      if (data && data.length > 0) return data;
    }
    const [resCliente, resUsuario] = await Promise.all([
      supabase.from(tabla).select("*").filter('"Cliente/Empresa"', "ilike", `%${qLike}%`),
      supabase.from(tabla).select("*").ilike("Usuario", `%${qLike}%`),
    ]);
    const combinados = [...(resCliente.data || []), ...(resUsuario.data || [])];
    return Array.from(new Map(combinados.map(u => [String(u.IMEI), u])).values());
  };

  for (const tabla of TABLAS) {
    const resultados = await buscarEnTabla(tabla);
    if (resultados.length > 0) return { resultados, tabla };
  }
  return { resultados: [], tabla: null };
}

export async function guardarComentarioAction(tabla: TablaUnidades, imei: string, comentarios: string): Promise<{ error?: string }> {
  await exigirSesion();
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(validarTabla(tabla)).update({ Comentarios: comentarios }).eq("IMEI", imei);
  return error ? { error: error.message } : {};
}
