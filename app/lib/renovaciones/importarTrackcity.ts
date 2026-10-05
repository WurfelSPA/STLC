// Parser de la planilla "Base de Datos Trackcity – Renovaciones Trackcity"
// (Google Sheet mantenido a mano por Tracklink, exportado como CSV).
// Trackcity no está en TrackGTS, así que esta planilla es su única fuente.
//
// La planilla trae secciones "Renovaciones <Mes> <Año>" y DOS formatos de
// columnas (hasta oct-2026: Marca/Modelo/Patente separados y "Servicio hasta"
// casi siempre vacío; desde nov-2026: "Vehiculo" = patente + marca/modelo y
// fechas ISO). Puro: sin base ni red, para poder probarlo.

import { normalizarTelefono } from "./formato";

export type FilaExterna = {
  fila_origen: number;
  cliente_key: string;
  nombre: string;
  rut: string | null;
  telefono: string | null;   // 569XXXXXXXX o null
  correo: string | null;
  placa: string;
  marca: string;
  modelo: string;
  vence: string | null;      // YYYY-MM-DD; null = no se pudo determinar
  estatus: string | null;
  comentario: string | null;
  excluir: boolean;
  motivo_exclusion: string | null;
};

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

// CSV con comillas (RFC 4180 básico).
export function parseCsv(texto: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) {
      if (ch === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (ch === '"') comillas = false;
      else campo += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === ",") { fila.push(campo); campo = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && texto[i + 1] === "\n") i++;
      fila.push(campo); filas.push(fila); fila = []; campo = "";
    } else campo += ch;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

const limpio = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const pad = (n: number) => String(n).padStart(2, "0");

function fechaValida(y: number, m: number, d: number): string | null {
  if (!(y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const f = new Date(Date.UTC(y, m - 1, d));
  if (f.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// "2026-11-11" | "10/15/2026" (M/D/Y, como exporta Sheets) -> YYYY-MM-DD
function fechaExplicita(s: string): string | null {
  const t = limpio(s);
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return fechaValida(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return fechaValida(+m[3], +m[1], +m[2]);
  return null;
}

// Formato antiguo: sin "Servicio hasta". El vencimiento es el mes/año de la
// sección con el DÍA de "Servicio desde". La planilla mezcla M/D y D/M, así
// que se usa la interpretación cuyo mes coincide con el de la sección; si
// ninguna coincide, la fecha queda sin determinar (el bot no inventa fechas).
function venceDesdeSeccion(desde: string, seccion: { mes: number; anio: number } | null): string | null {
  if (!seccion) return null;
  const m = limpio(desde).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  if (a === seccion.mes) return fechaValida(seccion.anio, seccion.mes, b); // M/D
  if (b === seccion.mes) return fechaValida(seccion.anio, seccion.mes, a); // D/M
  return null;
}

// Patentes chilenas: LLLL-NN (nuevas) o LL-NNNN (antiguas). La planilla trae
// "SBSV.82-9" (con dígito verificador), "RPLB98", "sdwr13", etc.
const RE_PATENTE = /\b([A-Z]{4})[\s.-]?(\d{2})\b|\b([A-Z]{2})[\s.-]?(\d{4})\b/;
export function normalizarPatente(raw: string): string {
  const m = limpio(raw).toUpperCase().match(RE_PATENTE);
  if (!m) return "";
  return m[1] ? `${m[1]}-${m[2]}` : `${m[3]}-${m[4]}`;
}

const RE_EXCLUIR = /no renovar|no renovar[aá]|desinstalad|\bdemo\b|dar de baja|vendi[oó]|no interesa|no quiere renovar|no corresponde/i;

function claveCliente(rut: string, nombre: string): string {
  const r = rut.toUpperCase().replace(/[^0-9K]/g, "");
  return r.length >= 7 ? `TC:${r}` : `TC:${nombre.toUpperCase()}`;
}

export function parsearTrackcity(texto: string): { filas: FilaExterna[]; avisos: string[] } {
  const filas: FilaExterna[] = [];
  const avisos: string[] = [];
  let seccion: { mes: number; anio: number } | null = null;
  let formatoNuevo = false;

  parseCsv(texto).forEach((c, i) => {
    const nro = i + 1;
    const c0 = limpio(c[0]);
    if (c.every(x => !limpio(x))) return;

    const sec = c0.match(/^renovaciones\s+([a-záéíóú]+)\s+(\d{4})/i);
    if (sec) {
      const mes = MESES[sec[1].toLowerCase()];
      seccion = mes ? { mes, anio: +sec[2] } : null;
      return;
    }
    if (/^mes$/i.test(c0)) { formatoNuevo = /vehiculo/i.test(limpio(c[2])); return; }
    const nombre = limpio(c[1]);
    if (!nombre) return;

    let placa: string, marca: string, modelo: string, desde: string, hasta: string, contacto: string,
      rut: string, correo: string, comentario: string, estatus: string;
    if (formatoNuevo) {
      // Mes, Nombre, Vehiculo, Desde, Hasta, Contacto, ID, Correo, Dirección, Comentario, Estatus
      const veh = limpio(c[2]);
      placa = normalizarPatente(veh);
      const partes = veh.toUpperCase().replace(RE_PATENTE, "").replace(/\s+/g, " ").trim().split(" ");
      marca = placa ? partes[0] ?? "" : "";
      modelo = placa ? partes.slice(1).join(" ") : veh;
      [desde, hasta, contacto, rut, correo] = [c[3], c[4], c[5], c[6], c[7]].map(limpio);
      [comentario, estatus] = [limpio(c[9]), limpio(c[10])];
    } else {
      // Mes, Nombre, Marca, Modelo, Patente, Año, Desde, Hasta, Contacto, ID, Correo, Dirección, Comentario, Estatus
      [marca, modelo] = [limpio(c[2]), limpio(c[3])];
      placa = normalizarPatente(c[4]);
      if (!placa && marca && !modelo) { modelo = marca; marca = ""; } // "TRANSPAR LDTA, 24" = n° de bus
      [desde, hasta, contacto, rut, correo] = [c[6], c[7], c[8], c[9], c[10]].map(limpio);
      [comentario, estatus] = [limpio(c[12]), limpio(c[13])];
    }

    const vence = fechaExplicita(hasta) ?? venceDesdeSeccion(desde, seccion);
    const telefono = normalizarTelefono(contacto);
    const motivos: string[] = [];
    const textoExcl = `${comentario} ${estatus}`;
    if (/desconectado/i.test(estatus)) motivos.push("Estatus: Desconectado");
    const m = textoExcl.match(RE_EXCLUIR);
    if (m) motivos.push(`Comentario: "${comentario || estatus}"`);
    if (!vence) avisos.push(`Fila ${nro} (${nombre} ${placa || modelo}): no se pudo determinar la fecha de vencimiento.`);
    if (contacto && !telefono) avisos.push(`Fila ${nro} (${nombre}): teléfono no válido "${contacto}".`);

    filas.push({
      fila_origen: nro,
      cliente_key: claveCliente(rut, nombre),
      nombre,
      rut: rut || null,
      telefono,
      correo: correo ? correo.replace(/\s+/g, "") : null,
      placa,
      marca,
      modelo,
      vence,
      estatus: estatus || null,
      comentario: comentario || null,
      excluir: motivos.length > 0,
      motivo_exclusion: motivos.join(" · ") || null,
    });
  });

  // La planilla es un historial: un mismo vehículo aparece una vez por ciclo
  // (ej. PKSW-54 renovó en dic-2025 y vuelve a aparecer para ene-2027). Se
  // conserva solo su ciclo más reciente, con su estatus/comentario.
  const actual = new Map<string, FilaExterna>();
  for (const f of filas) {
    const clave = f.placa ? `P:${f.placa}` : `${f.cliente_key}|${f.modelo.toUpperCase()}`;
    const previa = actual.get(clave);
    if (!previa || (f.vence ?? "") >= (previa.vence ?? "")) actual.set(clave, f);
  }
  return { filas: [...actual.values()], avisos };
}
