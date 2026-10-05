// Genera el SQL de carga de la planilla Trackcity (misma lógica que el botón
// "Subir CSV actualizado" del panel). Uso puntual / respaldo:
//   npx tsx scripts/trackcity-a-sql.ts <archivo.csv> <salida.sql>
import fs from "node:fs";
import { parsearTrackcity } from "../app/lib/renovaciones/importarTrackcity";

const [entrada, salida] = process.argv.slice(2);
const { filas } = parsearTrackcity(fs.readFileSync(entrada, "utf8"));
const json = JSON.stringify(filas.map(f => ({ ...f, linea: "TRACKCITY", importado_por: "carga-inicial" }))).replace(/'/g, "''");
const sql = `delete from public.renov_fuente_externa where linea = 'TRACKCITY';
insert into public.renov_fuente_externa (linea, cliente_key, nombre, rut, telefono, correo, placa, marca, modelo, vence, estatus, comentario, excluir, motivo_exclusion, fila_origen, importado_por)
select linea, cliente_key, nombre, rut, telefono, correo, placa, marca, modelo, vence, estatus, comentario, excluir, motivo_exclusion, fila_origen, importado_por
from jsonb_to_recordset('${json}'::jsonb) as x(linea text, cliente_key text, nombre text, rut text, telefono text, correo text, placa text, marca text, modelo text, vence date, estatus text, comentario text, excluir boolean, motivo_exclusion text, fila_origen int, importado_por text);
`;
fs.writeFileSync(salida, sql, "utf8");
console.log(`${filas.length} filas -> ${salida} (${sql.length} bytes)`);
