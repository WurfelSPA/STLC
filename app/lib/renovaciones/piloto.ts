import "server-only";
import { getSupabaseAdmin } from "@/app/lib/supabaseAdmin";
import type { Caso, Hito } from "./tipos";
import { HITOS } from "./tipos";
import { actualizarCaso, cargarConfig, cargarPiloto, obtenerCaso, registrarMensaje } from "./datos";
import { fechaLarga, nombreCorto, patentes } from "./formato";
import { mensajeInicial, mensajeRecordatorio, mensajeVencimiento } from "./textos";
import { enviarProactivo } from "./canal";

// Piloto WhatsApp: un caso de PRUEBA por cada persona del equipo en
// renov_config.piloto (vehículos ficticios, su propio teléfono). Son los
// únicos casos que reciben WhatsApp fuera del modo producción (ver canal.ts).
// Los avisos no salen por la campaña diaria: se mandan a pedido desde el
// panel, para poder probar cada hito el mismo día.

const PATENTES_PRUEBA = ["PRBA-01", "PRBA-02", "PRBA-03"];

function sumarDias(fecha: string, dias: number) {
  return new Date(Date.parse(fecha) + dias * 86_400_000).toISOString().slice(0, 10);
}

export async function crearCasosPiloto(hoy: string): Promise<number> {
  const sb = getSupabaseAdmin();
  const contactos = await cargarPiloto();
  const { error: errDel } = await sb.from("renov_casos").delete().eq("piloto", true);
  if (errDel) throw new Error(errDel.message);
  const vence = sumarDias(hoy, 30);
  const casos = contactos.map((c, i) => ({
    usuario: `piloto-${i + 1}`,
    nombre: c.nombre,
    rut: null,
    telefono: c.telefono,
    correo: null,
    linea: c.linea,
    segmento: c.linea === "TRACKCITY" ? "TRACKCITY" : "",
    cotiza_bot: true,
    tipo_cliente: c.vehiculos > 1 ? "empresa" : "persona",
    vehiculos: PATENTES_PRUEBA.slice(0, Math.max(1, c.vehiculos)).map((p, j) => ({
      imei: `PILOTO:${i + 1}:${j + 1}`, placa: p, marca: "VEHÍCULO", modelo: "DE PRUEBA", vence,
    })),
    cantidad_vehiculos: Math.max(1, c.vehiculos),
    fecha_vencimiento: vence,
    simulacion: false,
    piloto: true,
  }));
  if (casos.length) {
    const { error } = await sb.from("renov_casos").insert(casos);
    if (error) throw new Error(error.message);
  }
  return casos.length;
}

// Manda el aviso de un hito como si hoy fuera ese día (D10 = "vence en 10 días").
export async function enviarAvisoPiloto(casoId: string, hito: Hito, usuarioPanel: string): Promise<void> {
  const caso = await obtenerCaso(casoId);
  if (!caso?.piloto) throw new Error("Solo se puede usar con casos del piloto");
  const cfg = await cargarConfig();
  const dias = HITOS.find(h => h.hito === hito)!.dias;
  const hoyFicticio = sumarDias(caso.fecha_vencimiento, -dias);
  const texto = hito === "D0" ? mensajeVencimiento(caso, cfg)
    : hito === "D30" ? mensajeInicial(caso, cfg) : mensajeRecordatorio(caso, cfg, hoyFicticio);
  const params = [nombreCorto(caso), cfg.lineas[caso.linea]?.nombre ?? caso.linea, patentes(caso), fechaLarga(caso.fecha_vencimiento), String(dias)];
  await registrarMensaje({ caso_id: caso.id, direccion: "nota", canal: "panel", tipo: "evento", texto: `${usuarioPanel} envió el aviso ${hito} (piloto)` });
  await enviarProactivo(caso, hito, texto, params);
  await actualizarCaso(caso.id, {
    hitos_enviados: [...new Set([...caso.hitos_enviados, hito])],
    estado: caso.estado === "PENDIENTE" ? "CONTACTADO" : caso.estado,
    paso: "MENU",
  });
}

// El tester escribe primero ("hola") a un caso del piloto que aún no recibió
// contacto: Tracky responde con el primer mensaje (D30). Así se puede probar
// sin plantillas aprobadas: el mensaje del cliente abre la ventana de 24 h.
export async function responderPrimerContacto(caso: Caso): Promise<boolean> {
  if (!caso.piloto || caso.hitos_enviados.length > 0) return false;
  const cfg = await cargarConfig();
  const params = [nombreCorto(caso), cfg.lineas[caso.linea]?.nombre ?? caso.linea, patentes(caso), fechaLarga(caso.fecha_vencimiento), "30"];
  const actualizado = { ...caso, ultima_interaccion: new Date().toISOString() };
  await enviarProactivo(actualizado, "D30", mensajeInicial(caso, cfg), params);
  await actualizarCaso(caso.id, { hitos_enviados: ["D30"], estado: "CONTACTADO", paso: "MENU", ultima_interaccion: actualizado.ultima_interaccion });
  return true;
}
