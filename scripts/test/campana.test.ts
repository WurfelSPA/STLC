// Prueba de la campaña diaria con base en memoria.
// Ejecutar: npx tsx --tsconfig scripts/test/tsconfig.json scripts/test/campana.test.ts
import assert from "node:assert/strict";
import { db } from "./supabaseMock";
import { ejecutarCampana } from "@/app/lib/renovaciones/campana";
import { validarPago } from "@/app/lib/renovaciones/servicio";
import type { Caso } from "@/app/lib/renovaciones/tipos";

const fila = (o: Record<string, string>) => ({
  IMEI: o.imei, Placa: o.placa, Marca: "MAZDA", Modelo: "CX-5", "Serv. Hasta": `${o.vence}T00:00:00`,
  "Servicio Comercial": o.sc ?? "", Usuario: o.usuario, Nombre: o.nombre ?? "Cliente", Apellido: "Prueba",
  "Cust ID": o.rut ?? "12345678-9", Telefono: o.tel ?? "912345678", Correo: "c@x.cl", "Fecha Ultimo Reporte": o.rep ?? "2026-10-01",
});

db["Tracklink"] = [
  fila({ imei: "1", placa: "AAAA-11", vence: "2026-11-02", usuario: "persona1" }),                       // Tracklink, 1 vehículo
  fila({ imei: "2", placa: "BBBB-22", vence: "2026-10-25", usuario: "empresa", rut: "76123456-7" }),    // flota de 3
  fila({ imei: "3", placa: "CCCC-33", vence: "2026-10-28", usuario: "empresa", rut: "76123456-7" }),
  fila({ imei: "4", placa: "DDDD-44", vence: "2026-11-25", usuario: "empresa", rut: "76123456-7" }),    // aún fuera de ventana
  fila({ imei: "5", placa: "EEEE-55", vence: "2026-11-03", usuario: "auto1", sc: "AUTOBAHN NUEVOS" }),  // Autobahn
  fila({ imei: "6", placa: "FFFF-66", vence: "2026-11-01", usuario: "sintel", tel: "123" }),              // sin móvil
  fila({ imei: "7", placa: "GGGG-77", vence: "2026-11-04", usuario: "bodega" }),                          // excluido
  fila({ imei: "8", placa: "HHHH-88", vence: "2026-11-04", usuario: "demo", sc: "zzz Demo-Test" }),       // excluido
  fila({ imei: "9", placa: "AAAA-11", vence: "2025-01-01", usuario: "persona1", rep: "2024-01-01" }),     // fila vieja misma patente
  fila({ imei: "10", placa: "IIII-99", vence: "2027-03-01", usuario: "lejos" }),                          // fuera de ventana
];
db["renov_segmentos"] = [
  { servicio_comercial: "", linea: "TRACKLINK", cotiza_bot: true, excluir: false },
  { servicio_comercial: "AUTOBAHN NUEVOS", linea: "AUTOBAHN", cotiza_bot: true, excluir: false },
  { servicio_comercial: "zzz Demo-Test", linea: "TRACKLINK", cotiza_bot: false, excluir: true },
];
db["renov_config"] = [
  { clave: "general", valor: { usuarios_excluidos: ["bodega"] } },
  { clave: "linea:TRACKLINK", valor: { nombre: "Tracklink", link_pago: "https://x", transferencia: null } },
];
db["renov_precios"] = [12, 24, 36, 48].map((m, i) => ({ linea: "TRACKLINK", meses: m, precio: 100 * (i + 1), vigente: true }));

const casos = () => db["renov_casos"] as unknown as Caso[];
const caso = (u: string) => casos().find(c => c.usuario === u)!;
const salientes = (u: string) => (db["renov_mensajes"] ?? []).filter(m => m.caso_id === caso(u).id && m.direccion === "out");

(async () => {
  // Día 1: 30 días antes del primer vencimiento.
  let r = await ejecutarCampana("2026-10-04", true);
  assert.equal(r.casosNuevos, 4, "persona1, empresa(flota), auto1, sintel");
  assert.equal(caso("empresa").cantidad_vehiculos, 2, "flota: solo los 2 que vencen dentro de 30 días");
  assert.equal(caso("empresa").tipo_cliente, "empresa");
  assert.equal(caso("persona1").vehiculos.length, 1, "deduplicado por patente");
  assert.equal(caso("auto1").linea, "AUTOBAHN");
  assert.equal(caso("persona1").telefono, "56912345678");
  assert.equal(r.envios.D30, 3);
  assert.equal(r.sinTelefono, 1);
  assert.equal(caso("sintel").requiere_ejecutivo, true);
  assert.match(String(salientes("persona1")[0].texto), /Somos Tracklink/);
  console.log("✔ Día 30: casos creados, flota consolidada, exclusiones, primer contacto");

  // Repetir el mismo día no duplica nada.
  r = await ejecutarCampana("2026-10-04", true);
  assert.equal(r.casosNuevos, 0);
  assert.equal(r.envios.D30, 0);
  console.log("✔ Idempotente en el mismo día");

  // Día 20 para persona1 (la flota, que vence antes, también recibe su D20).
  r = await ejecutarCampana("2026-10-13", true);
  assert.equal(r.envios.D20, 2);
  assert.match(String(salientes("persona1").at(-1)!.texto), /vence en 20 días/);
  assert.match(String(salientes("empresa").at(-1)!.texto), /tus 2 vehículos \(BBBB-22, CCCC-33\)/);
  console.log("✔ Día 20: recordatorio (flota consolidada en un solo mensaje)");

  // El cliente de Autobahn ya renovó por fuera: TrackGTS muestra nueva fecha.
  (db["Tracklink"].find(f => f.IMEI === "5")!)["Serv. Hasta"] = "2027-11-03T00:00:00";
  // persona1 avisó que pagó -> no debe recibir más recordatorios.
  Object.assign(caso("persona1"), { estado: "PAGO_POR_VALIDAR", requiere_ejecutivo: true, respondio: true, plazo_meses: 24 });
  r = await ejecutarCampana("2026-10-23", true);
  assert.equal(r.renovadosFueraDelBot, 1);
  assert.equal(caso("auto1").estado, "RENOVADO");
  assert.equal(caso("auto1").cerrado_por, "externo");
  assert.equal(salientes("persona1").length, 2, "sin recordatorio con pago por validar");
  console.log("✔ Día 10: detecta renovación hecha en TrackGTS y no molesta a quien ya pagó");

  // El ejecutivo valida el pago de persona1.
  await validarPago(caso("persona1").id, 24, "test");
  assert.equal(caso("persona1").estado, "RENOVADO");
  assert.equal(caso("persona1").nueva_fecha_vencimiento, "2028-11-02");
  assert.match(String(salientes("persona1").at(-1)!.texto), /Nuevo vencimiento: 2 de noviembre de 2028/);
  console.log("✔ Validación de pago -> RENOVADO + confirmación con nueva fecha");

  // El 23-oct la flota estaba a 2 días -> recibió D3. Día 0 = 25-oct.
  assert.match(String(salientes("empresa").at(-1)!.texto), /vence en 2 días/);
  r = await ejecutarCampana("2026-10-25", true);
  assert.equal(r.envios.D0, 1);
  assert.match(String(salientes("empresa").at(-1)!.texto), /venció hoy/);
  console.log("✔ Día 3 y día 0");

  // Al día siguiente sin respuesta -> gestión manual. (Además entra a la
  // ventana el 3er vehículo de la flota, que vence el 25-nov -> caso nuevo.)
  r = await ejecutarCampana("2026-10-26", true);
  assert.equal(r.casosNuevos, 1);
  assert.equal(caso("empresa").estado, "SIN_RESPUESTA");
  assert.equal(caso("empresa").requiere_ejecutivo, true);
  console.log("✔ Sin respuesta tras día 0 -> gestión manual");

  // TrackGTS ya refleja la renovación de persona1 -> se marca actualizado.
  (db["Tracklink"].find(f => f.IMEI === "1")!)["Serv. Hasta"] = "2028-11-02T00:00:00";
  await ejecutarCampana("2026-11-07", true);
  assert.equal(caso("persona1").trackgts_actualizado, true);
  console.log("✔ Detecta cuando TrackGTS ya tiene la nueva fecha");

  console.log("\nCampaña OK");
})().catch(e => { console.error(e); process.exit(1); });
