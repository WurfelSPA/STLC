#!/usr/bin/env node
'use strict';
/**
 * reporte-mazda.js
 *
 * Reporte semanal "Clientes Mazda" para Derco (pedido de Cristóbal Palma,
 * Tracklink, 26-oct-2026): todos los lunes, un Excel con
 *
 *   1) Clientes con cuenta activada
 *   2) Vehículos con más de 150 km recorridos, SIN cuenta activada
 *   3) Kilometraje acumulado de cada unidad
 *   4) Ubicación de cada unidad (comuna/región + enlace a Google Maps)
 *
 * Fuente: API HealthCheck de TrackGTS, cliente "mconnect" (portal MZDConnect).
 * Criterio de activación (decisión del usuario 2026-10-29): una unidad está
 * "activada" cuando ya fue traspasada desde la cuenta de bodega a la cuenta
 * personal del cliente. Las que siguen en BODEGA_MConnect están sin activar;
 * las de la cuenta MAZDA son unidades internas de la marca y no se reportan.
 *
 * Por qué consulta la API directo y no lee la tabla "MZDConnect": desde el
 * 20-ago-2026 sync-tlchile.js no logra autenticar "mconnect" (TrackGTS le
 * responde 429 al segundo login de la misma corrida, incluso con 60 s de
 * pausa), así que esa tabla quedó congelada. Este script corre en otro
 * horario, reintenta el login y, de pasada, deja la tabla al día (upsert con
 * el mismo mapeo que sincronizarHealthCheck).
 *
 * El Excel NO se guarda en el repo (STLC es público y el archivo trae datos
 * personales de clientes): se arma en memoria y se entrega al webhook de n8n,
 * que lo envía desde soporte@tracklink.cl. Los logs solo muestran conteos.
 *
 * MODO (env): "prueba" (default) envía solo a Tracklink/Alex para revisión;
 * "produccion" envía a Derco y queda registrado en reporte_mazda_log, para
 * que un cron disparado dos veces la misma semana no duplique el correo.
 *
 * Variables de entorno: TL_USER, TL_PASSWORD, TL_DOMAIN,
 * SUPABASE_SERVICE_ROLE_KEY, MAZDA_WEBHOOK_URL, MAZDA_WEBHOOK_TOKEN, MODO
 */

const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');

const MODO = process.env.MODO === 'produccion' ? 'produccion' : 'prueba';

// Se crea en main() (no al cargar el módulo) para que scripts/test pueda
// importar clasificar/construirExcel sin credenciales.
let supabase;

const CUENTA_BODEGA = 'BODEGA_MConnect';
const CUENTAS_INTERNAS = ['MAZDA'];
const UMBRAL_KM = 150;

// Mismo comportamiento de rate limit que en download-weekly.js de
// Santa Marta/Kadel/Enerfrost: TrackGTS rechaza logins seguidos de la misma
// cuenta, se recupera solo después de unos minutos.
const INTENTOS_LOGIN = 4;
const ESPERA_LOGIN_MS = 7 * 60_000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Hora de Chile (mismo mecanismo que reporte-diario-email.js) -----------
function partesChile(fecha) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const parte of fmt.formatToParts(fecha)) p[parte.type] = parte.value;
  if (p.hour === '24') p.hour = '00';
  return p;
}

// Lunes (hora Chile) de la semana en curso, como YYYY-MM-DD.
function lunesChile(ahora) {
  const p = partesChile(ahora);
  const hoy = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  const diasDesdeLunes = (hoy.getUTCDay() + 6) % 7;
  hoy.setUTCDate(hoy.getUTCDate() - diasDesdeLunes);
  return hoy.toISOString().slice(0, 10);
}

const ddmmaaaa = (iso) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');

// "2026-10-29T10:59:00" (TrackGTS ya lo entrega en hora local) -> "29-10-2026 10:59"
function fechaHora(valor) {
  if (!valor) return '';
  return `${ddmmaaaa(valor.slice(0, 10))} ${valor.slice(11, 16)}`.trim();
}

// --- TrackGTS ----------------------------------------------------------------
async function autenticar(baseUrl) {
  for (let intento = 1; intento <= INTENTOS_LOGIN; intento++) {
    const res = await fetch(`${baseUrl}/api/Authenticate/Auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: process.env.TL_USER, password: process.env.TL_PASSWORD, customer: 'mconnect' }),
    });
    if (res.ok) {
      const data = (await res.json()).data;
      const token = data?.accessToken;
      const retailId = data?.user?.parentCustomerId?.toString();
      if (!token || !retailId) throw new Error('Login sin token o retailId.');
      return { token, retailId };
    }
    if (res.status !== 429 || intento === INTENTOS_LOGIN) {
      throw new Error(`Login mconnect falló: HTTP ${res.status} (intento ${intento}/${INTENTOS_LOGIN})`);
    }
    console.log(`[mazda] Rate limit al autenticar (intento ${intento}/${INTENTOS_LOGIN}), reintento en ${ESPERA_LOGIN_MS / 60_000} min...`);
    await dormir(ESPERA_LOGIN_MS);
  }
}

async function obtenerUnidades() {
  const baseUrl = `https://${process.env.TL_DOMAIN}.trackgts.com:8081`;
  const { token, retailId } = await autenticar(baseUrl);
  const res = await fetch(`${baseUrl}/api/HealthCheck/GetReportHealthCheck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ retailId }),
  });
  if (!res.ok) throw new Error(`GetReportHealthCheck falló: HTTP ${res.status}`);
  const unidades = (await res.json()).data ?? [];
  if (!unidades.length) throw new Error('La API no devolvió unidades.');
  return unidades;
}

// Mismo mapeo que sincronizarHealthCheck() en sync-tlchile.js (mantener
// sincronizado si cambia), salvo "Horómetro": la tabla MZDConnect no tiene esa
// columna (la tabla Tracklink sí) y PostgREST rechaza el upsert completo.
// Se duplica a propósito en vez de tocar ese archivo, que es compartido con el
// cliente Santa Marta.
async function actualizarTablaMZDConnect(unidades) {
  const registros = unidades.map((u) => ({
    'IMEI': u.imei, 'Unit ID': u.unitId, 'Serie': u.serie,
    'Fecha Ultimo Reporte': u.fechaUltimoReporte, 'Ubicación': u.ubicacion,
    'Antigüedad (minutos)': u.antiguedadMinutos, 'Mensaje': u.mensaje,
    'EstadoGPS': u.estadoGPS, 'EstadoIgnición': u.estadoIgnicion, 'EstadoMotor': u.estadoMotor,
    'Velocidad': String(u.velocidad ?? ''), 'Odómetro': String(u.odometro ?? ''),
    'VBatExterna': String(u.vBatExterna ?? ''),
    '%BatExterna': u.porcentBatInterna, 'Fabricante AVL': u.fabricanteAVL,
    'Modelo AVL': u.modeloAVL, 'Modelo AVL Ref': u.modeloAVLRef, 'Protocolo': u.protocolo,
    'Teléfono SIM': u.telefonoSim, 'Serie SIM': u.serieSim, 'GPRS': u.gprs,
    'Servicio': u.servicio, 'Servicio Comercial': u.servicioComercial,
    'Serv. Desde': u.servDesde, 'Serv. Hasta': u.servHasta, 'TipoInstalacion': u.tipoInstalacion,
    'Alias': u.alias, 'Tipo': u.tipo, 'Marca': u.marca, 'Modelo': u.modelo, 'Año': u.anio,
    'Placa': u.placa, 'Color': u.color, 'Chasis': u.chasis, 'Motor': u.motor,
    'Cliente/Empresa': u.clienteEmpresa, 'Cust ID': u.custId, 'Nombre': u.nombre,
    'Apellido': u.apellido, 'Direccion': u.direccion, 'Pais': u.pais, 'Correo': u.correo,
    'Usuario': u.usuario, 'Telefono': u.telefono,
    'ClienteAdicional1': u.clienteAdicional1 ?? '', 'ClienteAdicional2': u.clienteAdicional2 ?? '',
    'ClienteAdicional3': u.clienteAdicional3 ?? '', 'ClienteAdicional4': u.clienteAdicional4 ?? '',
  }));
  const { error } = await supabase.from('MZDConnect').upsert(registros, { onConflict: 'IMEI' });
  // No es crítico para el reporte: si falla, se avisa y se sigue.
  if (error) console.log(`[mazda] ⚠️ No se pudo actualizar la tabla MZDConnect: ${error.message}`);
  else console.log(`[mazda] Tabla MZDConnect actualizada (${registros.length} unidades).`);
}

// --- Ubicación ---------------------------------------------------------------
// "ubicacion" viene como HTML: <a href='http://maps.google.com/?q=-33.48,-70.60&z=15...'>
function coordenadas(ubicacion) {
  const m = /q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(ubicacion ?? '');
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}

// Nominatim (OpenStreetMap) permite 1 consulta por segundo e identificarse
// con User-Agent. Se cachea por coordenada redondeada a 3 decimales (~100 m):
// la mayoría de las unidades en bodega/concesionario no se mueven entre semanas.
const claveGeo = ({ lat, lon }) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

async function geocodificar(puntos) {
  const claves = [...new Set(puntos.map(claveGeo))];
  const { data: cache, error } = await supabase.from('mazda_geocache').select('clave, comuna, region').in('clave', claves);
  if (error) throw error;
  const porClave = new Map(cache.map((c) => [c.clave, c]));

  const faltantes = claves.filter((c) => !porClave.has(c));
  console.log(`[mazda] Geocodificación: ${claves.length - faltantes.length} en caché, ${faltantes.length} por consultar.`);
  for (const clave of faltantes) {
    const [lat, lon] = clave.split(',');
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1&accept-language=es`,
        { headers: { 'User-Agent': 'Tracklink-ReporteMazda/1.0 (soporte@tracklink.cl)' } }
      );
      if (res.ok) {
        const a = (await res.json()).address ?? {};
        const fila = {
          clave,
          comuna: a.city || a.town || a.village || a.municipality || a.county || '',
          region: a.state || '',
          direccion: [a.road, a.house_number].filter(Boolean).join(' '),
          actualizado: new Date().toISOString(),
        };
        porClave.set(clave, fila);
        await supabase.from('mazda_geocache').upsert(fila);
      }
    } catch (e) {
      console.log(`[mazda] ⚠️ Geocodificación falló para un punto: ${e.message}`);
    }
    await dormir(1100);
  }
  return porClave;
}

// --- Clasificación -----------------------------------------------------------
function odometroKm(u) {
  const n = Number(String(u.odometro ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function clasificar(unidades, geo) {
  const filas = [];
  for (const u of unidades) {
    if (CUENTAS_INTERNAS.includes(u.clienteEmpresa)) continue;
    const pos = coordenadas(u.ubicacion);
    const g = pos ? geo.get(claveGeo(pos)) : null;
    const activada = u.clienteEmpresa !== CUENTA_BODEGA;
    filas.push({
      activada,
      // En bodega el "cliente" es la cuenta genérica ("Bodega"), no una persona.
      cliente: activada ? [u.nombre, u.apellido].filter(Boolean).join(' ').trim() : '',
      correo: u.correo ?? '',
      telefono: u.telefono ?? '',
      modelo: u.modelo ?? '',
      anio: u.anio ?? '',
      patente: u.placa ?? '',
      vin: u.chasis ?? '',
      km: odometroKm(u),
      comuna: g?.comuna ?? '',
      // "Región del Biobío" -> "Biobío", "Región Metropolitana de Santiago" -> "Metropolitana de Santiago"
      region: (g?.region ?? '').replace(/^Región (de |del )?/i, ''),
      mapa: pos ? `https://maps.google.com/?q=${pos.lat},${pos.lon}` : '',
      ultimoReporte: fechaHora(u.fechaUltimoReporte),
      desde: ddmmaaaa((u.servDesde ?? '').slice(0, 10)),
    });
  }
  filas.sort((a, b) => b.km - a.km);
  return {
    todas: filas,
    activadas: filas.filter((f) => f.activada),
    sinActivar150: filas.filter((f) => !f.activada && f.km > UMBRAL_KM),
  };
}

// --- Excel -------------------------------------------------------------------
// Colores del logo de Tracklink (azul marino del texto, celeste de "LINK").
const AZUL = 'FF1D3549';
const CELESTE = 'FF3DB4E6';

// Tracklink es el logo principal (pedido del usuario 2026-10-29); MZD Connect
// va más chico, a la derecha.
const LOGO_TRACKLINK = path.join(__dirname, '..', 'public', 'logo.png');      // 439x120
const LOGO_MZD = path.join(__dirname, 'assets', 'mzd-connect.jpg');           // 540x210

const COL = {
  estado:        { header: 'Estado', key: 'estado', width: 13 },
  cliente:       { header: 'Cliente', key: 'cliente', width: 28 },
  correo:        { header: 'Correo', key: 'correo', width: 30 },
  telefono:      { header: 'Teléfono', key: 'telefono', width: 15 },
  modelo:        { header: 'Modelo', key: 'modelo', width: 12 },
  anio:          { header: 'Año', key: 'anio', width: 7 },
  patente:       { header: 'Patente', key: 'patente', width: 10 },
  vin:           { header: 'VIN / Chasis', key: 'vin', width: 20 },
  km:            { header: 'Kilometraje (km)', key: 'km', width: 15 },
  comuna:        { header: 'Comuna / Ciudad', key: 'comuna', width: 20 },
  region:        { header: 'Región', key: 'region', width: 26 },
  mapa:          { header: 'Ubicación', key: 'mapa', width: 12 },
  ultimoReporte: { header: 'Último reporte', key: 'ultimoReporte', width: 17 },
  desde:         { header: 'Instalado desde', key: 'desde', width: 14 },
};

function agregarHoja(libro, nombre, columnas, filas) {
  const hoja = libro.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
  hoja.columns = columnas;
  for (const f of filas) {
    const fila = hoja.addRow({ ...f, estado: f.activada ? 'Activada' : 'Sin activar', mapa: '' });
    if (f.mapa) {
      const celda = fila.getCell('mapa');
      celda.value = { text: 'Ver mapa', hyperlink: f.mapa };
      celda.font = { color: { argb: 'FF0563C1' }, underline: true };
    }
  }
  hoja.getColumn('km').numFmt = '#,##0';
  const encabezado = hoja.getRow(1);
  encabezado.height = 22;
  encabezado.alignment = { vertical: 'middle' };
  encabezado.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  encabezado.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
  if (filas.length) hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };
}

async function construirExcel(grupos, fechaCorte) {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Tracklink Chile';

  const resumen = libro.addWorksheet('Resumen', { views: [{ showGridLines: false }] });
  resumen.columns = [{ width: 4 }, { width: 52 }, { width: 14 }, { width: 22 }];

  // Filas 1-6 reservadas para los logos.
  for (let i = 0; i < 6; i++) resumen.addRow([]);
  resumen.addImage(libro.addImage({ filename: LOGO_TRACKLINK, extension: 'png' }), {
    tl: { col: 1, row: 0.4 }, ext: { width: 330, height: 90 },
  });
  resumen.addImage(libro.addImage({ filename: LOGO_MZD, extension: 'jpeg' }), {
    tl: { col: 2.6, row: 0.8 }, ext: { width: 150, height: 58 },
  });

  const titulo = resumen.addRow(['', 'Reporte semanal Clientes Mazda Connect']);
  titulo.getCell(2).font = { bold: true, size: 16, color: { argb: AZUL } };
  resumen.addRow(['', `Datos al ${fechaCorte}`]).getCell(2).font = { color: { argb: 'FF666666' } };
  resumen.addRow([]);
  const filasResumen = [
    ['Unidades reportadas', grupos.todas.length],
    ['Clientes con cuenta activada', grupos.activadas.length],
    ['Unidades sin cuenta activada', grupos.todas.length - grupos.activadas.length],
    [`Sin cuenta activada y con más de ${UMBRAL_KM} km recorridos`, grupos.sinActivar150.length],
  ];
  for (const [etiqueta, valor] of filasResumen) {
    const fila = resumen.addRow(['', etiqueta, valor]);
    fila.getCell(2).font = { bold: true, color: { argb: AZUL } };
    fila.getCell(3).font = { bold: true, size: 13, color: { argb: CELESTE } };
    fila.getCell(3).alignment = { horizontal: 'right' };
    for (const c of [2, 3]) fila.getCell(c).border = { bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } } };
  }
  resumen.addRow([]);
  const nota = (texto) => { resumen.addRow(['', texto]).getCell(2).font = { italic: true, size: 9, color: { argb: 'FF666666' } }; };
  nota('Activada: la unidad ya fue traspasada a la cuenta personal del cliente en Mazda Connect.');
  nota('Ubicación: última posición reportada por el GPS (comuna aproximada y enlace al mapa).');
  nota('Generado automáticamente por Tracklink Chile.');

  const ubicacion = [COL.km, COL.comuna, COL.region, COL.mapa, COL.ultimoReporte];
  agregarHoja(libro, 'Clientes activados',
    [COL.cliente, COL.correo, COL.telefono, COL.modelo, COL.anio, COL.patente, COL.vin, ...ubicacion, COL.desde],
    grupos.activadas);
  agregarHoja(libro, `Sin activar +${UMBRAL_KM} km`,
    [COL.modelo, COL.anio, COL.patente, COL.vin, ...ubicacion, COL.desde],
    grupos.sinActivar150);
  agregarHoja(libro, 'Todas las unidades',
    [COL.estado, COL.cliente, COL.modelo, COL.anio, COL.patente, COL.vin, ...ubicacion, COL.desde],
    grupos.todas);

  return Buffer.from(await libro.xlsx.writeBuffer());
}

// --- Envío -------------------------------------------------------------------
async function yaSeEnvio(semana) {
  const { data, error } = await supabase.from('reporte_mazda_log').select('semana').eq('semana', semana).maybeSingle();
  if (error) throw error;
  return !!data;
}

async function main() {
  for (const v of ['TL_USER', 'TL_PASSWORD', 'TL_DOMAIN', 'SUPABASE_SERVICE_ROLE_KEY', 'MAZDA_WEBHOOK_URL', 'MAZDA_WEBHOOK_TOKEN']) {
    if (!process.env[v]) throw new Error(`Falta la variable de entorno ${v}`);
  }
  supabase = createClient('https://lomkolhgmkvshucqjuhf.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY);

  const ahora = new Date();
  const semana = lunesChile(ahora);
  console.log(`[mazda] Modo ${MODO}, semana del ${semana}.`);

  if (MODO === 'produccion' && await yaSeEnvio(semana)) {
    console.log('[mazda] Ya se envió esta semana, se omite (cron disparado dos veces).');
    return;
  }

  const unidades = await obtenerUnidades();
  console.log(`[mazda] ${unidades.length} unidades desde TrackGTS.`);
  await actualizarTablaMZDConnect(unidades);

  const puntos = unidades.map((u) => coordenadas(u.ubicacion)).filter(Boolean);
  const geo = await geocodificar(puntos);
  const grupos = clasificar(unidades, geo);

  const p = partesChile(ahora);
  const fechaCorte = `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
  const excel = await construirExcel(grupos, fechaCorte);

  const resumen = {
    total: grupos.todas.length,
    activadas: grupos.activadas.length,
    sinActivar: grupos.todas.length - grupos.activadas.length,
    sinActivar150: grupos.sinActivar150.length,
    umbralKm: UMBRAL_KM,
  };
  console.log(`[mazda] Resumen: ${JSON.stringify(resumen)}`);

  const res = await fetch(process.env.MAZDA_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-reporte-token': process.env.MAZDA_WEBHOOK_TOKEN },
    body: JSON.stringify({
      modo: MODO,
      semana: ddmmaaaa(semana),
      fechaCorte,
      resumen,
      archivo: { nombre: `Reporte_Clientes_Mazda_${semana}.xlsx`, base64: excel.toString('base64') },
    }),
  });
  if (!res.ok) throw new Error(`El webhook de n8n respondió HTTP ${res.status}: ${await res.text()}`);

  if (MODO === 'produccion') {
    const { error } = await supabase.from('reporte_mazda_log').insert({
      semana, activadas: resumen.activadas, sin_activar_150: resumen.sinActivar150, total: resumen.total,
    });
    if (error) console.log(`[mazda] ⚠️ Enviado, pero no se pudo registrar en reporte_mazda_log: ${error.message}`);
  }
  console.log(`[mazda] Reporte entregado a n8n (modo ${MODO}).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[mazda] Error:', err.message);
    process.exit(1);
  });
}

module.exports = { clasificar, construirExcel, coordenadas, claveGeo };
