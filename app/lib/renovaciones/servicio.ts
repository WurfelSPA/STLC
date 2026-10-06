import "server-only";
import type { Caso } from "./tipos";
import { actualizarCaso, cargarConfig, obtenerCaso, registrarMensaje } from "./datos";
import { clasificar } from "./clasificador";
import { procesarEntrada, patchRenovado } from "./motor";
import { enviarRespuesta } from "./canal";
import { textoRenovado } from "./textos";
import { responderPrimerContacto } from "./piloto";

// Orquestación: mensaje entrante -> motor -> guardar -> responder.
export async function recibirMensaje(caso: Caso, texto: string, opts: { canal: string; conAdjunto?: boolean; meta?: Record<string, unknown> }) {
  await registrarMensaje({ caso_id: caso.id, direccion: "in", canal: opts.canal, tipo: "cliente", texto: texto || "(adjunto)", meta: opts.meta });

  // Piloto: si el tester escribe antes de recibir el primer aviso, Tracky
  // parte la conversación con el mensaje inicial.
  if (await responderPrimerContacto(caso)) return obtenerCaso(caso.id);

  const cfg = await cargarConfig();
  const r = await procesarEntrada(caso, texto, cfg, clasificar, opts.conAdjunto ?? false);
  const patch: Partial<Caso> = { ...r.patch, ultima_interaccion: new Date().toISOString() };
  await actualizarCaso(caso.id, patch);

  const actualizado = { ...caso, ...patch } as Caso;
  for (const nota of r.notas) {
    await registrarMensaje({ caso_id: caso.id, direccion: "nota", canal: "sistema", tipo: "evento", texto: nota });
  }
  for (const resp of r.respuestas) await enviarRespuesta(actualizado, resp);
  return actualizado;
}

// El ejecutivo validó el pago en el panel -> RENOVADO + confirmación al cliente.
export async function validarPago(casoId: string, meses: number, usuarioPanel: string) {
  const caso = await obtenerCaso(casoId);
  if (!caso) throw new Error("Caso no encontrado");
  const patch = patchRenovado(caso, meses);
  if (caso.monto == null || caso.plazo_meses !== meses) {
    const cfg = await cargarConfig();
    const p = cfg.precios[caso.linea]?.find(x => x.meses === meses);
    if (p) patch.monto = p.precio * caso.cantidad_vehiculos;
  }
  await actualizarCaso(caso.id, patch);
  const actualizado = { ...caso, ...patch } as Caso;
  await registrarMensaje({
    caso_id: caso.id, direccion: "nota", canal: "panel", tipo: "evento",
    texto: `Pago validado por ${usuarioPanel} (${meses} meses). Pendiente: actualizar "Serv. Hasta" en TrackGTS a ${patch.nueva_fecha_vencimiento}.`,
  });
  await enviarRespuesta(actualizado, textoRenovado(actualizado), "confirmacion");
  return actualizado;
}
