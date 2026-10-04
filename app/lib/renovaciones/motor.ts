// Motor de conversación del Bot de Renovaciones: máquina de estados
// determinística (flujos A–D del spec). No toca la base ni el canal: recibe el
// caso + el texto del cliente y devuelve las respuestas y los cambios a
// guardar. Así el mismo motor sirve para WhatsApp, el simulador y el futuro
// canal digital (web).

import type { Caso, ConfigBot, Estado, Paso } from "./tipos";
import type { Intencion } from "./reglas";
import { sinAcentos, sumarMeses } from "./formato";
import {
  MENU_OPCIONES, T, textoConfirmacionPlazo, textoInstruccionPago, textoMediosPago,
  textoPrecios, textoProblemaTecnico, textoVigencia,
} from "./textos";

export type Clasificador = (texto: string) => Promise<{ intencion: Intencion; fuente: string }>;

export type Resultado = {
  respuestas: string[];
  patch: Partial<Caso>;
  notas: string[];          // eventos para el registro interno (no se envían)
};

type Ctx = {
  caso: Caso;
  cfg: ConfigBot;
  texto: string;
  conAdjunto: boolean;
  clasificar: Clasificador;
  r: Resultado;
};

// ── Interpretación de respuestas ────────────────────────────────────────────

// Acepta el número ("2", "2.", "la 2") o alguna frase de la opción.
function opcion(texto: string, sinonimos: string[][]): number | null {
  const t = sinAcentos(texto);
  const num = t.match(/^\D{0,12}?(\d{1,2})\b/);
  if (num) {
    const n = Number(num[1]);
    if (n >= 1 && n <= sinonimos.length) return n;
  }
  for (let i = 0; i < sinonimos.length; i++) {
    if (sinonimos[i].some(s => t.includes(s))) return i + 1;
  }
  return null;
}

function siNo(texto: string): boolean | null {
  const t = sinAcentos(texto);
  if (/^(si|sii+|s|ok|okay|dale|claro|bueno|ya|confirmo|de acuerdo|perfecto|afirmativo|por supuesto)\b/.test(t) || t.includes("si,") || t === "sí") return true;
  if (/^(no|nop|nones|negativo|todavia no|aun no)\b/.test(t)) return false;
  return null;
}

const SIN_MENU = [
  ["renov", "pagar", "continuar"],
  ["consulta", "pregunta", "duda"],
  ["ejecutivo", "persona", "humano", "asesor", "hablar"],
  ["ya no tengo", "no tengo", "vendi", "cambie"],
];
const SIN_EJECUTIVO = [
  ["precio", "descuento"], ["cotiz", "orden de compra", " oc"], ["tecnico", "falla", "problema"],
  ["cambio de vehiculo", "otro vehiculo", "auto nuevo"], ["cancelar", "baja"], ["otro"],
];
const MOTIVOS_EJECUTIVO = ["Solicita precio o descuento", "Cotización / OC", "Problema técnico", "Cambio de vehículo", "Quiere cancelar", "Otro"];
const SIN_QUE_PASO = [["vendi", "venta"], ["cambie", "otro vehiculo", "nuevo"], ["no utilizo", "no uso", "no lo necesito", "no quiero"], ["otro"]];
const SIN_NO_USO = [["precio", "caro"], ["no lo necesito", "no necesito"], ["conforme", "mal servicio", "malo"], ["tecnico", "falla"], ["otro proveedor", "otra empresa", "competencia"], ["otro"]];
const MOTIVOS_NO_USO = ["Precio", "No lo necesito", "No conforme con el servicio", "Problemas técnicos", "Contrató otro proveedor", "Otro"];
const SIN_VENTA = [["traspas", "otro vehiculo"], ["titular", "dueño", "dueno"], ["baja", "eliminar", "cancelar"]];
const ACCIONES_VENTA = ["Traspasar a otro vehículo", "Cambiar titular", "Dar de baja"];

// ── Acciones comunes ────────────────────────────────────────────────────────

function decir(ctx: Ctx, ...msgs: string[]) {
  ctx.r.respuestas.push(...msgs.filter(Boolean));
}

function ir(ctx: Ctx, paso: Paso, estado?: Estado) {
  ctx.r.patch.paso = paso;
  if (estado) ctx.r.patch.estado = estado;
}

function ctxSet(ctx: Ctx, datos: Record<string, unknown>) {
  ctx.r.patch.contexto = { ...ctx.caso.contexto, ...(ctx.r.patch.contexto ?? {}), ...datos };
}

function derivar(ctx: Ctx, motivo: string, opts: { estado?: Estado; mensaje?: string | null; origen?: string } = {}) {
  ctx.r.patch.requiere_ejecutivo = true;
  ctx.r.patch.atendido = false;
  ctx.r.patch.motivo = motivo;
  ctxSet(ctx, opts.origen ? { derivado: true, origen: opts.origen } : { derivado: true });
  ir(ctx, "FIN", opts.estado ?? "REQUIERE_EJECUTIVO");
  if (opts.mensaje !== null) decir(ctx, opts.mensaje ?? T.deriva);
  ctx.r.notas.push(`Derivado a ejecutivo: ${motivo}`);
}

function mostrarMenu(ctx: Ctx, prefijo?: string) {
  decir(ctx, (prefijo ? prefijo + "\n\n" : "") + MENU_OPCIONES);
  ir(ctx, "MENU");
}

// Reintento: a la 2ª respuesta no entendida en el mismo paso, deriva.
function noEntendi(ctx: Ctx, repetir: string) {
  const fallos = Number(ctx.caso.contexto?.fallos ?? 0) + 1;
  if (fallos >= 2) {
    ctxSet(ctx, { fallos: 0 });
    derivar(ctx, `No se entendió la respuesta del cliente: "${ctx.texto.slice(0, 120)}"`);
    return;
  }
  ctxSet(ctx, { fallos });
  decir(ctx, `${T.noEntendi}\n\n${repetir}`);
}

// ── Flujo A: renovar ────────────────────────────────────────────────────────

function iniciarRenovacion(ctx: Ctx) {
  const { caso, cfg } = ctx;
  ctxSet(ctx, { eligio_renovar: true });
  if (!caso.cotiza_bot || !(cfg.precios[caso.linea]?.length)) {
    derivar(ctx, "Cotización: plan sin precio automático", { estado: "INTERESADO", mensaje: T.cotizacionEjecutivo });
    return;
  }
  decir(ctx, textoPrecios(caso, cfg));
  ir(ctx, "A_PLAZO", "INTERESADO");
}

function elegirPlazo(ctx: Ctx) {
  const precios = ctx.cfg.precios[ctx.caso.linea] ?? [];
  const t = sinAcentos(ctx.texto);
  // "24", "24 meses", "2 años" o el número de opción (1-4)
  let elegido = precios.find(p => new RegExp(`\\b${p.meses}\\b`).test(t));
  const anios = t.match(/\b([1-4])\s*anos?\b/);
  if (!elegido && anios) elegido = precios.find(p => p.meses === Number(anios[1]) * 12);
  if (!elegido) {
    const n = opcion(ctx.texto, precios.map(() => []));
    if (n) elegido = precios[n - 1];
  }
  if (!elegido) return noEntendi(ctx, textoPrecios(ctx.caso, ctx.cfg));
  const monto = elegido.precio * ctx.caso.cantidad_vehiculos;
  ctx.r.patch.plazo_meses = elegido.meses;
  ctx.r.patch.monto = monto;
  ctxSet(ctx, { fallos: 0 });
  decir(ctx, textoConfirmacionPlazo(ctx.caso, ctx.cfg, elegido.meses, monto));
  ir(ctx, "A_CONFIRMAR");
}

function confirmarPlazo(ctx: Ctx) {
  const r = siNo(ctx.texto);
  if (r === null) return noEntendi(ctx, "¿Deseas continuar? (Sí / No)");
  if (!r) {
    ctx.r.patch.plazo_meses = null;
    ctx.r.patch.monto = null;
    return mostrarMenu(ctx, "Sin problema.");
  }
  if (!textoMediosPago(ctx.caso, ctx.cfg)) {
    derivar(ctx, "Quiere renovar pero la línea no tiene medio de pago configurado", { estado: "INTERESADO", mensaje: T.sinMedioPago });
    return;
  }
  const monto = ctx.r.patch.monto ?? ctx.caso.monto ?? 0;
  decir(ctx, textoInstruccionPago(ctx.caso, ctx.cfg, monto));
  ir(ctx, "A_PAGO", "PAGO_PENDIENTE");
  ctx.r.notas.push(`Link de pago enviado (${ctx.caso.plazo_meses ?? ctx.r.patch.plazo_meses} meses)`);
}

async function esperarPago(ctx: Ctx) {
  const t = sinAcentos(ctx.texto);
  const avisaPago = ctx.conAdjunto || /pague|pagado|comprobante|transferi|listo|realice el pago|ya esta/.test(t);
  if (avisaPago) {
    ctx.r.patch.requiere_ejecutivo = true;
    ctx.r.patch.atendido = false;
    ctx.r.patch.motivo = "Validar pago de renovación";
    ctxSet(ctx, { pago_avisado: true });
    decir(ctx, T.pagoRecibido);
    ir(ctx, "FIN", "PAGO_POR_VALIDAR");
    ctx.r.notas.push(ctx.conAdjunto ? "Cliente envió comprobante (adjunto)" : "Cliente avisa que pagó");
    return;
  }
  // Puede preguntar otra cosa mientras tanto (ej. formas de pago).
  const { intencion } = await ctx.clasificar(ctx.texto);
  if (intencion !== "no_reconocida" && intencion !== "renovar") return responderConsulta(ctx, intencion);
  decir(ctx, T.pagoRecordar);
}

// ── Flujo B: consultas ──────────────────────────────────────────────────────

async function responderConsulta(ctx: Ctx, intencion: Intencion) {
  const { caso, cfg } = ctx;
  ctxSet(ctx, { ultima_consulta: intencion });
  switch (intencion) {
    case "renovar":
      return iniciarRenovacion(ctx);
    case "precio":
      if (!caso.cotiza_bot || !cfg.precios[caso.linea]?.length) {
        return derivar(ctx, "Consulta precio: plan sin precio automático", { mensaje: T.cotizacionEjecutivo });
      }
      decir(ctx, textoPrecios(caso, cfg).replace("\n\n¿Qué opción prefieres?", ""), T.quieresRenovar);
      return ir(ctx, "B_RENOVAR", "EN_CONVERSACION");
    case "vigencia":
      decir(ctx, textoVigencia(caso), T.quieresRenovar);
      return ir(ctx, "B_RENOVAR", "EN_CONVERSACION");
    case "formas_pago": {
      const medios = textoMediosPago(caso, cfg);
      if (!medios) return derivar(ctx, "Consulta formas de pago: línea sin medio configurado");
      decir(ctx, "Estos son nuestros medios de pago:\n\n" + medios, T.quieresRenovar);
      return ir(ctx, "B_RENOVAR", "EN_CONVERSACION");
    }
    case "ya_pague":
      return derivar(ctx, "Cliente indica que ya pagó (validar)", { estado: "PAGO_POR_VALIDAR", mensaje: T.pagoRecibido });
    case "cambio_vehiculo":
      return derivar(ctx, "Cambio de vehículo", { estado: "CAMBIO_VEHICULO", mensaje: T.cambioVehiculoDeriva + "\n" + T.deriva });
    case "cambio_patente":
      return derivar(ctx, "Cambio de patente", { mensaje: T.cambioPatenteDeriva });
    case "problema_app":
      return derivar(ctx, "Problema con la App", { mensaje: textoProblemaTecnico(cfg) });
    case "problema_gps":
      return derivar(ctx, "Problema con GPS", { mensaje: textoProblemaTecnico(cfg) });
    case "servicio_suspendido":
      return derivar(ctx, "Servicio suspendido", { mensaje: T.suspendidoDeriva });
    case "venta_vehiculo":
      decir(ctx, T.ventaPregunta);
      return ir(ctx, "B_VENTA", "EN_CONVERSACION");
    case "instalacion":
      decir(ctx, T.instalacionPide);
      return ir(ctx, "B_INSTALACION", "EN_CONVERSACION");
    case "desinstalacion":
      return derivar(ctx, "Desinstalación", { mensaje: T.desinstalacionDeriva });
    case "varios_vehiculos":
      return derivar(ctx, "Renovación de más de un vehículo", { mensaje: T.variosVehiculos });
    case "hablar_ejecutivo":
      decir(ctx, T.ejecutivoMotivo);
      return ir(ctx, "C_MOTIVO", "EN_CONVERSACION");
    case "no_tengo_vehiculo":
      return iniciarSinVehiculo(ctx);
    case "no_quiere_renovar":
      decir(ctx, T.motivoNoUso);
      return ir(ctx, "D3_MOTIVO", "EN_CONVERSACION");
    case "baja_mensajes":
      ctx.r.patch.opt_out = true;
      decir(ctx, T.optOut);
      ctx.r.notas.push("Cliente pidió no recibir más mensajes (opt-out)");
      return ir(ctx, "FIN");
    case "no_reconocida":
    default:
      return derivar(ctx, `Consulta no reconocida: "${ctx.texto.slice(0, 160)}"`);
  }
}

// ── Flujo D: ya no tengo el vehículo ────────────────────────────────────────

function iniciarSinVehiculo(ctx: Ctx) {
  // Con flota consolidada no sabemos a qué patente se refiere: ejecutivo.
  if (ctx.caso.cantidad_vehiculos > 1) {
    return derivar(ctx, "Flota: cliente indica que ya no tiene uno de los vehículos");
  }
  decir(ctx, T.queOcurrio);
  ir(ctx, "D_QUE_PASO", "EN_CONVERSACION");
}

function noRenueva(ctx: Ctx, motivo: string, mensaje: string, alertarEjecutivo = false) {
  ctx.r.patch.motivo = motivo;
  ctx.r.patch.cerrado_por = "bot";
  if (alertarEjecutivo) {
    ctx.r.patch.requiere_ejecutivo = true;
    ctx.r.patch.atendido = false;
    ctxSet(ctx, { derivado: true });
  }
  decir(ctx, mensaje);
  ir(ctx, "FIN", "NO_RENUEVA");
  ctx.r.notas.push(`No renueva: ${motivo}`);
}

// ── Punto de entrada ────────────────────────────────────────────────────────

export async function procesarEntrada(
  caso: Caso, texto: string, cfg: ConfigBot, clasificar: Clasificador, conAdjunto = false,
): Promise<Resultado> {
  const ctx: Ctx = { caso, cfg, texto: texto.trim(), conAdjunto, clasificar, r: { respuestas: [], patch: {}, notas: [] } };
  const t = sinAcentos(ctx.texto);
  ctx.r.patch.respondio = true;

  // Comandos globales
  if (/^(menu|inicio|volver)\b/.test(t)) {
    if (caso.estado === "CONTACTADO" || caso.estado === "PENDIENTE") ctx.r.patch.estado = "EN_CONVERSACION";
    ctxSet(ctx, { fallos: 0 });
    mostrarMenu(ctx);
    return ctx.r;
  }
  if (caso.estado === "CONTACTADO" || caso.estado === "PENDIENTE" || caso.estado === "SIN_RESPUESTA") {
    ctx.r.patch.estado = "EN_CONVERSACION";
  }

  switch (caso.paso) {
    case "MENU": {
      const n = opcion(ctx.texto, SIN_MENU);
      if (n === 1) { iniciarRenovacion(ctx); break; }
      if (n === 2) { decir(ctx, T.consultaAbierta); ir(ctx, "B_CONSULTA"); break; }
      if (n === 3) { decir(ctx, T.ejecutivoMotivo); ir(ctx, "C_MOTIVO"); break; }
      if (n === 4) { iniciarSinVehiculo(ctx); break; }
      // Texto libre directo en el menú ("¿cuánto cuesta?"): se clasifica.
      const { intencion } = await clasificar(ctx.texto);
      if (intencion === "no_reconocida") { noEntendi(ctx, MENU_OPCIONES); break; }
      await responderConsulta(ctx, intencion);
      break;
    }
    case "A_PLAZO": elegirPlazo(ctx); break;
    case "A_CONFIRMAR": confirmarPlazo(ctx); break;
    case "A_PAGO": await esperarPago(ctx); break;

    case "B_CONSULTA": {
      const { intencion } = await clasificar(ctx.texto);
      await responderConsulta(ctx, intencion);
      break;
    }
    case "B_RENOVAR": {
      const r = siNo(ctx.texto);
      if (r === true) { iniciarRenovacion(ctx); break; }
      if (r === false) { decir(ctx, T.finAmable); ir(ctx, "MENU"); break; }
      const { intencion } = await clasificar(ctx.texto);
      await responderConsulta(ctx, intencion);
      break;
    }
    case "B_INSTALACION":
      ctxSet(ctx, { direccion_instalacion: ctx.texto });
      derivar(ctx, `Instalación — dirección: ${ctx.texto.slice(0, 200)}`, { mensaje: T.instalacionOk });
      break;
    case "B_VENTA": {
      const n = opcion(ctx.texto, SIN_VENTA);
      if (!n) { noEntendi(ctx, T.ventaPregunta); break; }
      derivar(ctx, `Venta del vehículo: ${ACCIONES_VENTA[n - 1]}`, {
        estado: n === 1 ? "CAMBIO_VEHICULO" : "REQUIERE_EJECUTIVO",
      });
      break;
    }

    case "C_MOTIVO": {
      const n = opcion(ctx.texto, SIN_EJECUTIVO);
      if (!n) { noEntendi(ctx, T.ejecutivoMotivo); break; }
      if (n === 6) { decir(ctx, T.ejecutivoOtro); ir(ctx, "C_OTRO"); break; }
      derivar(ctx, MOTIVOS_EJECUTIVO[n - 1], {
        origen: "C",
        estado: n === 4 ? "CAMBIO_VEHICULO" : "REQUIERE_EJECUTIVO",
        mensaje: "¡Gracias! Le pasé tu solicitud a un ejecutivo con todos tus datos. Te contactará a la brevedad. 🙌",
      });
      break;
    }
    case "C_OTRO":
      derivar(ctx, `Otro: ${ctx.texto.slice(0, 200)}`, {
        origen: "C",
        mensaje: "¡Gracias! Le pasé tu solicitud a un ejecutivo. Te contactará a la brevedad. 🙌",
      });
      break;

    case "D_QUE_PASO": {
      const n = opcion(ctx.texto, SIN_QUE_PASO);
      if (n === 1) { decir(ctx, T.otroVehiculo); ir(ctx, "D1_OTRO_VEHICULO"); break; }
      if (n === 2) { ctxSet(ctx, { via: "cambio" }); decir(ctx, T.cambioVehiculo); ir(ctx, "D_NUEVA_PATENTE"); break; }
      if (n === 3) { decir(ctx, T.motivoNoUso); ir(ctx, "D3_MOTIVO"); break; }
      if (n === 4) { decir(ctx, T.cuentaMotivo); ir(ctx, "D4_TEXTO"); break; }
      noEntendi(ctx, T.queOcurrio);
      break;
    }
    case "D1_OTRO_VEHICULO": {
      const r = siNo(ctx.texto);
      if (r === true) { ctxSet(ctx, { via: "venta" }); decir(ctx, T.pideNuevaPatente); ir(ctx, "D_NUEVA_PATENTE"); break; }
      if (r === false) { noRenueva(ctx, "Vehículo vendido", T.vendidoSinOtro); break; }
      noEntendi(ctx, T.otroVehiculo);
      break;
    }
    case "D_NUEVA_PATENTE":
      ctxSet(ctx, { nuevo_vehiculo: ctx.texto.slice(0, 200) });
      derivar(ctx, `Oportunidad: traslado/nueva instalación — nuevo vehículo: ${ctx.texto.slice(0, 120)}`, {
        estado: "CAMBIO_VEHICULO", mensaje: T.oportunidadRegistrada,
      });
      break;
    case "D3_MOTIVO": {
      const n = opcion(ctx.texto, SIN_NO_USO);
      if (!n) { noEntendi(ctx, T.motivoNoUso); break; }
      if (n === 6) { decir(ctx, T.cuentaMotivo); ir(ctx, "D3_OTRO"); break; }
      // "Quiere cancelar por precio" es PRIORIDAD ALTA para retención (sección 6).
      if (n === 1) { noRenueva(ctx, "Precio", T.graciasMotivoPrecio, true); break; }
      noRenueva(ctx, MOTIVOS_NO_USO[n - 1], T.graciasMotivo);
      break;
    }
    case "D3_OTRO":
      noRenueva(ctx, `Otro: ${ctx.texto.slice(0, 200)}`, T.graciasMotivo);
      break;
    case "D4_TEXTO":
      derivar(ctx, `Ya no tiene el vehículo — otro motivo: ${ctx.texto.slice(0, 200)}`, { mensaje: T.graciasDeriva });
      break;

    case "FIN":
    default: {
      // Caso ya derivado/cerrado: si pide algo nuevo y claro, lo atendemos;
      // si no, recordamos que un ejecutivo lo contactará.
      const { intencion } = await clasificar(ctx.texto);
      if (caso.estado === "PAGO_POR_VALIDAR" || intencion === "no_reconocida") {
        decir(ctx, caso.estado === "RENOVADO" ? T.finAmable : T.yaDerivado);
        break;
      }
      await responderConsulta(ctx, intencion);
    }
  }
  return ctx.r;
}

// Cierre de una renovación cuando el ejecutivo valida el pago.
export function patchRenovado(caso: Caso, meses: number): Partial<Caso> {
  return {
    estado: "RENOVADO",
    paso: "FIN",
    plazo_meses: meses,
    nueva_fecha_vencimiento: sumarMeses(caso.fecha_vencimiento, meses),
    requiere_ejecutivo: false,
    atendido: true,
    cerrado_por: "bot",
    motivo: null,
  };
}
