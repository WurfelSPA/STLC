// Intenciones del bot y clasificación por palabras clave (puro, sin red).
// La IA (clasificador.ts) solo entra si ninguna regla calza.
import { sinAcentos } from "./formato";

export const INTENCIONES = [
  "renovar",
  "precio",
  "vigencia",
  "formas_pago",
  "ya_pague",
  "cambio_vehiculo",
  "cambio_patente",
  "problema_app",
  "problema_gps",
  "servicio_suspendido",
  "venta_vehiculo",
  "instalacion",
  "desinstalacion",
  "varios_vehiculos",
  "hablar_ejecutivo",
  "no_tengo_vehiculo",
  "no_quiere_renovar",
  "baja_mensajes",
  "no_reconocida",
] as const;
export type Intencion = (typeof INTENCIONES)[number];

// El orden importa: la primera regla que calza gana.
const REGLAS: { intencion: Intencion; patrones: RegExp[] }[] = [
  { intencion: "baja_mensajes", patrones: [/no me (escriban|manden|envien)/, /\bstop\b/, /no quiero (mas )?mensajes/] },
  { intencion: "ya_pague", patrones: [/\bya pague\b/, /\bpague\b/, /comprobante/, /transferi/, /\bdeposite\b/] },
  { intencion: "no_quiere_renovar", patrones: [/no (quiero|deseo|voy a) renovar/, /\bcancelar\b/, /no me interesa/, /\bdar de baja\b/] },
  { intencion: "venta_vehiculo", patrones: [/\bvend(i|o|er|iendo)\b/, /venta del (auto|vehiculo)/] },
  { intencion: "cambio_vehiculo", patrones: [/traspas/, /cambi\w* (de |el |mi )?(auto|vehiculo|camioneta|carro)/, /(auto|vehiculo) nuevo/, /otro (auto|vehiculo)/] },
  { intencion: "no_tengo_vehiculo", patrones: [/ya no tengo/, /no tengo (el|ese|este) (auto|vehiculo)/] },
  { intencion: "cambio_patente", patrones: [/cambi\w* (de |la )?patente/, /patente (nueva|distinta|equivocada)/] },
  { intencion: "problema_app", patrones: [/\bapp\b/, /aplicacion/, /no (puedo|logro) (entrar|ingresar)/, /contrasena/] },
  { intencion: "problema_gps", patrones: [/\bgps\b/, /no (aparece|marca|reporta)/, /ubicacion/, /no funciona/] },
  { intencion: "servicio_suspendido", patrones: [/suspendid/, /cortaron/, /bloquead/] },
  { intencion: "desinstalacion", patrones: [/desinstal/, /retirar (el )?(gps|equipo)/, /sacar (el )?(gps|equipo)/] },
  { intencion: "instalacion", patrones: [/\binstal/] },
  { intencion: "varios_vehiculos", patrones: [/(varios|mas de un|dos|tres) (autos|vehiculos)/] },
  { intencion: "formas_pago", patrones: [/(forma|medio|metodo)s? de pago/, /como (pago|puedo pagar)/, /transferencia/, /tarjeta/, /cuotas/] },
  { intencion: "vigencia", patrones: [/vigencia/, /cuando (vence|caduca)/, /hasta cuando/, /fecha de vencimiento/] },
  { intencion: "precio", patrones: [/precio/, /cuanto (cuesta|sale|vale|es)/, /\bvalor\b/, /\bcosto\b/, /tarifa/] },
  { intencion: "hablar_ejecutivo", patrones: [/ejecutiv/, /\bpersona\b/, /humano/, /asesor/, /hablar con/, /llam(en|ar)me/] },
  { intencion: "renovar", patrones: [/renov/, /\bcontinuar\b/, /\bquiero seguir\b/] },
];

export function clasificarPorReglas(texto: string): Intencion | null {
  const t = sinAcentos(texto);
  for (const r of REGLAS) if (r.patrones.some(p => p.test(t))) return r.intencion;
  return null;
}
