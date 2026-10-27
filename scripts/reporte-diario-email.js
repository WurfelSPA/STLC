#!/usr/bin/env node
'use strict';
/**
 * reporte-diario-email.js
 *
 * Reporte diario por correo del estado del piloto de pórticos (AGP/Tracklink),
 * en 2 bloques separados para que no se mezclen universos de vehículos
 * distintos (confusión real del cuadro anterior, ver historial de commits):
 *
 *   1) Pasadas detectadas (nuestra base de datos, toda la flota activa):
 *      vehículos con pasadas, pasadas detectadas, salud geométrica (distancia
 *      al pórtico, velocidad al cruzar, duplicados) y tamaño del catálogo.
 *      Es la única métrica automática que cubre a los vehículos que no son
 *      clientes de AGP ni están en Smart Report (la mayoría de la flota).
 *   2) Contraste con AGP (solo VHRX-66/TTXR-82, los únicos clientes reales
 *      de AGP con TAG propio): cuántos tránsitos vio AGP, cuántos capturamos,
 *      y de los capturados cuántos coinciden con la tarifa estimada.
 *
 * Decisión 2026-10-27 (usuario): Smart Report ya no tiene vehículo activo
 * (VVJG-14, único dado de alta ahí, le retiraron el GPS FTC927 la noche del
 * 26-oct) -- se saca ese bloque del correo. VVJG-14 se excluye del bloque 1
 * también (ver PATENTES_EXCLUIDAS) -- su histórico queda intacto en la base
 * de datos, solo deja de contarse en el reporte diario.
 *
 * Los dos bloques miran días DISTINTOS a propósito (ver DIAS_LAG_AGP): el
 * bloque 1 es sobre "ayer" (nuestra propia data, sin atraso). El bloque 2
 * sobre AGP mirando "ayer" casi siempre saldría en cero -- AGP procesa de su
 * lado de forma asíncrona y tarda 1-2 días en tener el tránsito disponible
 * (confirmado real, ver ESTADO.md) -- así que mira unos días atrás, cuando
 * ya es razonable que AGP haya terminado de procesar.
 *
 * Pensado para correr una vez al día, 10:00 hora Chile.
 *
 * Regla de silencio: si no hubo ninguna pasada confirmada ayer (ya excluyendo
 * PATENTES_EXCLUIDAS), no se envía nada -- un correo de puros ceros no aporta
 * y satura la bandeja.
 *
 * Variables de entorno esperadas (GitHub Secrets):
 *   SUPABASE_SERVICE_ROLE_KEY, TRACKLINK_SMTP_PASSWORD
 */

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY');
}
if (!process.env.TRACKLINK_SMTP_PASSWORD) {
  throw new Error('Falta la variable de entorno TRACKLINK_SMTP_PASSWORD');
}

const supabase = createClient(
  'https://lomkolhgmkvshucqjuhf.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REMITENTE = 'alex.melendez@tracklink.cl';
const DESTINATARIOS = [
  'emiliano.fuenzalida@tracklink.cl',
  'rafael.nieto@tracklink.cl',
  'alex.melendez@tracklink.cl',
];

// Vehículo(s) de prueba interna dados de baja -- se excluyen del bloque 1
// (pasadas detectadas) para que el reporte no cuente algo que ya no está
// circulando. El histórico queda intacto en Supabase, esto solo afecta este
// reporte. VVJG-14: le retiraron el GPS FTC927 la noche del 26-oct-2026.
const PATENTES_EXCLUIDAS = ['VVJG-14'];

// Únicos clientes reales de AGP con TAG propio (mismo criterio que
// PATENTES_AGP en sync-agp-transitos.js -- mantener sincronizado si cambia).
const PATENTES_AGP = ['VHRX-66', 'TTXR-82'];

// Mismo criterio que montosPosiblesPortico/toleranciaMonto en
// sync-tlchile.js, documentado en tracklink-porticos-portal/docs/ESTADO.md
// ("Cómo se mide"): compara contra CUALQUIERA de las 3 bandas tarifarias del
// pórtico, no contra la banda horaria exacta de la pasada -- coincide si la
// diferencia es de hasta max($5, 2%).
function montosPosibles(tarifas, codigo) {
  const t = tarifas[codigo];
  return t ? [...new Set(Object.values(t))] : [];
}
function dentroDeTolerancia(montoReal, posibles) {
  if (!posibles.length) return null; // sin tarifa cargada (ej. AVO) -- no se puede evaluar
  const tolerancia = Math.max(5, montoReal * 0.02);
  return posibles.some((v) => Math.abs(v - montoReal) <= tolerancia);
}

// Mismo mecanismo de hora de Chile real (con horario de verano incluido) que
// sync-tlchile.js (partesChile) -- Chile cambia de huso 2 veces al año, un
// offset fijo se rompe en cada cambio.
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

// Rango [00:00, 24:00) de un día específico en hora de Chile, expresado en
// instantes UTC reales -- se resta la cantidad de minutos transcurridos
// desde la medianoche de Chile (medida con partesChile, no con un offset
// fijo) para llegar al instante UTC real que esa medianoche representó.
// `diasAtras=1` (default) es "ayer"; un valor mayor mira más atrás (ver
// DIAS_LAG_AGP, el bloque de AGP no usa "ayer" porque ellos tardan en
// procesar).
function rangoDiaChile(ahora, diasAtras = 1) {
  const hoy = partesChile(ahora);
  const minutosDesdeMedianoche = Number(hoy.hour) * 60 + Number(hoy.minute) + Number(hoy.second) / 60;
  const medianocheHoyUTC = new Date(ahora.getTime() - minutosDesdeMedianoche * 60_000);
  const hasta = new Date(medianocheHoyUTC.getTime() - (diasAtras - 1) * 24 * 60 * 60_000);
  const desde = new Date(hasta.getTime() - 24 * 60 * 60_000);
  return { desde, hasta };
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fechaCorta(fecha) {
  const p = partesChile(fecha);
  return `${p.day}-${MESES[Number(p.month) - 1]}-${p.year}`;
}

function construirTarifas(filas) {
  const tarifas = {};
  for (const fila of filas) {
    if (fila.tbfp !== null) {
      tarifas[fila.codigo] = { TBFP: Number(fila.tbfp), TBP: Number(fila.tbp), TS: Number(fila.tarifa_ts) };
    }
  }
  return tarifas;
}

async function idsDePatentes(patentes) {
  const { data, error } = await supabase.from('porticos_vehiculos').select('id').in('patente', patentes);
  if (error) throw error;
  return data.map((v) => v.id);
}

const DISTANCIA_ALTA_CONFIANZA_M = 50;
const DISTANCIA_AL_LIMITE_M = 100; // RADIO_GEOCERCA_M en sync-tlchile.js es 150

// AGP tarda 1-2 días en tener un tránsito disponible para consultar (proceso
// asíncrono de su lado, ver ESTADO.md) -- mirar "ayer" para el bloque AGP
// casi siempre da puros ceros, no porque falte algo nuestro sino porque es
// muy pronto. 3 días da margen para que ya haya terminado de procesar.
const DIAS_LAG_AGP = 3;

// Bloque 1: pasadas detectadas por nuestra base de datos, toda la flota
// activa (sin PATENTES_EXCLUIDAS). Incluye salud geométrica -- distancia al
// pórtico, velocidad al cruzar, duplicados -- único indicador automático que
// cubre a los vehículos sin AGP ni Smart Report (la mayoría de la flota, ver
// nota del encabezado del archivo). No prueba que el monto esté bien, pero
// si la detección es consistente es la mejor evidencia automática disponible
// de que el mismo motor ya validado contra AGP (98-100% de acierto en
// tarifas) se está comportando igual acá.
async function calcularDeteccion(idsExcluidos, desde, hasta) {
  let query = supabase
    .from('porticos_pasadas_reales')
    .select('vehiculo_id, portico_codigo, ts, distancia_m, velocidad_kmh')
    .eq('confirmado', true)
    .eq('dispositivo', 'principal')
    .gte('ts', desde.toISOString())
    .lt('ts', hasta.toISOString());
  if (idsExcluidos.length) query = query.not('vehiculo_id', 'in', `(${idsExcluidos.join(',')})`);
  const { data, error } = await query;
  if (error) throw error;

  const vehiculos = new Set();
  let cercaAltaConfianza = 0, alLimite = 0, velocidadCero = 0;
  for (const p of data) {
    vehiculos.add(p.vehiculo_id);
    if (p.distancia_m != null && p.distancia_m < DISTANCIA_ALTA_CONFIANZA_M) cercaAltaConfianza++;
    if (p.distancia_m != null && p.distancia_m >= DISTANCIA_AL_LIMITE_M) alLimite++;
    if (p.velocidad_kmh === 0) velocidadCero++;
  }

  // Duplicado = mismo vehículo + mismo código de pórtico, dos confirmadas a
  // menos de 5 min -- mismo síntoma que el bug real de doble detección
  // corregido el 16-oct (commit 5f29f41, STLC). No detecta el caso base/
  // alterno (serían dos CÓDIGOS distintos del mismo nudo vial, ver
  // PARES_DIRECCIONALES) -- esta consulta es un chequeo de salud simple, no
  // reemplaza el lock de dirección real que corre en sync-tlchile.js.
  let duplicados = 0;
  const porGrupo = new Map();
  for (const p of data) {
    const clave = `${p.vehiculo_id}|${p.portico_codigo}`;
    if (!porGrupo.has(clave)) porGrupo.set(clave, []);
    porGrupo.get(clave).push(new Date(p.ts).getTime());
  }
  for (const marcas of porGrupo.values()) {
    marcas.sort((a, b) => a - b);
    for (let i = 1; i < marcas.length; i++) {
      if (marcas[i] - marcas[i - 1] < 5 * 60_000) duplicados++;
    }
  }

  return { vehiculos: vehiculos.size, pasadas: data.length, cercaAltaConfianza, alLimite, velocidadCero, duplicados };
}

// Bloque 2: contraste con AGP, solo VHRX-66/TTXR-82. Dos cosas distintas:
// "vio vs capturamos" (agp_transitos_recibidos, guarda TODO lo que AGP
// reporta, calce o no -- agregado 2026-10-26) y "de lo capturado, cuánto
// coincide con la tarifa estimada" (porticos_pasadas_reales.monto_agp, solo
// lo que ya calzó).
async function calcularAgp(idsAgp, tarifas, desde, hasta) {
  const [{ data: pasadas, error: errPasadas }, { data: transitos, error: errTransitos }] = await Promise.all([
    supabase
      .from('porticos_pasadas_reales')
      .select('portico_codigo, monto_agp')
      .eq('confirmado', true)
      .eq('dispositivo', 'principal')
      .in('vehiculo_id', idsAgp)
      .not('monto_agp', 'is', null)
      .gte('ts', desde.toISOString())
      .lt('ts', hasta.toISOString()),
    supabase
      .from('agp_transitos_recibidos')
      .select('pasada_id')
      .gte('ts_transito', desde.toISOString())
      .lt('ts_transito', hasta.toISOString()),
  ]);
  if (errPasadas) throw errPasadas;
  if (errTransitos) throw errTransitos;

  let coinciden = 0;
  for (const p of pasadas) {
    const coincide = dentroDeTolerancia(Number(p.monto_agp), montosPosibles(tarifas, p.portico_codigo));
    if (coincide) coinciden++;
  }

  return {
    vio: transitos.length,
    capturamos: transitos.filter((t) => t.pasada_id != null).length,
    conMonto: pasadas.length,
    coinciden,
  };
}

async function contarPorticosCatalogo() {
  const { count, error } = await supabase
    .from('porticos_catalogo')
    .select('codigo', { count: 'exact', head: true });
  if (error) throw error;
  return count;
}

function fila(etiqueta, valor) {
  return `${etiqueta}: ${valor}<br>`;
}

function construirHtml({ fechaAyer, fechaAgp, deteccion, agp, porticos }) {
  const pct = (n, total) => (total ? `${n} (${((n / total) * 100).toFixed(0)}%)` : `${n}`);

  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">
    <h3 style="margin-bottom:4px;">1. Pasadas detectadas (nuestra base de datos) — ${fechaAyer}</h3>
    <p style="margin-top:0;">
      ${fila('Pasadas detectadas', `${deteccion.pasadas}, repartidas entre ${deteccion.vehiculos} vehículos distintos`)}
      ${fila(`Confirmadas a menos de ${DISTANCIA_ALTA_CONFIANZA_M}m del pórtico (alta confianza)`, pct(deteccion.cercaAltaConfianza, deteccion.pasadas))}
      ${fila(`Confirmadas a ${DISTANCIA_AL_LIMITE_M}m o más (cerca del límite del radio de detección)`, pct(deteccion.alLimite, deteccion.pasadas))}
      ${fila('Con velocidad 0 al momento del cruce (posible falso positivo)', deteccion.velocidadCero)}
      ${fila('Duplicados (mismo vehículo y pórtico en menos de 5 min, no debería pasar)', deteccion.duplicados)}
      ${fila('Pórticos en catálogo', porticos)}
    </p>

    <h3 style="margin-bottom:4px;">2. Contraste con AGP (solo VHRX-66 / TTXR-82) — ${fechaAgp}</h3>
    <p style="margin-top:0;color:#888;font-size:12px;margin-bottom:2px;">Este bloque mira ${DIAS_LAG_AGP} días atrás, no ayer -- AGP tarda 1-2 días en procesar su lado.</p>
    <!-- NOTA_TEMPORAL_UN_SOLO_ENVIO: borrar después del correo del 27-oct-2026, ver reporte-diario-email.js -->
    <p style="margin-top:0;color:#888;font-size:12px;margin-bottom:2px;">Nota de hoy: esta tabla (agp_transitos_recibidos) se creó recién ayer, así que todavía no acumula suficientes días -- debería empezar a mostrar datos reales en 1-2 días.</p>
    <p style="margin-top:0;">
      ${fila('Tránsitos que AGP reportó ese día', agp.vio)}
      ${fila('De esos, cuántos capturamos nosotros', agp.capturamos)}
      ${fila('Pasadas capturadas con monto de AGP', agp.conMonto)}
      ${fila('De esas, cuántas coinciden con nuestra tarifa estimada', pct(agp.coinciden, agp.conMonto))}
    </p>

    <p style="color:#888;font-size:12px;">Mensaje generado automáticamente.</p>
  </div>`;
}

async function main() {
  const ahora = new Date();
  const { desde, hasta } = rangoDiaChile(ahora, 1);
  const { desde: desdeAgp, hasta: hastaAgp } = rangoDiaChile(ahora, DIAS_LAG_AGP);

  const { data: catalogo, error: errCatalogo } = await supabase.from('porticos_catalogo').select('codigo, tbfp, tbp, tarifa_ts');
  if (errCatalogo) throw errCatalogo;
  const tarifas = construirTarifas(catalogo);

  const [idsExcluidos, idsAgp] = await Promise.all([
    idsDePatentes(PATENTES_EXCLUIDAS),
    idsDePatentes(PATENTES_AGP),
  ]);

  const [deteccion, agp, porticos] = await Promise.all([
    calcularDeteccion(idsExcluidos, desde, hasta),
    calcularAgp(idsAgp, tarifas, desdeAgp, hastaAgp),
    contarPorticosCatalogo(),
  ]);

  if (deteccion.pasadas === 0) {
    console.log('[reporte-diario] Sin pasadas confirmadas ayer, se omite el envío.');
    return;
  }

  const html = construirHtml({
    fechaAyer: fechaCorta(desde),
    fechaAgp: fechaCorta(desdeAgp),
    deteccion,
    agp,
    porticos,
  });

  const transporter = nodemailer.createTransport({
    host: 'mail.tracklink.cl',
    port: 465,
    secure: true,
    auth: { user: REMITENTE, pass: process.env.TRACKLINK_SMTP_PASSWORD },
  });

  await transporter.sendMail({
    from: REMITENTE,
    to: DESTINATARIOS,
    subject: `Pórticos AGP, reporte diario ${fechaCorta(ahora)}`,
    html,
  });

  console.log(`[reporte-diario] Enviado a ${DESTINATARIOS.join(', ')} (${deteccion.pasadas} pasadas de ayer).`);
}

main().catch((err) => {
  console.error('[reporte-diario] Error:', err);
  process.exit(1);
});
