import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { INTENCIONES, clasificarPorReglas, type Intencion } from "./reglas";

// Clasificación de texto libre del cliente. Primero reglas (gratis,
// deterministas); si ninguna calza, Claude elige UNA etiqueta del enum. La IA
// nunca redacta la respuesta al cliente — eso sale de textos.ts + la base.

const SalidaSchema = z.object({ intencion: z.enum(INTENCIONES) });

const SISTEMA = `Clasificas mensajes de clientes chilenos de un servicio de GPS vehicular (Tracklink/Autobahn/Trackcity) que están por renovar su servicio.
Devuelve SOLO la intención que mejor describe el mensaje, de esta lista:
- renovar: quiere renovar/continuar el servicio
- precio: pregunta cuánto cuesta / valores
- vigencia: pregunta cuándo vence su servicio
- formas_pago: pregunta cómo pagar
- ya_pague: dice que ya pagó o envía comprobante
- cambio_vehiculo: quiere pasar el servicio a otro vehículo
- cambio_patente: necesita corregir/actualizar la patente
- problema_app: problemas con la aplicación
- problema_gps: el GPS no funciona / no reporta
- servicio_suspendido: su servicio está suspendido o cortado
- venta_vehiculo: vendió o va a vender el vehículo
- instalacion: quiere instalar un equipo
- desinstalacion: quiere retirar el equipo
- varios_vehiculos: quiere renovar o consultar por más de un vehículo
- hablar_ejecutivo: pide hablar con una persona
- no_tengo_vehiculo: ya no tiene el vehículo (sin más detalle)
- no_quiere_renovar: no quiere renovar / quiere cancelar
- baja_mensajes: pide no recibir más mensajes
- no_reconocida: cualquier otra cosa, saludos sin intención, o si dudas
Ante cualquier duda responde no_reconocida.`;

let cliente: Anthropic | null = null;

// Sin ANTHROPIC_API_KEY (o si la llamada falla) devuelve "no_reconocida" y el
// bot deriva a ejecutivo — nunca bloquea la conversación.
export async function clasificarConIA(texto: string): Promise<Intencion> {
  if (!process.env.ANTHROPIC_API_KEY) return "no_reconocida";
  cliente ??= new Anthropic({ timeout: 20_000, maxRetries: 1 });
  try {
    const res = await cliente.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 1024,
      output_config: { effort: "low", format: zodOutputFormat(SalidaSchema) },
      system: SISTEMA,
      messages: [{ role: "user", content: texto.slice(0, 2000) }],
    });
    if (res.stop_reason === "refusal") return "no_reconocida";
    return res.parsed_output?.intencion ?? "no_reconocida";
  } catch (err) {
    console.error("[renovaciones][clasificador] error IA:", err instanceof Error ? err.message : err);
    return "no_reconocida";
  }
}

export async function clasificar(texto: string): Promise<{ intencion: Intencion; fuente: "reglas" | "ia" }> {
  const porReglas = clasificarPorReglas(texto);
  if (porReglas) return { intencion: porReglas, fuente: "reglas" };
  return { intencion: await clasificarConIA(texto), fuente: "ia" };
}
