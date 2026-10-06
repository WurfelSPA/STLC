"use server";

import { getSession } from "@/app/lib/session";
import { getSupabaseAdmin } from "@/app/lib/supabaseAdmin";
import type { Caso, Estado, Hito, Linea, Mensaje, Prioridad } from "./tipos";
import { HITO_IDS } from "./tipos";
import {
  actualizarCaso, cargarConfig, cargarPiloto, listarCasos, mensajesDeCaso, modoSimulacion, obtenerCaso, registrarMensaje,
  type ContactoPiloto,
} from "./datos";
import { crearCasosPiloto, enviarAvisoPiloto } from "./piloto";
import { calcularPrioridad, hoyChile } from "./formato";
import { ejecutarCampana, universoDelMes, type ResumenCampana } from "./campana";
import { recibirMensaje, validarPago } from "./servicio";
import { parsearTrackcity } from "./importarTrackcity";

async function exigirSesion() {
  const s = await getSession();
  if (!s) throw new Error("No autorizado");
  return s;
}

export type CasoPanel = Caso & { prioridad: Prioridad };

export type Metricas = {
  universo: number;
  casos: number;
  contactados: number;
  respondieron: number;
  interesados: number;
  pagoPendiente: number;
  renovados: number;
  noRenuevan: number;
  sinRespuesta: number;
  derivados: number;
  cerradosPorBot: number;
  penetracion: number;   // renovados / universo (vehículos)
  tasaRespuesta: number; // respondieron / contactados
  conversionBot: number; // renovados por el bot / contactados
};

export type Panel = {
  hoy: string;
  mes: string;
  simulacion: boolean;
  iaActiva: boolean;
  whatsappActivo: boolean;
  total: Metricas;
  porLinea: Record<Linea, Metricas>;
  motivosNoRenueva: { motivo: string; cantidad: number }[];
  casos: CasoPanel[];
  precios: Record<Linea, { meses: number; precio: number }[]>;
};

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function metricas(casos: Caso[], universo: number): Metricas {
  // Se cuentan VEHÍCULOS (una flota consolidada = N renovaciones).
  const v = (f: (c: Caso) => boolean) => casos.filter(f).reduce((s, c) => s + c.cantidad_vehiculos, 0);
  const contactados = v(c => c.hitos_enviados.length > 0 || c.respondio);
  const respondieron = v(c => c.respondio);
  const renovados = v(c => c.estado === "RENOVADO");
  const cerradosPorBot = v(c => c.estado === "RENOVADO" && c.cerrado_por === "bot");
  return {
    universo,
    casos: v(() => true),
    contactados,
    respondieron,
    interesados: v(c => !!c.contexto?.eligio_renovar),
    pagoPendiente: v(c => c.estado === "PAGO_PENDIENTE" || c.estado === "PAGO_POR_VALIDAR"),
    renovados,
    noRenuevan: v(c => c.estado === "NO_RENUEVA"),
    sinRespuesta: v(c => (c.hitos_enviados.length > 0 && !c.respondio) || c.estado === "SIN_RESPUESTA"),
    derivados: v(c => !!c.contexto?.derivado),
    cerradosPorBot,
    penetracion: pct(renovados, universo),
    tasaRespuesta: pct(respondieron, contactados),
    conversionBot: pct(cerradosPorBot, contactados),
  };
}

export async function obtenerPanelAction(mes: string): Promise<Panel> {
  await exigirSesion();
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error("Mes inválido");
  const simulacion = modoSimulacion();
  const hoy = hoyChile();
  const [y, m] = mes.split("-").map(Number);
  const fin = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [casos, universo, cfg] = await Promise.all([
    listarCasos({ simulacion, desde: `${mes}-01`, hasta: fin }),
    universoDelMes(mes),
    cargarConfig(),
  ]);

  const lineas: Linea[] = ["TRACKLINK", "AUTOBAHN", "TRACKCITY"];
  const porLinea = Object.fromEntries(lineas.map(l => [l, metricas(casos.filter(c => c.linea === l), universo[l])])) as Record<Linea, Metricas>;
  const total = metricas(casos, lineas.reduce((s, l) => s + universo[l], 0));

  const motivos = new Map<string, number>();
  for (const c of casos.filter(c => c.estado === "NO_RENUEVA")) {
    const k = (c.motivo ?? "Sin motivo").replace(/^Otro: .*/, "Otro");
    motivos.set(k, (motivos.get(k) ?? 0) + c.cantidad_vehiculos);
  }

  return {
    hoy, mes, simulacion,
    iaActiva: !!process.env.ANTHROPIC_API_KEY,
    whatsappActivo: !!process.env.WHATSAPP_TOKEN,
    total, porLinea,
    motivosNoRenueva: [...motivos].map(([motivo, cantidad]) => ({ motivo, cantidad })).sort((a, b) => b.cantidad - a.cantidad),
    casos: casos.map(c => ({ ...c, prioridad: calcularPrioridad(c, hoy) })),
    precios: cfg.precios,
  };
}

export async function obtenerConversacionAction(casoId: string): Promise<{ caso: CasoPanel; mensajes: Mensaje[] } | null> {
  await exigirSesion();
  const caso = await obtenerCaso(casoId);
  if (!caso) return null;
  return { caso: { ...caso, prioridad: calcularPrioridad(caso, hoyChile()) }, mensajes: await mensajesDeCaso(casoId) };
}

// Simulador: el usuario del panel escribe como si fuera el cliente.
export async function simularMensajeAction(casoId: string, texto: string, conAdjunto = false) {
  await exigirSesion();
  const caso = await obtenerCaso(casoId);
  if (!caso) throw new Error("Caso no encontrado");
  if (!caso.simulacion) throw new Error("El simulador solo opera sobre casos de simulación");
  if (!texto.trim() && !conAdjunto) return obtenerConversacionAction(casoId);
  await recibirMensaje(caso, texto.slice(0, 1000), { canal: "simulador", conAdjunto, meta: conAdjunto ? { adjunto: "comprobante.jpg (simulado)" } : {} });
  return obtenerConversacionAction(casoId);
}

export async function validarPagoAction(casoId: string, meses: number) {
  const s = await exigirSesion();
  if (![12, 24, 36, 48].includes(meses)) throw new Error("Plazo inválido");
  await validarPago(casoId, meses, s.usuario);
  return obtenerConversacionAction(casoId);
}

export async function marcarAtendidoAction(casoId: string, nota: string) {
  const s = await exigirSesion();
  await actualizarCaso(casoId, { atendido: true, requiere_ejecutivo: false });
  await registrarMensaje({ caso_id: casoId, direccion: "nota", canal: "panel", tipo: "evento",
    texto: `Atendido por ${s.usuario}${nota.trim() ? `: ${nota.trim().slice(0, 500)}` : ""}` });
  return obtenerConversacionAction(casoId);
}

export async function cambiarEstadoAction(casoId: string, estado: Estado, motivo: string) {
  const s = await exigirSesion();
  if (!["NO_RENUEVA", "REQUIERE_EJECUTIVO", "CAMBIO_VEHICULO"].includes(estado)) throw new Error("Estado no permitido desde el panel");
  await actualizarCaso(casoId, {
    estado, motivo: motivo.trim() || null, paso: "FIN",
    ...(estado === "NO_RENUEVA" ? { cerrado_por: "ejecutivo", requiere_ejecutivo: false, atendido: true } : {}),
  });
  await registrarMensaje({ caso_id: casoId, direccion: "nota", canal: "panel", tipo: "evento",
    texto: `${s.usuario} cambió el estado a ${estado}${motivo.trim() ? ` (${motivo.trim().slice(0, 300)})` : ""}` });
  return obtenerConversacionAction(casoId);
}

export async function marcarTrackgtsAction(casoId: string) {
  const s = await exigirSesion();
  await actualizarCaso(casoId, { trackgts_actualizado: true });
  await registrarMensaje({ caso_id: casoId, direccion: "nota", canal: "panel", tipo: "evento",
    texto: `${s.usuario} confirmó que actualizó "Serv. Hasta" en TrackGTS.` });
  return obtenerConversacionAction(casoId);
}

// Corrida de la campaña. En simulación se puede elegir la fecha para mostrar
// cómo avanzan los recordatorios (D60 -> D30 -> D20 -> D10 -> D5 -> D0).
export async function ejecutarCampanaAction(fecha?: string): Promise<ResumenCampana> {
  await exigirSesion();
  const simulacion = modoSimulacion();
  const hoy = simulacion && fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : hoyChile();
  return ejecutarCampana(hoy, simulacion);
}

// ── Piloto WhatsApp ─────────────────────────────────────────────────────────

export type EstadoPiloto = {
  whatsappConfigurado: boolean;
  plantillas: Record<Hito, boolean>;
  webhook: { creado_en: string; resultado: string; telefono: string | null; detalle: string | null }[];
  modo: "simulacion" | "produccion";
  contactos: ContactoPiloto[];
  casos: CasoPanel[];
};

export async function estadoPilotoAction(): Promise<EstadoPiloto> {
  await exigirSesion();
  const sb = getSupabaseAdmin();
  const [contactos, { data }, { data: logs }] = await Promise.all([
    cargarPiloto(),
    sb.from("renov_casos").select("*").eq("piloto", true).order("usuario"),
    sb.from("renov_webhook_log").select("creado_en, resultado, telefono, detalle").order("creado_en", { ascending: false }).limit(15),
  ]);
  const hoy = hoyChile();
  return {
    whatsappConfigurado: !!(process.env.WHATSAPP_TOKEN && (process.env.WHATSAPP_PHONE_ID || process.env.WHATSAPP_PHONE_ID_TRACKLINK)),
    plantillas: Object.fromEntries(HITO_IDS.map(h => [h, !!process.env[`WHATSAPP_TEMPLATE_${h}`]])) as Record<Hito, boolean>,
    webhook: (logs ?? []) as EstadoPiloto["webhook"],
    modo: modoSimulacion() ? "simulacion" : "produccion",
    contactos,
    casos: ((data ?? []) as Caso[]).map(c => ({ ...c, prioridad: calcularPrioridad(c, hoy) })),
  };
}

export async function crearPilotoAction(): Promise<EstadoPiloto> {
  await exigirSesion();
  await crearCasosPiloto(hoyChile());
  return estadoPilotoAction();
}

export async function enviarAvisoPilotoAction(casoId: string, hito: Hito) {
  const s = await exigirSesion();
  if (!(HITO_IDS as readonly string[]).includes(hito)) throw new Error("Hito inválido");
  await enviarAvisoPiloto(casoId, hito, s.usuario);
  return obtenerConversacionAction(casoId);
}

// ── Trackcity: importación de la planilla (CSV) ─────────────────────────────

export type FilaTrackcityPanel = { placa: string; modelo: string; nombre: string; vence: string | null; telefono: string | null; excluir: boolean; motivo_exclusion: string | null; comentario: string | null };
export type EstadoTrackcity = { total: number; excluidas: number; sinFecha: number; importadoEn: string | null; importadoPor: string | null; proximas: FilaTrackcityPanel[]; avisos?: string[] };

export async function estadoTrackcityAction(): Promise<EstadoTrackcity> {
  await exigirSesion();
  const { data } = await getSupabaseAdmin().from("renov_fuente_externa")
    .select("placa, modelo, nombre, vence, telefono, excluir, motivo_exclusion, comentario, importado_en, importado_por")
    .eq("linea", "TRACKCITY").order("vence", { ascending: true, nullsFirst: false });
  const filas = data ?? [];
  const hoy = hoyChile();
  return {
    total: filas.length,
    excluidas: filas.filter(f => f.excluir).length,
    sinFecha: filas.filter(f => !f.vence).length,
    importadoEn: filas[0]?.importado_en ?? null,
    importadoPor: filas[0]?.importado_por ?? null,
    proximas: filas.filter(f => f.vence && f.vence >= hoy).slice(0, 100),
  };
}

// Cada importación REEMPLAZA las filas de Trackcity (la planilla es la fuente).
export async function importarTrackcityAction(csv: string): Promise<EstadoTrackcity> {
  const s = await exigirSesion();
  if (csv.length > 2_000_000) throw new Error("Archivo demasiado grande");
  const { filas, avisos } = parsearTrackcity(csv);
  if (filas.length === 0) throw new Error("No se encontraron filas válidas. ¿Es el CSV de la pestaña \"Renovaciones Trackcity\"?");
  const sb = getSupabaseAdmin();
  const { error: errDel } = await sb.from("renov_fuente_externa").delete().eq("linea", "TRACKCITY");
  if (errDel) throw new Error(errDel.message);
  const ahora = new Date().toISOString();
  const { error } = await sb.from("renov_fuente_externa").insert(
    filas.map(f => ({ ...f, linea: "TRACKCITY", importado_en: ahora, importado_por: s.usuario })),
  );
  if (error) throw new Error(error.message);
  return { ...(await estadoTrackcityAction()), avisos };
}

export async function reiniciarSimulacionAction() {
  const s = await exigirSesion();
  if (!["amelendez", "admin"].includes(s.usuario)) throw new Error("Solo un administrador puede reiniciar la simulación");
  const { error } = await getSupabaseAdmin().from("renov_casos").delete().eq("simulacion", true);
  if (error) throw new Error(error.message);
}
