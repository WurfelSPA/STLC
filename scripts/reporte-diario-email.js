#!/usr/bin/env node
'use strict';
/**
 * reporte-diario-email.js
 *
 * Reporte diario por correo del estado del piloto de pórticos (AGP/Tracklink):
 * vehículos con pasadas, pasadas detectadas, acierto en montos (urbanas /
 * interurbanas / total, ayer y acumulado) y tamaño del catálogo. Pensado
 * para correr una vez al día, 10:00 hora Chile, sobre lo sucedido el día
 * anterior.
 *
 * Regla de silencio: si no hubo ninguna pasada confirmada ayer, no se envía
 * nada -- un correo de puros ceros no aporta y satura la bandeja.
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

// Concesionarias urbanas (Santiago) -- todo lo que NO esté en esta lista se
// clasifica como interurbana. A propósito es una lista chica y cerrada de lo
// urbano (prácticamente no cambia) en vez de enumerar cada concesión
// interurbana, que sigue creciendo cada vez que se cierra un hueco nuevo de
// catálogo (ver ESTADO.md) -- así un pórtico interurbano nuevo cae solo en
// el grupo correcto sin tener que tocar este archivo.
const CONCESIONARIAS_URBANAS = new Set([
  'Autopista Central',
  'Vespucio Norte',
  'Vespucio Sur',
  'Costanera Norte',
  'Vespucio Oriente (AVO)',
]);

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

// Rango [00:00, 24:00) de "ayer" en hora de Chile, expresado en instantes
// UTC reales -- se resta la cantidad de minutos transcurridos desde la
// medianoche de Chile (medida con partesChile, no con un offset fijo) para
// llegar al instante UTC real que esa medianoche representó.
function rangoAyerChile(ahora) {
  const hoy = partesChile(ahora);
  const minutosDesdeMedianoche = Number(hoy.hour) * 60 + Number(hoy.minute) + Number(hoy.second) / 60;
  const medianocheHoyUTC = new Date(ahora.getTime() - minutosDesdeMedianoche * 60_000);
  const medianocheAyerUTC = new Date(medianocheHoyUTC.getTime() - 24 * 60 * 60_000);
  return { desde: medianocheAyerUTC, hasta: medianocheHoyUTC };
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

// Trae pasadas confirmadas del dispositivo principal en [desde, hasta)
// (o todo el histórico si se omiten) y arma: vehículos distintos, total de
// pasadas, pasadas sin ningún monto real todavía, y acierto en montos
// desglosado urbana/interurbana/total (solo sobre pasadas CON monto real,
// AVO y pórticos sin tarifa cargada quedan fuera del cálculo de acierto).
async function calcularResumen(tarifas, desde, hasta) {
  let query = supabase
    .from('porticos_pasadas_reales')
    .select('vehiculo_id, portico_codigo, concesionaria, monto_real, monto_smartreport, monto_agp')
    .eq('confirmado', true)
    .eq('dispositivo', 'principal');
  if (desde) query = query.gte('ts', desde.toISOString());
  if (hasta) query = query.lt('ts', hasta.toISOString());
  const { data, error } = await query;
  if (error) throw error;

  const vehiculos = new Set();
  let pendientes = 0;
  const grupos = { urbana: { ok: 0, total: 0 }, interurbana: { ok: 0, total: 0 } };

  for (const p of data) {
    vehiculos.add(p.vehiculo_id);
    const montoReal = p.monto_real ?? p.monto_smartreport ?? p.monto_agp;
    if (montoReal == null) { pendientes++; continue; }
    const coincide = dentroDeTolerancia(Number(montoReal), montosPosibles(tarifas, p.portico_codigo));
    if (coincide === null) continue; // sin tarifa cargada, no se puede evaluar
    const grupo = CONCESIONARIAS_URBANAS.has(p.concesionaria) ? 'urbana' : 'interurbana';
    grupos[grupo].total++;
    if (coincide) grupos[grupo].ok++;
  }

  return { vehiculos: vehiculos.size, pasadas: data.length, pendientes, grupos };
}

async function contarPorticosCatalogo() {
  const { count, error } = await supabase
    .from('porticos_catalogo')
    .select('codigo', { count: 'exact', head: true });
  if (error) throw error;
  return count;
}

// Umbrales propios (no vienen de AGP): la meta acordada es 99% con ±1% de
// desvío, así que 🟢 cubre esa meta o mejor, 🟡 marca que se está desviando
// pero no es grave, 🔴 es un salto grande que merece mirar hoy mismo.
function semaforo(pct) {
  if (pct === null) return '⚪';
  if (pct >= 98) return '🟢';
  if (pct >= 95) return '🟡';
  return '🔴';
}
function celdaAcierto(ok, total) {
  if (total === 0) return { html: `${semaforo(null)} sin datos para evaluar`, pct: null };
  const pct = (ok / total) * 100;
  return { html: `${semaforo(pct)} ${pct.toFixed(1)}% (${ok}/${total})`, pct };
}

function filaTabla(etiqueta, ayer, acumulado) {
  return `<tr>
    <td style="padding:6px 10px;border:1px solid #ddd;">${etiqueta}</td>
    <td style="padding:6px 10px;border:1px solid #ddd;">${ayer}</td>
    <td style="padding:6px 10px;border:1px solid #ddd;">${acumulado}</td>
  </tr>`;
}

function construirHtml({ fechaHoy, fechaAyer, ayer, acumulado, porticos }) {
  const acAyer = celdaAcierto(ayer.grupos.urbana.ok + ayer.grupos.interurbana.ok, ayer.grupos.urbana.total + ayer.grupos.interurbana.total);
  const acAcum = celdaAcierto(acumulado.grupos.urbana.ok + acumulado.grupos.interurbana.ok, acumulado.grupos.urbana.total + acumulado.grupos.interurbana.total);
  const urbAyer = celdaAcierto(ayer.grupos.urbana.ok, ayer.grupos.urbana.total);
  const urbAcum = celdaAcierto(acumulado.grupos.urbana.ok, acumulado.grupos.urbana.total);
  const interAyer = celdaAcierto(ayer.grupos.interurbana.ok, ayer.grupos.interurbana.total);
  const interAcum = celdaAcierto(acumulado.grupos.interurbana.ok, acumulado.grupos.interurbana.total);

  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">
    <p>Resumen automático del piloto de pórticos correspondiente a ayer (${fechaAyer}).</p>
    <table style="border-collapse:collapse;">
      <tr style="background:#f2f2f2;">
        <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Métrica</th>
        <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Ayer</th>
        <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Acumulado</th>
      </tr>
      ${filaTabla('Vehículos con pasadas', ayer.vehiculos, '—')}
      ${filaTabla('Pasadas detectadas', ayer.pasadas, acumulado.pasadas)}
      ${filaTabla('Acierto en montos, urbanas', urbAyer.html, urbAcum.html)}
      ${filaTabla('Acierto en montos, interurbanas', interAyer.html, interAcum.html)}
      ${filaTabla('Acierto en montos, total', acAyer.html, acAcum.html)}
      ${filaTabla('Pendientes de confirmar', `${ayer.pendientes} pasadas sin monto real todavía`, '—')}
      ${filaTabla('Pórticos en catálogo', porticos, '—')}
    </table>
    <p style="color:#888;font-size:12px;">Mensaje generado automáticamente.</p>
  </div>`;
}

async function main() {
  const ahora = new Date();
  const { desde, hasta } = rangoAyerChile(ahora);

  const { data: catalogo, error: errCatalogo } = await supabase.from('porticos_catalogo').select('codigo, tbfp, tbp, tarifa_ts');
  if (errCatalogo) throw errCatalogo;
  const tarifas = construirTarifas(catalogo);

  const [resumenAyer, resumenAcumulado, porticos] = await Promise.all([
    calcularResumen(tarifas, desde, hasta),
    calcularResumen(tarifas, null, null),
    contarPorticosCatalogo(),
  ]);

  if (resumenAyer.pasadas === 0) {
    console.log('[reporte-diario] Sin pasadas confirmadas ayer, se omite el envío.');
    return;
  }

  const html = construirHtml({
    fechaHoy: fechaCorta(ahora),
    fechaAyer: fechaCorta(desde),
    ayer: resumenAyer,
    acumulado: resumenAcumulado,
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

  console.log(`[reporte-diario] Enviado a ${DESTINATARIOS.join(', ')} (${resumenAyer.pasadas} pasadas de ayer).`);
}

main().catch((err) => {
  console.error('[reporte-diario] Error:', err);
  process.exit(1);
});
