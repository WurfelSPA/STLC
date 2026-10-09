import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { obtenerCasoPorTelefono, registrarMensaje } from "@/app/lib/renovaciones/datos";
import { recibirAudioSinTranscripcion, recibirMensaje } from "@/app/lib/renovaciones/servicio";
import { normalizarTelefono } from "@/app/lib/renovaciones/formato";
import { getSupabaseAdmin } from "@/app/lib/supabaseAdmin";

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

// Diagnóstico visible en el panel (pestaña Piloto): una fila por aviso de
// Meta, sin el contenido de los mensajes.
async function log(resultado: string, telefono: string | null, detalle: string | null = null) {
  await getSupabaseAdmin().from("renov_webhook_log")
    .insert({ resultado, telefono, detalle: detalle?.slice(0, 300) ?? null })
    .then(({ error }) => { if (error) console.error("[renovaciones][whatsapp] log:", error.message); });
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!process.env.WHATSAPP_APP_SECRET) {
    await log("sin_secreto", null, "Falta WHATSAPP_APP_SECRET en Vercel");
    return new NextResponse("Firma inválida", { status: 401 });
  }
  if (!firmaValida(raw, request.headers.get("x-hub-signature-256"))) {
    await log("firma_invalida", null, "La firma no calza: WHATSAPP_APP_SECRET distinto a la clave secreta de la app en Meta");
    return new NextResponse("Firma inválida", { status: 401 });
  }
  const body = JSON.parse(raw);
  type Cambio = { field?: string; value?: { messages?: WaMensaje[]; statuses?: { status: string; recipient_id: string; errors?: { title?: string }[] }[] } };
  const cambios: Cambio[] = (body.entry ?? []).flatMap((e: { changes?: Cambio[] }) => e.changes ?? []);
  const mensajes = cambios.flatMap(c => c.value?.messages ?? []);
  // Estados de entrega con error (ej. número fuera de la lista de prueba de Meta).
  for (const s of cambios.flatMap(c => c.value?.statuses ?? [])) {
    if (s.status === "failed") await log("envio_fallido", s.recipient_id, s.errors?.[0]?.title ?? "failed");
  }
  if (!mensajes.length && !cambios.some(c => c.value?.statuses?.length)) {
    await log("sin_mensajes", null, `campos: ${cambios.map(c => c.field).join(", ") || "—"}`);
  }

  for (const m of mensajes) {
    const telefono = normalizarTelefono(m.from);
    if (!telefono) { await log("telefono_no_valido", m.from); continue; }
    const caso = await obtenerCasoPorTelefono(telefono);
    if (!caso) {
      await log("sin_caso", telefono, "No hay caso de renovación (o del piloto) para este número");
      continue;
    }
    await log("ok", telefono, m.type);
    if (m.type === "audio") {
      await recibirAudioSinTranscripcion(caso, { wa_id: m.id, tipo: m.type });
      continue;
    }
    const conAdjunto = m.type === "image" || m.type === "document";
    const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title
      ?? m.image?.caption ?? m.document?.caption ?? "";
    try {
      await recibirMensaje(caso, texto, { canal: "whatsapp", conAdjunto, meta: { wa_id: m.id, tipo: m.type } });
    } catch (err) {
      await log("error", telefono, err instanceof Error ? err.message : String(err));
      await registrarMensaje({ caso_id: caso.id, direccion: "nota", canal: "sistema", tipo: "error",
        texto: `Error procesando mensaje: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  // Meta reintenta si no recibe 200: siempre confirmar recepción.
  return NextResponse.json({ ok: true });
}
