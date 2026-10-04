import "server-only";
import type { Caso } from "./tipos";
import { registrarMensaje } from "./datos";

// Canal de salida. En producción usa WhatsApp Cloud API (Meta); en simulación
// solo registra el mensaje (se lee desde el simulador del panel).
//
// Variables (producción):
//   WHATSAPP_TOKEN            token permanente del System User de Meta
//   WHATSAPP_PHONE_ID_<LINEA> phone_number_id por marca (TRACKLINK/AUTOBAHN/TRACKCITY);
//                             si falta, usa WHATSAPP_PHONE_ID
//   WHATSAPP_TEMPLATE_<HITO>  nombre de la plantilla aprobada para D30/D20/D10/D3/D0
//
// Regla de Meta: un mensaje que INICIA la conversación (o que llega >24h
// después del último mensaje del cliente) debe ser una plantilla aprobada.
// Dentro de la ventana de 24h se puede responder texto libre.

const GRAPH = "https://graph.facebook.com/v21.0";

function phoneId(caso: Caso): string | undefined {
  return process.env[`WHATSAPP_PHONE_ID_${caso.linea}`] ?? process.env.WHATSAPP_PHONE_ID;
}

export function whatsappConfigurado(caso: Caso): boolean {
  return !!(process.env.WHATSAPP_TOKEN && phoneId(caso));
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

// Respuesta dentro de la conversación (texto libre).
export async function enviarRespuesta(caso: Caso, texto: string, tipo = "respuesta") {
  const real = !caso.simulacion && whatsappConfigurado(caso) && !!caso.telefono;
  let meta: Record<string, unknown> = {};
  if (real) {
    try {
      const r = await postWhatsApp(caso, { type: "text", text: { body: texto, preview_url: true } });
      meta = { wa_id: r.messages?.[0]?.id };
    } catch (err) {
      meta = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  await registrarMensaje({ caso_id: caso.id, direccion: "out", canal: real ? "whatsapp" : "simulador", tipo, texto, meta });
}

// Mensaje proactivo (primer contacto / recordatorios). En producción va como
// plantilla aprobada; Meta no acepta saltos de línea en los parámetros, así
// que se mandan sueltos: {{1}} nombre, {{2}} marca, {{3}} patentes,
// {{4}} fecha de vencimiento, {{5}} días restantes. `texto` es la versión
// renderizada que queda en el registro y se ve en el simulador.
export async function enviarProactivo(caso: Caso, hito: string, texto: string, params: string[]) {
  const plantilla = process.env[`WHATSAPP_TEMPLATE_${hito}`];
  const real = !caso.simulacion && whatsappConfigurado(caso) && !!caso.telefono && !!plantilla;
  let meta: Record<string, unknown> = {};
  if (real) {
    try {
      const r = await postWhatsApp(caso, {
        type: "template",
        template: {
          name: plantilla,
          language: { code: "es" },
          components: [{ type: "body", parameters: params.map(p => ({ type: "text", text: p.replace(/\s+/g, " ") })) }],
        },
      });
      meta = { wa_id: r.messages?.[0]?.id, plantilla };
    } catch (err) {
      meta = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  await registrarMensaje({ caso_id: caso.id, direccion: "out", canal: real ? "whatsapp" : "simulador", tipo: hito, texto, meta });
}
