// Prueba del motor del Bot de Renovaciones (sin base ni red).
// Ejecutar: npx tsx scripts/test/motor.test.ts
import assert from "node:assert/strict";
import { procesarEntrada, type Clasificador } from "../../app/lib/renovaciones/motor";
import { clasificarPorReglas } from "../../app/lib/renovaciones/reglas";
import type { Caso, ConfigBot } from "../../app/lib/renovaciones/tipos";

const cfg: ConfigBot = {
  lineas: {
    TRACKLINK: { nombre: "Tracklink", link_pago: "https://pago/tl", transferencia: "TRACK LINK CHILE SPA" },
    AUTOBAHN: { nombre: "Autobahn", link_pago: "https://pago/ab", transferencia: null },
    TRACKCITY: { nombre: "Trackcity", link_pago: null, transferencia: null },
  },
  precios: {
    TRACKLINK: [{ meses: 12, precio: 174082 }, { meses: 24, precio: 278531 }, { meses: 36, precio: 376040 }, { meses: 48, precio: 466609 }],
    AUTOBAHN: [{ meses: 12, precio: 133280 }, { meses: 24, precio: 219167 }, { meses: 36, precio: 305054 }, { meses: 48, precio: 340941 }],
    TRACKCITY: [],
  },
  callCenter: null,
};

const clasificar: Clasificador = async t => ({ intencion: clasificarPorReglas(t) ?? "no_reconocida", fuente: "reglas" });

function nuevoCaso(over: Partial<Caso> = {}): Caso {
  return {
    id: "x", usuario: "FLOPEZ", nombre: "Francisca López", rut: "12345678-9", telefono: "56912345678", correo: "f@x.cl",
    linea: "TRACKLINK", segmento: "", cotiza_bot: true, tipo_cliente: "persona",
    vehiculos: [{ imei: "1", placa: "RPLB-98", marca: "MAZDA", modelo: "CX-5", vence: "2026-10-10" }],
    cantidad_vehiculos: 1, fecha_vencimiento: "2026-10-10", estado: "CONTACTADO", paso: "MENU", contexto: {},
    motivo: null, requiere_ejecutivo: false, atendido: false, plazo_meses: null, monto: null, nueva_fecha_vencimiento: null,
    trackgts_actualizado: false, hitos_enviados: ["D30"], respondio: false, opt_out: false, cerrado_por: null,
    simulacion: true, creado_en: "", actualizado_en: "", ultima_interaccion: null, ...over,
  };
}

// Aplica una secuencia de mensajes y devuelve el caso final + todo lo respondido.
async function conversar(caso: Caso, mensajes: (string | { adj: true })[]) {
  const log: string[] = [];
  for (const m of mensajes) {
    const texto = typeof m === "string" ? m : "";
    const r = await procesarEntrada(caso, texto, cfg, clasificar, typeof m !== "string");
    caso = { ...caso, ...r.patch } as Caso;
    log.push(`> ${texto || "[adjunto]"}`, ...r.respuestas.map(x => "< " + x.split("\n")[0]));
  }
  return { caso, log };
}

let ok = 0;
async function prueba(nombre: string, fn: () => Promise<void>) {
  try { await fn(); ok++; console.log("✔", nombre); }
  catch (e) { console.log("✘", nombre); throw e; }
}

(async () => {
  await prueba("A: renovar 24 meses con número, confirmar y pagar con comprobante", async () => {
    const { caso, log } = await conversar(nuevoCaso(), ["1", "2", "sí", { adj: true }]);
    assert.equal(caso.estado, "PAGO_POR_VALIDAR");
    assert.equal(caso.plazo_meses, 24);
    assert.equal(caso.monto, 278531);
    assert.equal(caso.requiere_ejecutivo, true);
    assert.ok(log.some(l => l.includes("Has seleccionado")));
  });

  await prueba("A: frases en vez de números ('quiero renovar', '2 años', 'dale')", async () => {
    const { caso } = await conversar(nuevoCaso(), ["Quiero renovar", "2 años", "dale"]);
    assert.equal(caso.estado, "PAGO_PENDIENTE");
    assert.equal(caso.plazo_meses, 24);
  });

  await prueba("A: flota de 3 vehículos cotiza total x3", async () => {
    const flota = nuevoCaso({
      cantidad_vehiculos: 3, tipo_cliente: "empresa",
      vehiculos: ["AA-11", "BB-22", "CC-33"].map((p, i) => ({ imei: String(i), placa: p, marca: "", modelo: "", vence: "2026-10-10" })),
    });
    const { caso } = await conversar(flota, ["1", "12 meses", "si"]);
    assert.equal(caso.monto, 174082 * 3);
  });

  await prueba("A: plan sin precio automático deriva a ejecutivo", async () => {
    const { caso } = await conversar(nuevoCaso({ cotiza_bot: false, segmento: "SANTANDER CONSUMER" }), ["1"]);
    assert.equal(caso.requiere_ejecutivo, true);
    assert.equal(caso.estado, "INTERESADO");
  });

  await prueba("A: dice que no en la confirmación vuelve al menú", async () => {
    const { caso } = await conversar(nuevoCaso(), ["1", "3", "no"]);
    assert.equal(caso.paso, "MENU");
    assert.equal(caso.monto, null);
  });

  await prueba("B: consulta precio -> ¿quieres renovar? sí -> plazos", async () => {
    const { caso } = await conversar(nuevoCaso(), ["2", "¿cuánto cuesta renovar?", "sí"]);
    assert.equal(caso.paso, "A_PLAZO");
  });

  await prueba("B: texto libre en el menú ('mi gps no funciona') deriva", async () => {
    const { caso } = await conversar(nuevoCaso(), ["mi gps no funciona"]);
    assert.equal(caso.requiere_ejecutivo, true);
    assert.equal(caso.motivo, "Problema con GPS");
  });

  await prueba("B: consulta no reconocida deriva con el mensaje del spec", async () => {
    const { caso, log } = await conversar(nuevoCaso(), ["2", "necesito el certificado para el seguro"]);
    assert.equal(caso.requiere_ejecutivo, true);
    assert.ok(log.some(l => l.includes("Voy a derivar tu solicitud")));
  });

  await prueba("C: hablar con ejecutivo, motivo descuento -> prioridad alta (origen C)", async () => {
    const { caso } = await conversar(nuevoCaso(), ["3", "1"]);
    assert.equal(caso.motivo, "Solicita precio o descuento");
    assert.equal(caso.contexto.origen, "C");
  });

  await prueba("D1: vendí, sin otro vehículo -> NO_RENUEVA vehículo vendido", async () => {
    const { caso } = await conversar(nuevoCaso(), ["4", "1", "no"]);
    assert.equal(caso.estado, "NO_RENUEVA");
    assert.equal(caso.motivo, "Vehículo vendido");
  });

  await prueba("D1: vendí, sí tengo otro -> CAMBIO_VEHICULO oportunidad", async () => {
    const { caso } = await conversar(nuevoCaso(), ["4", "lo vendí", "sí", "KXPT-21 Toyota RAV4"]);
    assert.equal(caso.estado, "CAMBIO_VEHICULO");
    assert.match(String(caso.motivo), /KXPT-21/);
  });

  await prueba("D: 'quiero traspasar mi GPS' en el menú va directo a pedir el nuevo vehículo", async () => {
    const { caso } = await conversar(nuevoCaso(), ["quiero traspasar mi gps a mi auto nuevo", "LKJH-22 Kia Sportage"]);
    assert.equal(caso.estado, "CAMBIO_VEHICULO");
    assert.match(String(caso.motivo), /LKJH-22/);
  });

  await prueba("D3: ya no uso, motivo precio -> NO_RENUEVA + alerta ejecutivo", async () => {
    const { caso } = await conversar(nuevoCaso(), ["4", "3", "1"]);
    assert.equal(caso.estado, "NO_RENUEVA");
    assert.equal(caso.requiere_ejecutivo, true);
  });

  await prueba("Dos respuestas no entendidas seguidas -> deriva", async () => {
    const { caso } = await conversar(nuevoCaso(), ["1", "mmm", "zzz"]);
    assert.equal(caso.requiere_ejecutivo, true);
  });

  await prueba("Opt-out", async () => {
    const { caso } = await conversar(nuevoCaso(), ["no me escriban más"]);
    assert.equal(caso.opt_out, true);
  });

  await prueba("MENÚ reinicia desde cualquier paso", async () => {
    const { caso } = await conversar(nuevoCaso(), ["1", "menu"]);
    assert.equal(caso.paso, "MENU");
  });

  console.log(`\n${ok} pruebas OK`);
})().catch(e => { console.error(e); process.exit(1); });
