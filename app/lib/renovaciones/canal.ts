import "server-only";
import type { Caso } from "./tipos";
import { cargarPiloto, modoSimulacion, registrarMensaje } from "./datos";

// Canal de salida. Envía por WhatsApp Cloud API (Meta) solo cuando se puede
// y se debe; en cualquier otro caso solo registra el mensaje (se ve en el
// panel). Reglas de envío real:
//   - nunca para casos de simulación;
//   - fuera de producción (RENOV_BOT_MODO != "produccion"): SOLO casos del
//     piloto y SOLO a teléfonos de la lista renov_config.piloto — así un
//     error de configuración no puede escribirle a un cliente real.
//
// Variables:
//   WHATSAPP_TOKEN            token (permanente) del System User de Meta
//   WHATSAPP_PHONE_ID_<LINEA> phone_number_id por marca (TRACKLINK/AUTOBAHN/TRACKCITY);
//                             si falta, usa WHATSAPP_PHONE_ID
//   WHATSAPP_TEMPLATE_<HITO>  plantilla aprobada para D30/D20/D10/D3/D0
//
// Regla de Meta: un mensaje que INICIA la conversación (o que llega >24h
// después del último mensaje del cliente) debe ser una plantilla aprobada.
// Dentro de la ventana de 24h se puede responder texto libre.

// Misma versión que muestra la consola de Meta para la app (oct-2026).
const GRAPH = "https://graph.facebook.com/v25.0";
const VENTANA_MS = 24 * 60 * 60 * 1000;

function phoneId(caso: Caso): string | undefined {
  return process.env[`WHATSAPP_PHONE_ID_${caso.linea}`] ?? process.env.WHATSAPP_PHONE_ID;
}

export function whatsappConfigurado(caso: Caso): boolean {
  return !!(process.env.WHATSAPP_TOKEN && phoneId(caso));
}

// null = se puede enviar de verdad; string = por qué no.
async function bloqueoEnvio(caso: Caso): Promise<string | null> {
  if (caso.simulacion) return "simulación";
  if (!caso.telefono) return "sin teléfono";
  if (!whatsappConfigurado(caso)) return "WhatsApp no configurado";
  if (modoSimulacion()) {
    if (!caso.piloto) return "fuera de producción solo se envía a casos del piloto";
    const lista = await cargarPiloto();
    if (!lista.some(c => c.telefono === caso.telefono)) return "teléfono fuera de la lista del piloto";
  }
  return null;
}

async function postWhatsApp(caso: Caso, body: Record<string, unknown>) {
  const res = await fetch(`${GRAPH}/${phoneId(caso)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: caso.telefono, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data as { messages?: { id: string }[] };
}

async function enviarYRegistrar(caso: Caso, tipo: string, texto: string, cuerpo: () => Record<string, unknown> | string) {
  const bloqueo = await bloqueoEnvio(caso);
  let meta: Record<string, unknown> = {};
  let canal = caso.simulacion ? "simulador" : "sistema";
  if (bloqueo) {
    if (!caso.simulacion) meta = { no_enviado: bloqueo };
  } else {
    const body = cuerpo();
    if (typeof body === "string") {
      meta = { no_enviado: body };
    } else {
      try {
        const r = await postWhatsApp(caso, body);
        meta = { wa_id: r.messages?.[0]?.id };
        canal = "whatsapp";
      } catch (err) {
        meta = { error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  await registrarMensaje({ caso_id: caso.id, direccion: "out", canal, tipo, texto, meta });
}

// Respuesta dentro de la conversación (texto libre).
export async function enviarRespuesta(caso: Caso, texto: string, tipo = "respuesta") {
  await enviarYRegistrar(caso, tipo, texto, () => ({ type: "text", text: { body: texto, preview_url: true } }));
}

// Mensaje proactivo (primer contacto / recordatorios). Con plantilla aprobada
// va como plantilla; Meta no acepta saltos de línea en los parámetros, así
// que se mandan sueltos: {{1}} nombre, {{2}} marca, {{3}} patentes,
// {{4}} fecha de vencimiento, {{5}} días restantes. Sin plantilla, solo se
// puede mandar como texto si el cliente escribió en las últimas 24 h
// (ventana de servicio) — útil en el piloto, antes de aprobar plantillas.
export async function enviarProactivo(caso: Caso, hito: string, texto: string, params: string[]) {
  const plantilla = process.env[`WHATSAPP_TEMPLATE_${hito}`];
  await enviarYRegistrar(caso, hito, texto, () => {
    if (plantilla) {
      return {
        type: "template",
        template: {
          name: plantilla,
          language: { code: "es" },
          components: [{ type: "body", parameters: params.map(p => ({ type: "text", text: p.replace(/\s+/g, " ") })) }],
        },
      };
    }
    const ultima = caso.ultima_interaccion ? Date.parse(caso.ultima_interaccion) : 0;
    if (Date.now() - ultima < VENTANA_MS) return { type: "text", text: { body: texto, preview_url: true } };
    return `sin plantilla aprobada para ${hito} y fuera de la ventana de 24 h: el cliente debe escribir primero`;
  });
}
