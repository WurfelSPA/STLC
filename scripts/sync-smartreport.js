#!/usr/bin/env node
'use strict';
/**
 * sync-smartreport.js
 *
 * Descarga diariamente el "Reporte TAG" de Smart Report (app.smartreport.cl,
 * API GraphQL en intermediate-v2.smartreport.cl) y usa sus montos REALES para
 * rellenar porticos_pasadas_reales.monto_smartreport — una segunda fuente de
 * verdad independiente de "Real" (que se ingresa a mano desde registrar.html),
 * pensada para medir qué tan cerca está la estimación GPS propia del cobro
 * real (objetivo: <1% de error, Smart Report reporta 3-10%).
 *
 * Flujo (investigado a mano 2026-09-03 con DevTools, ver conversación):
 *   1) mutation Login(usuario, clave) → cookies authToken/refreshToken.
 *   2) mutation FileExcelDialog(dateIni, dateEnd) → jobId (encola el reporte).
 *   3) mutation DownloadReportFile(jobId) → el .xlsx completo en base64
 *      (con reintentos: el job es async, puede no estar listo al toque).
 *   4) Se parsea el Excel, se mapea cada fila (concesión + descripción) a
 *      nuestro portico_codigo, y se busca la pasada CONFIRMADA de esa
 *      patente/pórtico más cercana en el tiempo (±10 min) para actualizar
 *      monto_smartreport — mismo criterio que ya se usa para "Real".
 *
 * Pide siempre los últimos SMARTREPORT_DIAS_ATRAS días completos (no un
 * checkpoint incremental): es liviano, y así no se pierde nada si un cobro
 * real tarda uno o dos días en aparecer en el reporte.
 *
 * Variables de entorno esperadas (GitHub Secrets):
 *   SR_USER, SR_PASSWORD, SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');
const XLSX = require('xlsx');
const crypto = require('crypto');

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY');
}
if (!process.env.SR_USER || !process.env.SR_PASSWORD) {
  throw new Error('Faltan SR_USER o SR_PASSWORD');
}
const supabase = createClient(
  'https://lomkolhgmkvshucqjuhf.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SR_URL = 'https://intermediate-v2.smartreport.cl/';
const SMARTREPORT_DIAS_ATRAS = 4;
const VENTANA_EMPAREJAR_MS = 10 * 60 * 1000; // ±10 min, igual que el resto del proyecto

// --- GraphQL: login + llamadas autenticadas ---------------------------------

async function graphqlCall(cookieHeader, headersExtra, operationName, query, variables) {
  const res = await fetch(SR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Origin/Referer van tal cual los mandaba el navegador en la captura
      // real — probable que el backend los valide (CORS/anti-bot), aunque
      // esto sea un cliente server-to-server, no un navegador de verdad.
      Origin: 'https://app.smartreport.cl',
      Referer: 'https://app.smartreport.cl/',
      Accept: '*/*',
      'Accept-Language': 'es-CL,es-419;q=0.9,es;q=0.8,en;q=0.7',
      // Node/undici no manda User-Agent de navegador por defecto — es una
      // señal fácil de bot para un backend con protección anti-fraude.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...headersExtra,
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  // getSetCookie() (no headers.get('set-cookie')) — el servidor manda VARIOS
  // headers Set-Cookie por separado (authToken, refreshToken), y .get() los
  // combina en un solo string con comas, ambiguo para parsear bien.
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL ${operationName} falló (HTTP ${res.status}): ${JSON.stringify(json.errors)}`);
  if (!json.data) throw new Error(`GraphQL ${operationName} sin "data" (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 500)}`);
  return { data: json.data, setCookies, status: res.status };
}

function extraerCookie(setCookies, nombre) {
  for (const c of setCookies) {
    const m = c.match(new RegExp(`^${nombre}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

const QUERY_LOGIN = `
  mutation Login($input: inputLogin) {
    login(input: $input) {
      token
      refreshToken
      logo
      displayName
      app_logo
      isTemporalPassword
    }
  }
`;

const QUERY_FILE_EXCEL_DIALOG = `
  mutation FileExcelDialog($input: inputDateTableDialog) {
    fileExcelDialog(input: $input)
  }
`;

const QUERY_DOWNLOAD_REPORT_FILE = `
  mutation DownloadReportFile($input: inputDownloadReportFile) {
    downloadReportFile(input: $input)
  }
`;

async function loginSmartReport(username, password) {
  const sessionid = crypto.randomUUID();
  // Antes de loguearse la app real manda "usuario" vacío en el header (recién
  // se llena una vez autenticado) — se replica por si el backend lo valida.
  const headersLogin = { usuario: '', displayname: '', language: 'es', sessionid };
  const { data, setCookies } = await graphqlCall(null, headersLogin, 'Login', QUERY_LOGIN, {
    input: { username, password },
  });
  // OJO: data.login.token/refreshToken vienen null a propósito (el server los
  // manda por Set-Cookie HttpOnly, no en el cuerpo JSON, por seguridad) —
  // los reales hay que sacarlos de ahí, no de "data".
  const authToken = extraerCookie(setCookies, 'authToken');
  const refreshToken = extraerCookie(setCookies, 'refreshToken');
  if (!authToken) throw new Error(`Login sin cookie authToken en la respuesta. set-cookie recibidas: ${JSON.stringify(setCookies)}`);
  const cookieHeader = `authToken=${authToken}; refreshToken=${refreshToken}`;
  const headers = { usuario: username, displayname: data.login.displayName || '', language: 'es', sessionid };
  return { cookieHeader, headers };
}

async function generarYDescargarExcel(cookieHeader, headers, dateIniStr, dateEndStr, displayName) {
  const { data: dJob } = await graphqlCall(cookieHeader, headers, 'FileExcelDialog', QUERY_FILE_EXCEL_DIALOG, {
    input: { dateIni: dateIniStr, dateEnd: dateEndStr, displayName },
  });
  const job = JSON.parse(Buffer.from(dJob.fileExcelDialog, 'base64').toString('utf8'));
  if (!job.success || !job.jobId) throw new Error(`FileExcelDialog no devolvió jobId: ${JSON.stringify(job)}`);

  // El job es async ("queued") — se reintenta unas cuantas veces con espera
  // en vez de pedirlo al toque, para darle tiempo a Smart Report a armarlo.
  const INTENTOS = 8;
  const ESPERA_MS = 4000;
  for (let intento = 1; intento <= INTENTOS; intento++) {
    await new Promise((r) => setTimeout(r, ESPERA_MS));
    try {
      const { data: dFile } = await graphqlCall(cookieHeader, headers, 'DownloadReportFile', QUERY_DOWNLOAD_REPORT_FILE, {
        input: { jobId: job.jobId },
      });
      const raw = dFile.downloadReportFile;
      if (raw && raw.startsWith('UEsDB')) return Buffer.from(raw, 'base64'); // firma ZIP (xlsx) en base64
      console.log(`[smartreport] jobId ${job.jobId} todavía no listo (intento ${intento}/${INTENTOS})...`);
    } catch (err) {
      console.log(`[smartreport] jobId ${job.jobId} error en intento ${intento}/${INTENTOS}: ${err.message}`);
    }
  }
  throw new Error(`DownloadReportFile no entregó el archivo tras ${INTENTOS} intentos (jobId ${job.jobId})`);
}

// --- Parseo del Excel y mapeo de códigos ------------------------------------

// Concesión → prefijo de la DESCRIPCION → nuestro portico_codigo. Ver
// dashboard.html/sync-tlchile.js (este mismo repo) para el catálogo
// completo — acá solo se traduce la nomenclatura pública de Smart Report a
// la nuestra. AUTOPISTA CENTRAL no necesita tabla: usa el mismo código tal
// cual (PA19, PA25, PA37...).
const MAP_VN = { P01: 'P1', P02: 'P2', P03: 'P3VN', P04: 'P4', P05: 'P5', P06: 'P6', P07: 'P7', P08: 'P8', P09: 'P9', P10: 'P10', P11: 'P11', P12: 'P12', P13: 'P13', P14: 'P14', P15: 'P15', P16: 'P16', P17: 'P17' };
const MAP_CN = { P0: 'P0', P3: 'P3', P4: 'P4CN', P5: 'P5CN', P7: 'P7CN', 'P8.0': 'P8.0', 'P8.1': 'P8.1', 'P8.2': 'P8.2', 'P8.3': 'P8.3' };
const MAP_VS = { 'P1.1': '1.1', 'P2.2': '2.2', 'P3.1': '3.1', 'P3.2': '3.2', 'P3.3': '3.3', 'P3.4': '3.4', 'P4.1': '4.1', 'P4.2': '4.2', 'P4.3': '4.3', 'P5.2': '5.2' };
const MAP_SK = { P101: 'PC101', P102: 'PC102' };

function codigoInterno(concesion, descripcion) {
  const primerToken = descripcion.trim().split(' ')[0];
  const c = concesion.toUpperCase();
  if (c === 'VESPUCIO NORTE EXPRESS') return MAP_VN[primerToken] || null;
  if (c === 'COSTANERA NORTE') return MAP_CN[primerToken] || null;
  if (c === 'VESPUCIO SUR') return MAP_VS[primerToken] || null;
  if (c.startsWith('TUNEL SAN CRISTOBAL')) return MAP_SK[primerToken] || null;
  if (c.startsWith('AUTOPISTA CENTRAL')) return primerToken; // PA19, PA37, etc — mismo nombre
  // VESPUCIO ORIENTE (AVO) queda afuera a propósito: factura por tramo
  // completo (ej. "P202 - P210"), no por pórtico individual — no hay forma
  // limpia de emparejarlo 1 a 1 contra nuestras detecciones por gantry.
  return null;
}

// Convierte "dd-mm-yyyy HH:MM" (hora Chile, tal como la entrega Smart
// Report) a un Date UTC real, con manejo correcto de cambio de día.
function fechaSmartReportAUtc(fechaStr) {
  const [fecha, hora] = fechaStr.trim().split(' ');
  const [dd, mm, yyyy] = fecha.split('-').map(Number);
  const [hh, min] = hora.split(':').map(Number);
  const local = new Date(Date.UTC(yyyy, mm - 1, dd, hh, min, 0));
  return new Date(local.getTime() + 4 * 3600 * 1000);
}

function extraerFilasDetalleAutopista(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: false, defval: '' });

  let inicio = -1;
  for (let i = 0; i < filas.length; i++) {
    if (String(filas[i][0]).trim() === 'PATENTE' && String(filas[i][1]).trim() === 'FECHA') { inicio = i + 1; break; }
  }
  if (inicio === -1) return [];

  const resultado = [];
  for (let i = inicio; i < filas.length; i++) {
    const [patente, fecha, concesion, descripcion, , tarifa] = filas[i];
    if (!patente || !fecha) break; // fila vacía = fin de la sección
    // TARIFA viene como texto con signo peso y separador de miles (ej.
    // "$1,537"), no como número — hay que limpiarlo antes de parsear.
    const monto = Number(String(tarifa).replace(/[^0-9.-]/g, ''));
    if (!patente || !fecha || !concesion || !descripcion || !Number.isFinite(monto)) continue;
    resultado.push({ patente: String(patente).trim(), fecha: String(fecha).trim(), concesion: String(concesion).trim(), descripcion: String(descripcion).trim(), monto });
  }
  return resultado;
}

// --- Emparejamiento contra porticos_pasadas_reales --------------------------

async function emparejarYActualizar(filas) {
  const vehiculoIdPorPatente = new Map();
  let actualizadas = 0;
  let sinMapear = 0;
  let sinPasada = 0;

  for (const fila of filas) {
    const codigo = codigoInterno(fila.concesion, fila.descripcion);
    if (!codigo) { sinMapear++; continue; }

    if (!vehiculoIdPorPatente.has(fila.patente)) {
      const { data: vehiculo, error } = await supabase.from('porticos_vehiculos').select('id').eq('patente', fila.patente).maybeSingle();
      if (error) throw new Error(`Error buscando vehículo ${fila.patente}: ${error.message}`);
      vehiculoIdPorPatente.set(fila.patente, vehiculo?.id ?? null);
    }
    const vehiculoId = vehiculoIdPorPatente.get(fila.patente);
    if (!vehiculoId) { sinPasada++; continue; } // patente no rastreada por este sistema

    const tsReporte = fechaSmartReportAUtc(fila.fecha);
    const { data: candidatas, error: errCand } = await supabase
      .from('porticos_pasadas_reales')
      .select('id, ts')
      .eq('vehiculo_id', vehiculoId)
      .eq('portico_codigo', codigo)
      .eq('confirmado', true)
      .gte('ts', new Date(tsReporte.getTime() - VENTANA_EMPAREJAR_MS).toISOString())
      .lte('ts', new Date(tsReporte.getTime() + VENTANA_EMPAREJAR_MS).toISOString());
    if (errCand) throw new Error(`Error buscando pasada ${fila.patente}/${codigo}: ${errCand.message}`);
    if (!candidatas || !candidatas.length) { sinPasada++; continue; }

    let mejor = candidatas[0];
    let mejorDiff = Math.abs(new Date(mejor.ts).getTime() - tsReporte.getTime());
    for (const c of candidatas.slice(1)) {
      const diff = Math.abs(new Date(c.ts).getTime() - tsReporte.getTime());
      if (diff < mejorDiff) { mejor = c; mejorDiff = diff; }
    }

    const { error: errUpdate } = await supabase.from('porticos_pasadas_reales').update({ monto_smartreport: fila.monto }).eq('id', mejor.id);
    if (errUpdate) throw new Error(`Error actualizando pasada ${mejor.id}: ${errUpdate.message}`);
    actualizadas++;
  }

  console.log(`[smartreport] ${actualizadas} pasadas actualizadas, ${sinPasada} sin pasada confirmada cercana, ${sinMapear} filas sin código mapeado (AVO u otro código nuevo).`);
}

// --- main --------------------------------------------------------------------

function fmtSR(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

async function main() {
  const { cookieHeader, headers } = await loginSmartReport(process.env.SR_USER, process.env.SR_PASSWORD);
  console.log('[smartreport] Login OK.');

  const hoy = new Date();
  const desde = new Date(hoy.getTime() - SMARTREPORT_DIAS_ATRAS * 24 * 3600 * 1000);
  const dateIni = `${fmtSR(desde)} 00:00`;
  const dateEnd = `${fmtSR(hoy)} 23:59`;

  console.log(`[smartreport] Generando reporte ${dateIni} → ${dateEnd}...`);
  const buffer = await generarYDescargarExcel(cookieHeader, headers, dateIni, dateEnd, headers.displayname || process.env.SR_USER);
  console.log(`[smartreport] Excel descargado (${buffer.length} bytes).`);

  const filas = extraerFilasDetalleAutopista(buffer);
  console.log(`[smartreport] ${filas.length} filas de cobro leídas.`);
  await emparejarYActualizar(filas);
}

main().catch((err) => {
  console.error('ERROR FATAL:', err.message);
  process.exit(1);
});
