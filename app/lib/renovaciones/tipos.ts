// Tipos y constantes del Bot de Renovaciones. Sin dependencias de servidor:
// lo importan tanto el motor (server) como la UI (client).

export type Linea = "TRACKLINK" | "AUTOBAHN" | "TRACKCITY";

export const ESTADOS = [
  "PENDIENTE",          // caso creado, aún sin contacto
  "CONTACTADO",         // se envió el primer mensaje
  "EN_CONVERSACION",    // respondió, navegando el menú / consultas
  "INTERESADO",         // eligió renovar, viendo plazos
  "PAGO_PENDIENTE",     // confirmó plazo, se le envió el link de pago
  "PAGO_POR_VALIDAR",   // dice que pagó / mandó comprobante -> ejecutivo valida
  "RENOVADO",
  "NO_RENUEVA",
  "CAMBIO_VEHICULO",    // oportunidad comercial (traslado / nueva instalación)
  "REQUIERE_EJECUTIVO",
  "SIN_RESPUESTA",      // pasó el día 0 sin respuesta -> gestión manual
] as const;
export type Estado = (typeof ESTADOS)[number];

export const ESTADO_LABEL: Record<Estado, string> = {
  PENDIENTE: "Pendiente",
  CONTACTADO: "Contactado",
  EN_CONVERSACION: "En conversación",
  INTERESADO: "Interesado",
  PAGO_PENDIENTE: "Pago pendiente",
  PAGO_POR_VALIDAR: "Pago por validar",
  RENOVADO: "Renovado",
  NO_RENUEVA: "No renueva",
  CAMBIO_VEHICULO: "Cambio vehículo / Oportunidad",
  REQUIERE_EJECUTIVO: "Requiere ejecutivo",
  SIN_RESPUESTA: "Sin respuesta – gestión manual",
};

export const ESTADOS_CERRADOS: Estado[] = ["RENOVADO", "NO_RENUEVA"];

export type Paso =
  | "MENU"
  | "A_PLAZO" | "A_CONFIRMAR" | "A_PAGO"
  | "B_CONSULTA" | "B_RENOVAR" | "B_INSTALACION" | "B_VENTA"
  | "C_MOTIVO" | "C_OTRO"
  | "D_QUE_PASO" | "D1_OTRO_VEHICULO" | "D_NUEVA_PATENTE" | "D3_MOTIVO" | "D3_OTRO" | "D4_TEXTO"
  | "FIN";

export type Hito = "D30" | "D20" | "D10" | "D3" | "D0";
// Días antes del vencimiento en que corresponde cada contacto (sección 5).
export const HITOS: { hito: Hito; dias: number }[] = [
  { hito: "D30", dias: 30 },
  { hito: "D20", dias: 20 },
  { hito: "D10", dias: 10 },
  { hito: "D3", dias: 3 },
  { hito: "D0", dias: 0 },
];

export type Vehiculo = {
  imei: string;
  placa: string;
  marca: string;
  modelo: string;
  vence: string; // YYYY-MM-DD
};

export type Caso = {
  id: string;
  usuario: string;
  nombre: string | null;
  rut: string | null;
  telefono: string | null;
  correo: string | null;
  linea: Linea;
  segmento: string;
  cotiza_bot: boolean;
  tipo_cliente: "persona" | "empresa";
  vehiculos: Vehiculo[];
  cantidad_vehiculos: number;
  fecha_vencimiento: string;
  estado: Estado;
  paso: Paso;
  contexto: Record<string, unknown>;
  motivo: string | null;
  requiere_ejecutivo: boolean;
  atendido: boolean;
  plazo_meses: number | null;
  monto: number | null;
  nueva_fecha_vencimiento: string | null;
  trackgts_actualizado: boolean;
  hitos_enviados: Hito[];
  respondio: boolean;
  opt_out: boolean;
  cerrado_por: string | null;
  simulacion: boolean;
  creado_en: string;
  actualizado_en: string;
  ultima_interaccion: string | null;
};

export type Mensaje = {
  id: number;
  caso_id: string;
  direccion: "out" | "in" | "nota";
  canal: string;
  tipo: string | null;
  texto: string;
  meta: Record<string, unknown>;
  creado_en: string;
};

export type Precio = { meses: number; precio: number };

export type ConfigLinea = {
  nombre: string;
  link_pago: string | null;
  transferencia: string | null;
};

export type ConfigBot = {
  lineas: Record<Linea, ConfigLinea>;
  precios: Record<Linea, Precio[]>;
  callCenter: string | null;
};

export type Prioridad = "ALTA" | "MEDIA" | "BAJA";
