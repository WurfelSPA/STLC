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
 *   1) mutation Login(usuario, clave) → cookies authToken/refreshToken
 *      (HttpOnly — vienen por Set-Cookie, el campo "token" del cuerpo JSON
 *      siempre es null a propósito).
 *   2) mutation ReportTagMultas(patentes, dateIni, dateEnd) → JSON directo
 *      con cada pase de pórtico (data.reportTagMultas.data.reportTAG). Se
 *      probó primero el camino de generar/descargar el Excel
 *      (FileExcelDialog + DownloadReportFile) pero ese endpoint solo
 *      EMPAQUETA datos que el cliente ya tiene — ReportTagMultas es la
 *      fuente real y devuelve JSON limpio, sin pasar por Excel.
 *   3) Se mapea cada fila (concesión + descripción) a nuestro
 *      portico_codigo, y se busca la pasada CONFIRMADA de esa
 *      patente/pórtico más cercana en el tiempo (±10 min) para actualizar
 *      monto_smartreport — mismo criterio que ya usa "Real".
 *
 * Pide siempre los últimos SMARTREPORT_DIAS_ATRAS días completos (no un
 * checkpoint incremental): es liviano, y así no se pierde nada si un cobro
 * real tarda uno o dos días en aparecer en el reporte.
 *
 * Variables de entorno esperadas (GitHub Secrets):
 *   SR_USER, SR_PASSWORD, SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');
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

// Patentes a consultar en Smart Report — cada una con su "provider" interno
// (id de la conexión GPS dentro de la cuenta de Smart Report, NO tiene
// relación con nuestro unit_id de TrackGTS). Agregar acá si se suma otra
// patente a esta misma cuenta.
const PATENTES_SMARTREPORT = [{ patente: 'VVJG-14', provider: '54' }];

// --- GraphQL: login + llamadas autenticadas ---------------------------------

async function graphqlCall(cookieHeader, headersExtra, operationName, query, variables) {
  const res = await fetch(SR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Origin/Referer/User-Agent tal cual los manda el navegador real —
      // el backend parece validarlos (con Node/undici "de fábrica" el login
      // fallaba en silencio).
      Origin: 'https://app.smartreport.cl',
      Referer: 'https://app.smartreport.cl/',
      Accept: '*/*',
      'Accept-Language': 'es-CL,es-419;q=0.9,es;q=0.8,en;q=0.7',
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
  return { data: json.data, setCookies };
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

const QUERY_REPORT_TAG_MULTAS = `
  mutation ReportTagMultas($input: vehiculoInput) {
    reportTagMultas(input: $input) {
      data {
        reportTAG {
          tipo_portico
          tarifa
          rpt_fecha
          portico
          patente
          km
          id_portico
          fecha
          coord_y
          coord_x
          auto_tipo_nombre
          auto_tipo_id
          auto_nombre
          __typename
        }
        __typename
      }
      __typename
    }
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
  // El campo "usuario" que usan las siguientes consultas (ReportTagMultas,
  // etc.) es el nombre de la CUENTA/empresa (ej. "transrent"), no el
  // username individual de login — se deriva del displayName que devuelve
  // el login (confirmado con una captura real: displayName "Transrent" ==
  // usuario "transrent" en minúsculas).
  const cuenta = (data.login.displayName || '').toLowerCase();
  const headers = { usuario: username, displayname: data.login.displayName || '', language: 'es', sessionid };
  return { cookieHeader, headers, cuenta };
}

async function obtenerPasesTag(cookieHeader, headers, cuenta, dateIniStr, dateEndStr) {
  const { data } = await graphqlCall(cookieHeader, headers, 'ReportTagMultas', QUERY_REPORT_TAG_MULTAS, {
    input: {
      patentes: PATENTES_SMARTREPORT,
      dateIni: dateIniStr,
      dateEnd: dateEndStr,
      getGPX: 0,
      reprocesar: false,
      usuario: cuenta,
    },
  });
  // data.reportTAG viene como arreglo DE arreglos: un arreglo interno de
  // pases por cada patente consultada (confirmado 2026-09-03 con dump
  // crudo) — .flat() lo aplana sea 1 o varias patentes en PATENTES_SMARTREPORT.
  return (data?.reportTagMultas?.data?.reportTAG || []).flat();
}

// --- Mapeo de códigos ---------------------------------------------------------

// Concesión → prefijo de PORTICO → nuestro portico_codigo. Ver
// dashboard.html/sync-tlchile.js (este mismo repo) para el catálogo
// completo — acá solo se traduce la nomenclatura pública de Smart Report a
// la nuestra. AUTOPISTA CENTRAL no necesita tabla: usa el mismo código tal
// cual (PA19, PA25, PA37...).
const MAP_VN = { P01: 'P1', P02: 'P2', P03: 'P3VN', P04: 'P4', P05: 'P5', P06: 'P6', P07: 'P7', P08: 'P8', P09: 'P9', P10: 'P10', P11: 'P11', P12: 'P12', P13: 'P13', P14: 'P14', P15: 'P15', P16: 'P16', P17: 'P17' };
const MAP_CN = { P0: 'P0', P3: 'P3', P4: 'P4CN', P5: 'P5CN', P7: 'P7CN', 'P8.0': 'P8.0', 'P8.1': 'P8.1', 'P8.2': 'P8.2', 'P8.3': 'P8.3' };
const MAP_VS = { 'P1.1': '1.1', 'P2.2': '2.2', 'P3.1': '3.1', 'P3.2': '3.2', 'P3.3': '3.3', 'P3.4': '3.4', 'P4.1': '4.1', 'P4.2': '4.2', 'P4.3': '4.3', 'P5.2': '5.2' };
const MAP_SK = { P101: 'PC101', P102: 'PC102' };

function codigoInterno(concesion, portico) {
  const primerToken = portico.trim().split(' ')[0];
  const c = concesion.toUpperCase();
  if (c === 'VESPUCIO NORTE EXPRESS') return MAP_VN[primerToken] || null;
  if (c === 'COSTANERA NORTE') return MAP_CN[primerToken] || null;
  if (c === 'VESPUCIO SUR') return MAP_VS[primerToken] || null;
  if (c.startsWith('TUNEL SAN CRISTOBAL')) return MAP_SK[primerToken] || null;
  if (c.startsWith('AUTOPISTA CENTRAL')) return primerToken; // PA19, PA37, etc — mismo nombre
  // VESPUCIO ORIENTE (AVO) no tiene código 1 a 1: factura por TRAMO completo
  // (ej. "P202 - P211 Tobalaba"), no por pórtico individual — se maneja
  // aparte en emparejarYActualizar (ver EsVespucioOriente más abajo).
  return null;
}

function esVespucioOriente(concesion) {
  return concesion.trim().toUpperCase() === 'VESPUCIO ORIENTE';
}

// Ventana ancha para AVO: un trayecto real por el túnel hasta Tobalaba (u
// otro tramo) puede tomar bastante más que los ±10 min que alcanzan para un
// pórtico puntual — confirmado 2026-09-04 con 3 trayectos reales seguidos
// (1, 2 y 3 de sept) que el usuario tuvo que confirmar a mano porque el
// sistema los había descartado por error.
const VENTANA_AVO_MS = 40 * 60 * 1000;

// --- Emparejamiento contra porticos_pasadas_reales --------------------------

async function emparejarYActualizar(filas) {
  const vehiculoIdPorPatente = new Map();
  let actualizadas = 0;
  let sinMapear = 0;
  let sinPasada = 0;

  for (const fila of filas) {
    // Defensivo: se vio en producción una fila sin "portico"/"auto_nombre"
    // (con solo 1 fila en el rango pedido, probablemente algún tipo de fila
    // de resumen/placeholder que ReportTagMultas mezcla en la lista) — se
    // loguea para diagnosticar en vez de reventar toda la corrida.
    if (!fila.portico || !fila.auto_nombre || !fila.patente || !fila.rpt_fecha || fila.tarifa == null) {
      console.log(`[smartreport] Fila con campos faltantes, se omite: ${JSON.stringify(fila)}`);
      sinMapear++;
      continue;
    }
    const esAVO = esVespucioOriente(fila.auto_nombre);
    const codigo = esAVO ? null : codigoInterno(fila.auto_nombre, fila.portico);
    if (!esAVO && !codigo) { sinMapear++; continue; }

    if (!vehiculoIdPorPatente.has(fila.patente)) {
      const { data: vehiculo, error } = await supabase.from('porticos_vehiculos').select('id').eq('patente', fila.patente).maybeSingle();
      if (error) throw new Error(`Error buscando vehículo ${fila.patente}: ${error.message}`);
      vehiculoIdPorPatente.set(fila.patente, vehiculo?.id ?? null);
    }
    const vehiculoId = vehiculoIdPorPatente.get(fila.patente);
    if (!vehiculoId) { sinPasada++; continue; } // patente no rastreada por este sistema

    // rpt_fecha ya viene en ISO UTC real (ej. "2026-09-03T11:43:24.000Z") —
    // a diferencia del Excel, acá no hace falta convertir desde hora Chile.
    const tsReporte = new Date(fila.rpt_fecha);
    let query = supabase
      .from('porticos_pasadas_reales')
      .select('id, ts')
      .eq('vehiculo_id', vehiculoId)
      .eq('confirmado', true)
      .is('monto_smartreport', null);
    if (esAVO) {
      // AVO cobra por TRAMO completo (entrada→salida), no por pórtico — se
      // toma cualquier pasada de esa concesionaria en una ventana ancha (ver
      // VENTANA_AVO_MS) y, de todas las candidatas, se elige la MÁS TARDÍA:
      // suele ser el pórtico de salida (ej. "Tobalaba"), el que mejor
      // representa el cierre real del tramo cobrado.
      query = query
        .eq('concesionaria', 'Vespucio Oriente (AVO)')
        .gte('ts', new Date(tsReporte.getTime() - VENTANA_AVO_MS).toISOString())
        .lte('ts', new Date(tsReporte.getTime() + VENTANA_AVO_MS).toISOString());
    } else {
      query = query
        .eq('portico_codigo', codigo)
        .gte('ts', new Date(tsReporte.getTime() - VENTANA_EMPAREJAR_MS).toISOString())
        .lte('ts', new Date(tsReporte.getTime() + VENTANA_EMPAREJAR_MS).toISOString());
    }
    const { data: candidatas, error: errCand } = await query;
    if (errCand) throw new Error(`Error buscando pasada ${fila.patente}/${esAVO ? 'AVO' : codigo}: ${errCand.message}`);
    if (!candidatas || !candidatas.length) { sinPasada++; continue; }

    let mejor;
    if (esAVO) {
      mejor = candidatas.reduce((a, b) => (new Date(b.ts) > new Date(a.ts) ? b : a));
    } else {
      mejor = candidatas[0];
      let mejorDiff = Math.abs(new Date(mejor.ts).getTime() - tsReporte.getTime());
      for (const c of candidatas.slice(1)) {
        const diff = Math.abs(new Date(c.ts).getTime() - tsReporte.getTime());
        if (diff < mejorDiff) { mejor = c; mejorDiff = diff; }
      }
    }

    const { error: errUpdate } = await supabase.from('porticos_pasadas_reales').update({ monto_smartreport: fila.tarifa }).eq('id', mejor.id);
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
  const { cookieHeader, headers, cuenta } = await loginSmartReport(process.env.SR_USER, process.env.SR_PASSWORD);
  console.log('[smartreport] Login OK.');

  const hoy = new Date();
  const desde = new Date(hoy.getTime() - SMARTREPORT_DIAS_ATRAS * 24 * 3600 * 1000);
  const dateIni = `${fmtSR(desde)} 00:00`;
  const dateEnd = `${fmtSR(hoy)} 23:59`;

  console.log(`[smartreport] Consultando pases ${dateIni} → ${dateEnd}...`);
  const filas = await obtenerPasesTag(cookieHeader, headers, cuenta, dateIni, dateEnd);
  console.log(`[smartreport] ${filas.length} filas de cobro recibidas.`);
  await emparejarYActualizar(filas);
}

main().catch((err) => {
  console.error('ERROR FATAL:', err.message);
  process.exit(1);
});
