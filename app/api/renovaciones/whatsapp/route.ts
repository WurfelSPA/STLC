import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { modoSimulacion, obtenerCasoPorTelefono, registrarMensaje } from "@/app/lib/renovaciones/datos";
import { recibirMensaje } from "@/app/lib/renovaciones/servicio";
import { normalizarTelefono } from "@/app/lib/renovaciones/formato";

// Webhook de WhatsApp Cloud API (Meta) para el Bot de Renovaciones.
// Configurar en Meta > WhatsApp > Configuration:
//   Callback URL: https://<dominio>/api/renovaciones/whatsapp
//   Verify token: WHATSAPP_VERIFY_TOKEN
// Firma: Meta firma el body con WHATSAPP_APP_SECRET (X-Hub-Signature-256).

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") && p.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(p.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

function firmaValida(raw: string, firma: string | null): boolean {
  const secreto = process.env.WHATSAPP_APP_SECRET;
  if (!secreto || !firma?.startsWith("sha256=")) return false;
  const esperado = crypto.createHmac("sha256", secreto).update(raw).digest("hex");
  const a = Buffer.from(firma.slice(7), "hex");
  const b = Buffer.from(esperado, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type WaMensaje = {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  image?: { caption?: string };
  document?: { caption?: string; filename?: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
};

export async function POST(request: Request) {
  const raw = await request.text();
  if (!firmaValida(raw, request.headers.get("x-hub-signature-256"))) {
    return new NextResponse("Firma inválida", { status: 401 });
  }
  const body = JSON.parse(raw);
  const mensajes: WaMensaje[] = (body.entry ?? []).flatMap((e: { changes?: { value?: { messages?: WaMensaje[] } }[] }) =>
    (e.changes ?? []).flatMap(c => c.value?.messages ?? []));

  for (const m of mensajes) {
    const telefono = normalizarTelefono(m.from);
    if (!telefono) continue;
    const caso = await obtenerCasoPorTelefono(telefono, modoSimulacion());
    if (!caso) {
      console.log(`[renovaciones][whatsapp] mensaje de ${telefono} sin caso de renovación asociado`);
      continue;
    }
    const conAdjunto = m.type === "image" || m.type === "document";
    const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title
      ?? m.image?.caption ?? m.document?.caption ?? "";
    try {
      await recibirMensaje(caso, texto, { canal: "whatsapp", conAdjunto, meta: { wa_id: m.id, tipo: m.type } });
    } catch (err) {
      await registrarMensaje({ caso_id: caso.id, direccion: "nota", canal: "sistema", tipo: "error",
        texto: `Error procesando mensaje: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  // Meta reintenta si no recibe 200: siempre confirmar recepción.
  return NextResponse.json({ ok: true });
}
