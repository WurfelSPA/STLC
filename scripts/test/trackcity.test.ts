// Prueba del parser de la planilla Trackcity contra el CSV real.
// Ejecutar: npx tsx scripts/test/trackcity.test.ts [ruta-al-csv]
import assert from "node:assert/strict";
import fs from "node:fs";
import { parsearTrackcity, normalizarPatente } from "../../app/lib/renovaciones/importarTrackcity";

assert.equal(normalizarPatente("SBSV.82-9"), "SBSV-82");
assert.equal(normalizarPatente("rplb98"), "RPLB-98");
assert.equal(normalizarPatente("SBBX-65 VOLKSWAGEN SAVEIRO"), "SBBX-65");
assert.equal(normalizarPatente("SUZUKI SPRESSO PKSW-54"), "PKSW-54");
assert.equal(normalizarPatente("bus 06"), "");

const ruta = process.argv[2];
if (ruta) {
  const { filas, avisos } = parsearTrackcity(fs.readFileSync(ruta, "utf8"));
  const porPatente = (p: string) => filas.find(f => f.placa === p)!;

  // Formato antiguo con "Servicio hasta"
  assert.equal(porPatente("STRR-46").vence, "2026-10-23");
  // Formato antiguo sin "hasta": mes de la sección + día de "desde"
  assert.equal(porPatente("PKSW-54").vence, "2027-01-15", "queda solo el ciclo más reciente");
  assert.equal(filas.filter(f => f.placa === "PKSW-54").length, 1);
  assert.equal(filas.find(f => f.nombre.startsWith("ALAYEN"))!.vence, "2026-01-10", "desde 10/1/2025 en sección enero = D/M");
  // Formato nuevo (nov-2026): Vehiculo combinado
  const wl = filas.filter(f => f.nombre === "W&L");
  assert.equal(wl.length, 8);
  assert.ok(wl.every(f => f.cliente_key === wl[0].cliente_key), "flota W&L con la misma clave");
  assert.equal(porPatente("SBBX-65").marca, "VOLKSWAGEN");
  assert.equal(porPatente("SBBX-65").telefono, "56936158071");
  // Exclusiones
  assert.ok(porPatente("RPLB-98").excluir, "demo");
  assert.ok(porPatente("VDDT-34").excluir, "desinstaladas");
  assert.ok(!porPatente("STRR-46").excluir);

  const hoy = "2026-10-05";
  const proximas = filas.filter(f => f.vence && f.vence >= hoy && !f.excluir);
  console.log(`filas: ${filas.length} · excluidas: ${filas.filter(f => f.excluir).length} · sin fecha: ${filas.filter(f => !f.vence).length} · próximas (desde ${hoy}): ${proximas.length}`);
  for (const f of proximas) console.log(`  ${f.vence}  ${f.placa || f.modelo}  ${f.nombre}  tel:${f.telefono ?? "—"}${f.comentario ? `  [${f.comentario}]` : ""}`);
  console.log(`avisos: ${avisos.length}`);
  for (const a of avisos) console.log("  " + a);
}
console.log("Trackcity OK");
