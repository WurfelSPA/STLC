"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/app/lib/supabaseAdmin";
import { hashPassword } from "@/app/lib/auth";
import { getSession } from "@/app/lib/session";

// Todas las acciones de este archivo gestionan las tablas del portal de
// pórticos (tracklink-porticos.vercel.app) desde el panel interno de STLC —
// solo el usuario "admin" puede llamarlas (ver el gate especial en actions.ts).
async function exigirAdmin() {
  const session = await getSession();
  if (!session || session.usuario !== "admin") {
    throw new Error("No autorizado");
  }
}

export type BuscarVehiculoResultado = {
  imei: string;
  unitId: number | null;
  placa: string;
  alias: string;
  clienteEmpresa: string;
};

// Busca en la tabla "Tracklink" (ya sincronizada por sync-tlchile.js, sin
// tocar TrackGTS en vivo) por placa, alias o cliente/empresa — así se puede
// agregar un vehículo que YA existe en Tracklink sin generar ningún login
// adicional a la cuenta.
export async function buscarVehiculoTracklinkAction(query: string): Promise<BuscarVehiculoResultado[]> {
  await exigirAdmin();
  const q = query.trim();
  if (q.length < 2) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("Tracklink")
    .select('"IMEI", "Unit ID", "Placa", "Alias", "Cliente/Empresa"')
    .or(`Placa.ilike.%${q}%,Alias.ilike.%${q}%,Cliente/Empresa.ilike.%${q}%`)
    .limit(20);

  if (error || !data) return [];
  return data.map((u: Record<string, unknown>) => ({
    imei: String(u["IMEI"] ?? ""),
    unitId: u["Unit ID"] != null ? Number(u["Unit ID"]) : null,
    placa: String(u["Placa"] ?? ""),
    alias: String(u["Alias"] ?? ""),
    clienteEmpresa: String(u["Cliente/Empresa"] ?? ""),
  }));
}

export type VehiculoActionState = { error?: string; success?: string } | undefined;

export async function agregarVehiculoPorticosAction(_state: VehiculoActionState, formData: FormData): Promise<VehiculoActionState> {
  await exigirAdmin();

  const origen = String(formData.get("origen") || "tracklink");
  if (origen !== "tracklink") {
    return { error: "GPS de terceros todavía no está implementado — por ahora solo se pueden agregar vehículos que ya existen en Tracklink." };
  }

  const patente = String(formData.get("patente") || "").trim().toUpperCase();
  const imei = String(formData.get("imei") || "").trim();
  const unitIdRaw = String(formData.get("unitId") || "").trim();
  const empresa = String(formData.get("empresa") || "").trim();

  if (!patente || !unitIdRaw) {
    return { error: "Faltan datos del vehículo — selecciónalo de la búsqueda de Tracklink." };
  }
  const unitId = parseInt(unitIdRaw, 10);
  if (!Number.isFinite(unitId)) {
    return { error: "Unit ID inválido." };
  }

  const supabase = getSupabaseAdmin();

  const { data: existente } = await supabase
    .from("porticos_vehiculos")
    .select("id")
    .eq("patente", patente)
    .maybeSingle();
  if (existente) {
    return { error: `La patente ${patente} ya está registrada en pórticos.` };
  }

  const { data: maxOrden } = await supabase
    .from("porticos_vehiculos")
    .select("orden")
    .order("orden", { ascending: false })
    .limit(1)
    .maybeSingle();
  const siguienteOrden = (maxOrden?.orden ?? 0) + 1;

  const { error } = await supabase.from("porticos_vehiculos").insert({
    patente,
    imei: imei || null,
    unit_id: unitId,
    empresa: empresa || patente,
    es_prueba_interna: false,
    orden: siguienteOrden,
    origen: "tracklink",
  });

  if (error) {
    return { error: "Error al guardar: " + error.message };
  }

  revalidatePath("/porticos-admin");
  return { success: `Vehículo ${patente} agregado. Aparecerá en la próxima corrida del sync (cada 20 min) o al presionar "Actualizar ahora" en el portal.` };
}

export async function eliminarVehiculoPorticosAction(id: string) {
  await exigirAdmin();
  const supabase = getSupabaseAdmin();
  await supabase.from("porticos_vehiculos").delete().eq("id", id);
  revalidatePath("/porticos-admin");
}

export async function asignarVehiculoAction(vehiculoId: string, clienteUsuario: string | null) {
  await exigirAdmin();
  const supabase = getSupabaseAdmin();
  await supabase.from("porticos_vehiculos").update({ cliente_usuario: clienteUsuario }).eq("id", vehiculoId);
  revalidatePath("/porticos-admin");
}

export type UsuarioPorticosActionState = { error?: string; success?: string; avisoVerificacion?: string } | undefined;

// Base REST de TrackGTS — misma que usa sync-tlchile.js. Se usa SOLO para la
// verificación puntual (manual, ocasional) de la clave de un cliente nuevo,
// nunca en cada login del cliente — así no se repite el patrón que causó el
// bloqueo de cuenta del 2026-08-27.
const TRACKGTS_BASE_URL = "https://tlchile.trackgts.com:8081";

async function verificarCredencialTrackGTS(usuario: string, password: string): Promise<{ ok: boolean; detalle: string }> {
  try {
    const res = await fetch(`${TRACKGTS_BASE_URL}/api/Authenticate/Auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: usuario, password, customer: "tlchile" }),
    });
    if (res.status === 429) return { ok: false, detalle: "TrackGTS respondió rate-limit — intenta de nuevo en unos minutos (no reintentes seguido)." };
    if (!res.ok) return { ok: false, detalle: `TrackGTS respondió HTTP ${res.status} — la cuenta puede no existir en esta API, o la clave es incorrecta.` };
    const data = await res.json();
    if (!data?.data?.accessToken) return { ok: false, detalle: "TrackGTS no devolvió una sesión válida — usuario o clave incorrectos." };
    return { ok: true, detalle: "Verificado correctamente contra TrackGTS." };
  } catch (err) {
    return { ok: false, detalle: "Error de conexión con TrackGTS: " + (err instanceof Error ? err.message : "desconocido") };
  }
}

export async function agregarUsuarioPorticosAction(_state: UsuarioPorticosActionState, formData: FormData): Promise<UsuarioPorticosActionState> {
  await exigirAdmin();

  const usuario = String(formData.get("usuario") || "").trim().toUpperCase();
  const empresa = String(formData.get("empresa") || "").trim();
  const password = String(formData.get("password") || "");
  const esAdmin = formData.get("esAdmin") === "on";
  const verificar = formData.get("verificar") === "on";
  const vehiculoId = String(formData.get("vehiculoId") || "");

  if (!/^[A-Z0-9._-]{2,32}$/.test(usuario)) {
    return { error: "El usuario debe tener 2-32 caracteres (letras, números, punto, guión)." };
  }
  if (password.length < 6) {
    return { error: "La contraseña debe tener al menos 6 caracteres." };
  }
  if (!empresa) {
    return { error: "Falta el nombre para mostrar (empresa/cliente)." };
  }

  let avisoVerificacion: string | undefined;
  if (verificar) {
    const resultado = await verificarCredencialTrackGTS(usuario, password);
    avisoVerificacion = resultado.detalle;
    if (!resultado.ok) {
      return {
        error: `No se pudo verificar contra TrackGTS: ${resultado.detalle} Si el cliente no tiene login propio en TrackGTS, desmarca "Verificar contra TrackGTS" y créalo directo.`,
      };
    }
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("porticos_clientes").insert({
    usuario: usuario.toLowerCase(),
    password_hash: hashPassword(password),
    empresa,
    es_admin: esAdmin,
  });

  if (error) {
    if (error.code === "23505") return { error: `El usuario "${usuario}" ya existe.` };
    return { error: "Error al guardar: " + error.message };
  }

  if (vehiculoId) {
    await supabase.from("porticos_vehiculos").update({ cliente_usuario: usuario.toLowerCase() }).eq("id", vehiculoId);
  }

  revalidatePath("/porticos-admin");
  return { success: `Usuario "${usuario}" creado.`, avisoVerificacion };
}

export async function actualizarPasswordUsuarioAction(_state: UsuarioPorticosActionState, formData: FormData): Promise<UsuarioPorticosActionState> {
  await exigirAdmin();

  const usuario = String(formData.get("usuario") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const verificar = formData.get("verificar") === "on";

  if (!usuario) return { error: "Selecciona un usuario." };
  if (password.length < 6) return { error: "La contraseña debe tener al menos 6 caracteres." };

  let avisoVerificacion: string | undefined;
  if (verificar) {
    const resultado = await verificarCredencialTrackGTS(usuario, password);
    avisoVerificacion = resultado.detalle;
    if (!resultado.ok) {
      return { error: `No se pudo verificar contra TrackGTS: ${resultado.detalle}` };
    }
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("porticos_clientes")
    .update({ password_hash: hashPassword(password) })
    .eq("usuario", usuario);

  if (error) return { error: "Error al guardar: " + error.message };

  revalidatePath("/porticos-admin");
  return { success: `Contraseña de "${usuario}" actualizada.`, avisoVerificacion };
}

export async function eliminarUsuarioPorticosAction(usuario: string) {
  await exigirAdmin();
  const supabase = getSupabaseAdmin();
  await supabase.from("porticos_vehiculos").update({ cliente_usuario: null }).eq("cliente_usuario", usuario);
  await supabase.from("porticos_clientes").delete().eq("usuario", usuario);
  revalidatePath("/porticos-admin");
}
