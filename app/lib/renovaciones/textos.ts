// Textos del bot. Todo lo que el cliente lee sale de acá + datos de la base:
// el modelo de IA nunca redacta respuestas (regla 10 del spec: no inventar
// precios, fechas ni compromisos).

import type { Caso, ConfigBot } from "./tipos";
import { diasEntre, fechaLarga, nombreCorto, patentes, pesos } from "./formato";

export const MENU_OPCIONES =
  "¿Qué deseas hacer?\n" +
  "1. Renovar mi servicio\n" +
  "2. Tengo una consulta\n" +
  "3. Hablar con un ejecutivo\n" +
  "4. Ya no tengo este vehículo / quiero traspasar mi sistema de seguridad y conectividad GPS";

const MSG_DERIVA = "Voy a derivar tu solicitud a nuestro equipo para que puedan ayudarte.";

// Nombre de la asistente frente al cliente. Tracky es "la asistente virtual
// de renovaciones" de las 3 marcas, con un solo número de WhatsApp: la marca
// va en la descripción del servicio para que el cliente sepa de cuál se trata
// (correo F. López 2026-10-08).
export const NOMBRE_BOT = "Tracky";

function marca(c: Caso, cfg: ConfigBot) {
  return cfg.lineas[c.linea]?.nombre ?? c.linea;
}

// Recordatorios: saludo corto (la presentación completa va en el primer mensaje).
function saludo(c: Caso) {
  return `Hola ${nombreCorto(c)}, soy ${NOMBRE_BOT}, tu asistente virtual de renovaciones.`;
}

function descripcionVehiculos(c: Caso, cfg: ConfigBot): string {
  if (c.cantidad_vehiculos === 1) {
    return `el servicio ${marca(c, cfg)} asociado a la patente ${c.vehiculos[0]?.placa || "de tu vehículo"} vence el ${fechaLarga(c.fecha_vencimiento)}`;
  }
  const ultimo = c.vehiculos.map(v => v.vence).sort().at(-1)!;
  const rango = ultimo === c.fecha_vencimiento
    ? `el ${fechaLarga(c.fecha_vencimiento)}`
    : `entre el ${fechaLarga(c.fecha_vencimiento)} y el ${fechaLarga(ultimo)}`;
  return `el servicio ${marca(c, cfg)} de tus ${c.cantidad_vehiculos} vehículos (${patentes(c)}) vence ${rango}`;
}

// Primer mensaje (texto definido por Tracklink, correo F. López 2026-10-08).
export function mensajeInicial(c: Caso, cfg: ConfigBot): string {
  return `¡Hola ${nombreCorto(c)}! Soy ${NOMBRE_BOT}, tu nueva asistente virtual de renovaciones. ` +
    `Estoy aquí para que renovar tu conectividad sea más fácil, resolver tus dudas y conectarte con una ejecutiva cuando lo necesites.\n\n` +
    `Te quiero informar que ${descripcionVehiculos(c, cfg)} y quiero ayudarte a mantener tu servicio activo sin interrupciones 💙\n\n` +
    MENU_OPCIONES;
}

// Recordatorios (hitos posteriores al primero).
export function mensajeRecordatorio(c: Caso, cfg: ConfigBot, hoy: string): string {
  const dias = diasEntre(hoy, c.fecha_vencimiento);
  const sujeto = c.cantidad_vehiculos === 1
    ? `tu servicio ${marca(c, cfg)} asociado a la patente ${c.vehiculos[0]?.placa}`
    : `el servicio ${marca(c, cfg)} de tus ${c.cantidad_vehiculos} vehículos (${patentes(c)})`;
  return `${saludo(c)}\n` +
    `Te recuerdo que ${sujeto} vence en ${dias} ${dias === 1 ? "día" : "días"}.\n` +
    `Puedes renovarlo directamente por este medio 💙\n\n` + MENU_OPCIONES;
}

// Día del vencimiento.
export function mensajeVencimiento(c: Caso, cfg: ConfigBot): string {
  return `${saludo(c)}\nTe informo que tu servicio ${marca(c, cfg)} venció hoy.\n` +
    `Para mantener la continuidad y que estés siempre seguro, te recomiendo renovar durante el día de hoy.\n\n` +
    MENU_OPCIONES;
}

// Servicio suspendido: se ofrece renovar (no se confirma ni se diagnostica la
// suspensión: el bot no conoce el estado técnico del equipo).
export function textoSuspendido(c: Caso, cfg: ConfigBot, hoy: string): string {
  const vencido = c.fecha_vencimiento < hoy;
  const sujeto = c.cantidad_vehiculos === 1
    ? `Tu servicio ${marca(c, cfg)} de la patente ${c.vehiculos[0]?.placa}`
    : `El servicio ${marca(c, cfg)} de tus ${c.cantidad_vehiculos} vehículos`;
  return `${sujeto} ${vencido ? "venció" : "vence"} el ${fechaLarga(c.fecha_vencimiento, true)}. ` +
    `Para mantenerlo activo puedes renovarlo ahora mismo por este medio.`;
}

export function textoPrecios(c: Caso, cfg: ConfigBot): string {
  const lista = cfg.precios[c.linea] ?? [];
  const n = c.cantidad_vehiculos;
  const lineas = lista.map((p, i) =>
    n > 1
      ? `${i + 1}. ${p.meses} meses ${pesos(p.precio)} por vehículo (total ${pesos(p.precio * n)})`
      : `${i + 1}. ${p.meses} meses ${pesos(p.precio)}`);
  const sujeto = n > 1 ? `tus ${n} vehículos` : "tu vehículo";
  return `Tenemos las siguientes alternativas para la renovación de ${sujeto}:\n${lineas.join("\n")}\n\n¿Qué opción prefieres?`;
}

export function textoConfirmacionPlazo(c: Caso, cfg: ConfigBot, meses: number, monto: number): string {
  return `Has seleccionado:\n` +
    `Servicio: ${marca(c, cfg)}\n` +
    `${c.cantidad_vehiculos > 1 ? "Patentes" : "Patente"}: ${patentes(c)}\n` +
    `Período: ${meses} meses\n` +
    `Valor: ${pesos(monto)}\n\n¿Deseas continuar? (Sí / No)`;
}

export function textoMediosPago(c: Caso, cfg: ConfigBot): string {
  const l = cfg.lineas[c.linea];
  const partes: string[] = [];
  if (l?.link_pago) partes.push(`💳 Paga en línea aquí:\n${l.link_pago}`);
  if (l?.transferencia) partes.push(`🏦 O por transferencia electrónica a:\n${l.transferencia}`);
  return partes.join("\n\n");
}

export function textoInstruccionPago(c: Caso, cfg: ConfigBot, monto: number): string {
  return `Perfecto. El monto a pagar es ${pesos(monto)}.\n\n${textoMediosPago(c, cfg)}\n\n` +
    `Cuando realices el pago, envíanos el comprobante por este mismo chat y lo validaremos para confirmar tu renovación.`;
}

export function textoRenovado(c: Caso): string {
  return `¡Listo! ✅\nTu renovación fue procesada correctamente.\n` +
    `${c.cantidad_vehiculos > 1 ? "Patentes" : "Patente"}: ${patentes(c)}\n` +
    `Servicio: Renovación ${c.plazo_meses} meses\n` +
    `Nuevo vencimiento: ${c.nueva_fecha_vencimiento ? fechaLarga(c.nueva_fecha_vencimiento, true) : "—"}\n` +
    `Gracias por continuar con nosotros.`;
}

export const T = {
  deriva: MSG_DERIVA,
  noEntendi: "Disculpa, no entendí tu respuesta. 🙏",
  menuCorto: MENU_OPCIONES,
  cotizacionEjecutivo:
    "Tu plan tiene condiciones especiales, así que un ejecutivo te enviará la cotización personalizada. " + MSG_DERIVA,
  sinMedioPago:
    "En este momento no tengo un medio de pago disponible para tu servicio. " + MSG_DERIVA,
  pagoRecibido:
    "¡Gracias! Recibimos tu aviso de pago. Nuestro equipo lo validará y te confirmaremos la renovación por este medio. 🙌",
  pagoRecordar: "¿Ya realizaste el pago? Si es así, envíanos el comprobante por aquí. Si prefieres volver al menú, escribe MENÚ.",
  consultaAbierta: "Claro, cuéntame tu consulta y te ayudo. ✍️",
  quieresRenovar: "¿Quieres renovar tu servicio? (Sí / No)",
  finAmable: "¡Gracias por tu tiempo! Si necesitas algo más, escribe MENÚ cuando quieras.",
  yaDerivado:
    "Tu solicitud ya fue derivada a nuestro equipo y un ejecutivo te contactará pronto. Si quieres volver al menú, escribe MENÚ.",
  ejecutivoMotivo:
    "Para que el ejecutivo te ayude más rápido, cuéntame el motivo:\n" +
    "1. Precio o descuento\n2. Cotización / OC\n3. Problema técnico\n4. Cambio de vehículo\n5. Quiero cancelar\n6. Otro",
  ejecutivoOtro: "Cuéntame brevemente el motivo y se lo paso al ejecutivo.",
  queOcurrio:
    "¿Qué ocurrió con el vehículo?\n1. Lo vendí\n2. Lo cambié por otro vehículo / quiero traspasar el GPS a otro vehículo\n3. Ya no utilizo el servicio\n4. Otro motivo",
  otroVehiculo: "Entiendo. ¿Tienes actualmente otro vehículo donde quieras mantener tu servicio? (Sí / No)",
  pideNuevaPatente: "¡Genial! Indícame la patente del nuevo vehículo (y marca/modelo si la tienes a mano).",
  cambioVehiculo:
    "Perfecto, podemos revisar la posibilidad de mantener tu servicio en el nuevo vehículo. " +
    "Indícame la nueva patente y la marca/modelo del vehículo.",
  oportunidadRegistrada:
    "¡Gracias! Registramos los datos del nuevo vehículo. Un ejecutivo te contactará para coordinar el traslado o la nueva instalación.",
  vendidoSinOtro: "Entendido, gracias por avisarnos. Registramos que vendiste el vehículo. ¡Que te vaya muy bien! 🙌",
  motivoNoUso:
    "Para ayudarnos a mejorar, ¿nos puedes indicar brevemente por qué ya no deseas continuar?\n" +
    "1. Precio\n2. No lo necesito\n3. No estoy conforme con el servicio\n4. Problemas técnicos\n5. Contraté otro proveedor\n6. Otro",
  graciasMotivo: "Gracias por contarnos, lo tendremos en cuenta para mejorar. 🙏",
  // No renueva: siempre pasa a una ejecutiva (prioridad alta) para retención.
  graciasMotivoRetencion:
    "Gracias por contarnos. Una ejecutiva revisará tu caso y se pondrá en contacto contigo. 🙏",
  cuentaMotivo: "Cuéntame brevemente el motivo.",
  graciasDeriva: "Gracias por contarnos. " + MSG_DERIVA,
  cambioVehiculoDeriva: "Para realizar el cambio de vehículo necesito derivar tu solicitud a un ejecutivo. 🚗",
  cambioPatenteDeriva: "Para actualizar la patente necesito derivar tu solicitud a un ejecutivo para validarla.",
  ventaPregunta:
    "Entiendo. ¿Qué deseas hacer con el servicio?\n1. Traspasarlo a otro vehículo\n2. Cambiar el titular\n3. Dar de baja el servicio",
  instalacionPide:
    "¡Perfecto! Para coordinar la instalación envíame en un solo mensaje estos datos:\n" +
    "• Nombre\n• RUT\n• Correo\n• Marca, modelo y patente del vehículo\n• Dirección (calle, número y comuna)",
  instalacionOk: "¡Gracias! Una ejecutiva te contactará con estos datos para coordinar la instalación.",
  desinstalacionDeriva: "Voy a derivar tu solicitud de desinstalación a un ejecutivo para coordinarla.",
  variosVehiculos: "Para renovar más de un vehículo te ayuda mejor un ejecutivo. " + MSG_DERIVA,
  optOut: "Entendido, no te enviaremos más recordatorios por este medio. Si cambias de opinión, escríbenos cuando quieras.",
};

// App / GPS: solo se entrega el Call Center; el bot no compromete soluciones
// técnicas (correo F. López 2026-10-08). Sin número cargado, deriva.
export function textoProblemaTecnico(cfg: ConfigBot): string | null {
  return cfg.callCenter
    ? `Para ayudarte con eso, comunícate con nuestro Call Center al ${cfg.callCenter}: ellos revisarán tu caso.`
    : null;
}

export function textoVigencia(c: Caso): string {
  if (c.cantidad_vehiculos === 1)
    return `El servicio de tu patente ${c.vehiculos[0]?.placa} vence el ${fechaLarga(c.fecha_vencimiento, true)}.`;
  return "Estos son los vencimientos de tus vehículos:\n" +
    c.vehiculos.map(v => `• ${v.placa || "(sin patente)"}: ${fechaLarga(v.vence, true)}`).join("\n");
}
