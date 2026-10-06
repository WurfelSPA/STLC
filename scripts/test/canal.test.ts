// Reglas de seguridad del canal WhatsApp: fuera de producción, SOLO casos del
// piloto y SOLO a teléfonos de la lista reciben mensajes reales.
// Ejecutar: npx tsx --tsconfig scripts/test/tsconfig.json scripts/test/canal.test.ts
import assert from "node:assert/strict";
import { db } from "./supabaseMock";
import { enviarRespuesta, enviarProactivo } from "@/app/lib/renovaciones/canal";
import type { Caso } from "@/app/lib/renovaciones/tipos";

process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_ID = "123";
delete process.env.WHATSAPP_TEMPLATE_D20;
db["renov_config"] = [{ clave: "piloto", valor: { telefonos: [{ nombre: "Alex", telefono: "56951120146", linea: "TRACKLINK", vehiculos: 1 }] } }];
db["renov_mensajes"] = [];

const enviados: string[] = [];
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  enviados.push(JSON.parse(init.body).to);
  return { ok: true, json: async () => ({ messages: [{ id: "wamid.1" }] }) };
}) as unknown as typeof fetch;

const caso = (o: Partial<Caso>) => ({ id: "c1", linea: "TRACKLINK", telefono: "56951120146", simulacion: false, piloto: true, ultima_interaccion: null, ...o }) as Caso;
const ultimoMeta = () => (db["renov_mensajes"].at(-1)!.meta as Record<string, unknown>);

(async () => {
  delete process.env.RENOV_BOT_MODO; // simulación (default)

  await enviarRespuesta(caso({}), "hola");
  assert.deepEqual(enviados, ["56951120146"], "piloto + teléfono en la lista: se envía");

  await enviarRespuesta(caso({ telefono: "56911111111" }), "hola");
  assert.equal(enviados.length, 1, "piloto con teléfono fuera de la lista: NO se envía");
  assert.match(String(ultimoMeta().no_enviado), /fuera de la lista/);

  await enviarRespuesta(caso({ piloto: false }), "hola");
  assert.equal(enviados.length, 1, "cliente real fuera de producción: NO se envía");

  await enviarRespuesta(caso({ simulacion: true }), "hola");
  assert.equal(enviados.length, 1, "simulación: nunca se envía");

  await enviarProactivo(caso({}), "D20", "recordatorio", []);
  assert.equal(enviados.length, 1, "sin plantilla y sin ventana de 24 h: NO se envía");
  assert.match(String(ultimoMeta().no_enviado), /24 h/);

  await enviarProactivo(caso({ ultima_interaccion: new Date().toISOString() }), "D20", "recordatorio", []);
  assert.equal(enviados.length, 2, "dentro de la ventana de 24 h: se envía como texto");

  process.env.RENOV_BOT_MODO = "produccion";
  await enviarRespuesta(caso({ piloto: false, telefono: "56922222222" }), "hola");
  assert.equal(enviados.length, 3, "en producción sí se escribe a clientes reales");

  console.log("Canal OK");
})().catch(e => { console.error(e); process.exit(1); });
