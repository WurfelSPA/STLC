#!/usr/bin/env node
'use strict';
/**
 * reporte-diario-email.js
 *
 * Reporte diario por correo del estado del piloto de pórticos (AGP/Tracklink):
 * vehículos con pasadas, pasadas detectadas, acierto en montos por fuente
 * (lectura manual, Smart Report, AGP) y cuántos tránsitos vio AGP que
 * nosotros no capturamos. Pensado para correr una vez al día, 10:00 hora
 * Chile, sobre lo sucedido el día anterior.
 *
 * Rediseñado 2026-10-26 a pedido del equipo de Tracklink -- la versión
 * anterior (acierto urbana/interurbana/acumulado con semáforo) confundió
 * más de lo que aclaró. Reemplazada por una comparación directa por fuente,
 * solo del día anterior (sin "acumulado").
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

// Trae pasadas confirmadas del dispositivo principal de TODA la flota
// (Tracklink, no solo los 2 vehículos cliente real de AGP) en [desde,
// hasta), y arma: vehículos distintos, total de pasadas, pasadas sin
// NINGUNA fuente de monto real todavía, y por cada fuente (lectura manual,
// Smart Report, AGP) cuántas pasadas la tienen y cuántas de esas coinciden
// con la tarifa estimada.
//
// Alcance real de cada fuente (no todas cubren toda la flota, ver
// etiquetas): "Lectura manual" y "pasadas detectadas" sí son de toda la
// flota; "Smart Report" solo tiene datos de VVJG-14 (único vehículo dado de
// alta en esa cuenta, ver PATENTES_SMARTREPORT en sync-smartreport.js);
// "AGP" solo tiene datos de VHRX-66/TTXR-82 (únicos clientes reales de AGP
// con TAG propio, ver PATENTES_AGP en sync-agp-transitos.js). Ninguna de las
// dos limitaciones es un bug nuestro -- cada fuente externa solo tiene lo
// que tiene.
//
// Antes (hasta el 26-oct) este reporte sí tenía un bug real: filtraba por
// vehículo con cliente_usuario='agp' para el cálculo de "acierto acumulado"
// y aun así se colaban 22 lecturas viejas de VVJG-14 (ago-sep, previas a la
// corrección del tarifario de Vespucio Sur del 21-oct) que hundían el
// número sin reflejar nada real. Ese "acumulado" ya no existe (el reporte
// rediseñado solo mira "ayer"), así que no hace falta excluir ningún
// vehículo por fecha -- un día puntual nunca arrastra data vieja.
const FUENTES = [
  { campo: 'monto_real', etiqueta: 'Lectura manual' },
  { campo: 'monto_smartreport', etiqueta: 'Smart Report (solo VVJG-14)' },
  { campo: 'monto_agp', etiqueta: 'AGP (solo VHRX-66/TTXR-82)' },
];

async function calcularResumen(tarifas, desde, hasta) {
  let query = supabase
    .from('porticos_pasadas_reales')
    .select('vehiculo_id, portico_codigo, monto_real, monto_smartreport, monto_agp')
    .eq('confirmado', true)
    .eq('dispositivo', 'principal');
  if (desde) query = query.gte('ts', desde.toISOString());
  if (hasta) query = query.lt('ts', hasta.toISOString());
  const { data, error } = await query;
  if (error) throw error;

  const vehiculos = new Set();
  let pendientes = 0;
  const porFuente = Object.fromEntries(FUENTES.map((f) => [f.campo, { ok: 0, total: 0 }]));

  for (const p of data) {
    vehiculos.add(p.vehiculo_id);
    if (p.monto_real == null && p.monto_smartreport == null && p.monto_agp == null) { pendientes++; continue; }
    for (const { campo } of FUENTES) {
      const monto = p[campo];
      if (monto == null) continue;
      const coincide = dentroDeTolerancia(Number(monto), montosPosibles(tarifas, p.portico_codigo));
      if (coincide === null) continue; // sin tarifa cargada, no se puede evaluar
      porFuente[campo].total++;
      if (coincide) porFuente[campo].ok++;
    }
  }

  return { vehiculos: vehiculos.size, pasadas: data.length, pendientes, porFuente };
}

// Tránsitos que AGP reportó para sus vehículos cliente real (VHRX-66/
// TTXR-82, ver PATENTES_AGP en sync-agp-transitos.js) en [desde, hasta),
// hayan calzado o no con una pasada nuestra -- permite mostrar "AGP vio N,
// nosotros capturamos M", a diferencia del acierto en montos (que solo mira
// lo que ya calzó). Agregado 2026-10-26 a pedido explícito del equipo de
// Tracklink en la reunión del 26-oct.
async function calcularComparacionAgp(desde, hasta) {
  const { data, error } = await supabase
    .from('agp_transitos_recibidos')
    .select('pasada_id')
    .gte('ts_transito', desde.toISOString())
    .lt('ts_transito', hasta.toISOString());
  if (error) throw error;
  const vio = data.length;
  const capturamos = data.filter((t) => t.pasada_id != null).length;
  return { vio, capturamos };
}

// Salud geométrica de las pasadas de ayer -- único indicador automático que
// cubre a TODA la flota, incluidos los ~35 vehículos sin ninguna fuente
// externa de contraste (no son clientes AGP ni están en Smart Report, y no
// hay acceso a la facturación real de las concesionarias). No prueba que el
// monto esté bien, pero si la detección es consistente (sin duplicados,
// confirmada cerca del pórtico, con el vehículo en movimiento), es la mejor
// evidencia automática disponible de que el mismo motor ya validado contra
// AGP (98-100% de acierto en tarifas) se está comportando igual acá.
// Agregado 2026-10-27 a pedido explícito del usuario: Smart Report/AGP no
// son viables para el resto de la flota (son clientes de Tracklink ajenos a
// este proyecto), así que la salud geométrica pasa a ser la métrica
// principal para esos vehículos, no un complemento.
const DISTANCIA_ALTA_CONFIANZA_M = 50;
const DISTANCIA_AL_LIMITE_M = 100; // RADIO_GEOCERCA_M en sync-tlchile.js es 150

async function calcularSaludGeometrica(desde, hasta) {
  const { data, error } = await supabase
    .from('porticos_pasadas_reales')
    .select('vehiculo_id, portico_codigo, ts, distancia_m, velocidad_kmh')
    .eq('confirmado', true)
    .eq('dispositivo', 'principal')
    .gte('ts', desde.toISOString())
    .lt('ts', hasta.toISOString());
  if (error) throw error;

  let cercaAltaConfianza = 0, alLimite = 0, velocidadCero = 0;
  for (const p of data) {
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

  return { total: data.length, cercaAltaConfianza, alLimite, velocidadCero, duplicados };
}

async function contarPorticosCatalogo() {
  const { count, error } = await supabase
    .from('porticos_catalogo')
    .select('codigo', { count: 'exact', head: true });
  if (error) throw error;
  return count;
}

function celdaAcierto(ok, total) {
  if (total === 0) return 'sin datos para evaluar';
  return `${ok} (${((ok / total) * 100).toFixed(0)}%)`;
}

function construirHtml({ fechaAyer, resumen, comparacionAgp, salud, porticos }) {
  const filasFuente = FUENTES.map(({ campo, etiqueta }) => {
    const { ok, total } = resumen.porFuente[campo];
    return `<tr>
      <td style="padding:6px 10px;border:1px solid #ddd;">${etiqueta}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">${total}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">${celdaAcierto(ok, total)}</td>
    </tr>`;
  }).join('');

  const pctSalud = (n) => (salud.total ? `${n} (${((n / salud.total) * 100).toFixed(0)}%)` : `${n}`);

  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">
    <p>Resumen automático del piloto de pórticos correspondiente a ayer (${fechaAyer}).</p>
    <table style="border-collapse:collapse;">
      <tr style="background:#f2f2f2;">
        <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Fuente</th>
        <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Pasadas de ayer con esa fuente</th>
        <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Coinciden con nuestro monto estimado</th>
      </tr>
      ${filasFuente}
    </table>
    <p>Vehículos con pasadas: ${resumen.vehiculos}<br>
    Pasadas detectadas: ${resumen.pasadas}<br>
    Pendientes de confirmar (ninguna fuente todavía): ${resumen.pendientes}<br>
    AGP vio ${comparacionAgp.vio} tránsito(s) de VHRX-66/TTXR-82 ayer, capturamos ${comparacionAgp.capturamos} de esos<br>
    Pórticos en catálogo: ${porticos}</p>

    <p><strong>Salud geométrica de ayer</strong> (toda la flota, con o sin fuente externa):<br>
    Confirmadas a menos de ${DISTANCIA_ALTA_CONFIANZA_M}m del pórtico (alta confianza): ${pctSalud(salud.cercaAltaConfianza)}<br>
    Confirmadas a ${DISTANCIA_AL_LIMITE_M}m o más (cerca del límite del radio, revisar si se repite seguido en el mismo pórtico): ${pctSalud(salud.alLimite)}<br>
    Con velocidad 0 al momento del cruce (posible falso positivo tipo P11/PA17/P5CN): ${salud.velocidadCero}<br>
    Duplicados (mismo vehículo y pórtico en menos de 5 min, no debería pasar): ${salud.duplicados}</p>
    <p style="color:#888;font-size:12px;">Mensaje generado automáticamente.</p>
  </div>`;
}

async function main() {
  const ahora = new Date();
  const { desde, hasta } = rangoAyerChile(ahora);

  const { data: catalogo, error: errCatalogo } = await supabase.from('porticos_catalogo').select('codigo, tbfp, tbp, tarifa_ts');
  if (errCatalogo) throw errCatalogo;
  const tarifas = construirTarifas(catalogo);

  const [resumenAyer, comparacionAgp, salud, porticos] = await Promise.all([
    calcularResumen(tarifas, desde, hasta),
    calcularComparacionAgp(desde, hasta),
    calcularSaludGeometrica(desde, hasta),
    contarPorticosCatalogo(),
  ]);

  if (resumenAyer.pasadas === 0) {
    console.log('[reporte-diario] Sin pasadas confirmadas ayer, se omite el envío.');
    return;
  }

  const html = construirHtml({
    fechaAyer: fechaCorta(desde),
    resumen: resumenAyer,
    comparacionAgp,
    salud,
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
