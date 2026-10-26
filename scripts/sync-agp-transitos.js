#!/usr/bin/env node
'use strict';
/**
 * sync-agp-transitos.js
 *
 * Consulta la API de AGP "tránsitos no facturados" (autopista-nof, ambiente
 * de prueba compartido 2026-09-15) y usa sus montos REALES para rellenar
 * porticos_pasadas_reales.monto_agp — misma idea que sync-smartreport.js
 * pero con otra fuente independiente (viene directo de las concesionarias
 * vía el propio AGP, no de un tercero).
 *
 * IMPORTANTE — esta API solo tiene datos de vehículos que son CLIENTES
 * REALES de AGP (con TAG contratado directamente con ellos), confirmado
 * 2026-09-15: se probó con VVJG-14 (auto de pruebas interno de Tracklink,
 * sin TAG AGP) y devolvió transitos:[] dos veces seguidas (incluso
 * esperando los ~3 min que AGP dijo que tardaba la lectura asíncrona) —
 * no es un problema de timing, es que AGP no tiene nada que reportar para
 * un vehículo que no es su cliente. Ver acuerdo original (27-ago): "las
 * patentes seleccionadas... correspondan a vehículos asociados al cliente
 * de AGP". No agregar acá ninguna patente que no sea confirmada
 * explícitamente como cliente AGP real (ver PATENTES_AGP más abajo, vacía
 * hasta que se instale el primer dispositivo FTC en un vehículo de Renting
 * Lucano — ver [[project_agp_tracklink_integration]] en memoria).
 *
 * La consulta es asíncrona del lado de AGP: la primera llamada para una
 * patente puede devolver transitos:[] mientras encola una lectura nueva
 * (tardó ~2-3 min en su propia prueba). Como este script corre en un cron
 * diario (no una sola vez), no hace falta reintentar dentro de la misma
 * corrida — la corrida de mañana ya trae lo que quedó encolado hoy.
 *
 * Variables de entorno esperadas (GitHub Secrets):
 *   AGP_TRANSITOS_TOKEN, AGP_TRANSITOS_ID_SUCURSAL (opcional, default 3018 =
 *   ambiente de prueba), SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY');
}
if (!process.env.AGP_TRANSITOS_TOKEN) {
  throw new Error('Falta la variable de entorno AGP_TRANSITOS_TOKEN');
}
const supabase = createClient(
  'https://lomkolhgmkvshucqjuhf.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AGP_URL = 'https://apim-agpsa-dev.azure-api.net/autopista-nof/api/consulta';
const AGP_ID_SUCURSAL = Number(process.env.AGP_TRANSITOS_ID_SUCURSAL || 3018);
// Rango amplio (tope real de AGP: 60 días) — la consulta es async del lado
// de ellos, así que un rango generoso cubre lecturas que tardaron más de un
// día en completarse, sin depender de un checkpoint incremental frágil.
const AGP_DIAS_ATRAS = 14;
const VENTANA_EMPAREJAR_MS = 10 * 60 * 1000; // ±10 min, igual que sync-smartreport.js

// Vehículos que son clientes REALES de AGP (con TAG contratado directamente
// con ellos, ver nota arriba) — agregado 2026-10-14: VHRX-66 y TTXR-82
// (Lucano Rent a Car, instalados 8-oct-2026, piloto activo). "ppu" es como
// lo espera la API de AGP (sin guión, confirmado con el PDF real que mandó
// Sergio Hidalgo: "VHRX66"/"TTXR82"); "patente" es como está en
// porticos_vehiculos (con guión).
const PATENTES_AGP = [
  { patente: 'VHRX-66', ppu: 'VHRX66' },
  { patente: 'TTXR-82', ppu: 'TTXR82' },
];

// --- Mapeo de códigos de AGP a nuestro portico_codigo -----------------------
// NO VALIDADO todavía contra datos reales superpuestos (VVJG-14 no tiene
// cuenta AGP y el único ejemplo real que dieron, VLKT57, no tiene nuestro
// GPS instalado) — revisar/ajustar apenas exista un vehículo con ambas
// fuentes a la vez. Basado en la respuesta real de ejemplo del 2026-09-15
// (Costanera Norte: "P8.0OP", "SB", "P2.2PO", "P2.1PO", "P3 PO" — sufijo de
// sentido de tránsito, se descarta acá igual que Smart Report ignora el
// suyo). RutaPass (R68/R78/R66/Itata) agrupa varias concesiones en un solo
// campo "autopista" — no tenemos catálogo propio de esos corredores
// todavía, así que esos tránsitos quedan "sin mapear" a propósito.
function codigoInterno(autopista, puntoCobro) {
  const a = (autopista || '').toUpperCase();
  const p = (puntoCobro || '').trim().toUpperCase().replace(/\s*(OP|PO)$/, '');
  if (a === 'COSTANERA NORTE') {
    const MAP_CN = {
      'P8.0': 'P8.0', 'P8.1': 'P8.1', 'P8.2': 'P8.2', 'P8.3': 'P8.3',
      SB: 'SB', EP: 'EP', EV: 'EV',
      'P2.2': 'P2.2CN', 'P2.1': 'P2.1', P3: 'P3', P0: 'P0', P4: 'P4CN', P5: 'P5CN', P7: 'P7CN',
    };
    return MAP_CN[p] || null;
  }
  // Autopista Central: confirmado con datos reales 2026-10-14 (corrida real
  // de VHRX-66/TTXR-82) que el campo puntoCobro viene como "<nombre> -
  // <código>" (ej. "Avda Santa María Oriente - PA16", "Carlos Valdovinos
  // Poniente - PA24") -- el código real es lo último después del " - ", NO
  // la primera palabra como se asumió al principio (esa primera versión
  // sacaba "AVDA"/"SAN"/"CARLOS" en vez de "PA16"/"PA25"/"PA24", 0 de 75
  // tránsitos reales calzaban). El resto de concesionarias (Vespucio Sur,
  // Ruta del Maipo/Maule, Ruta 78) queda sin mapear a propósito hasta ver su
  // formato real también -- no adivinar, un mapeo mal hecho pisaría
  // monto_agp con el código equivocado en vez de simplemente no mapear.
  if (a.startsWith('AUTOPISTA CENTRAL')) {
    const partes = p.split(' - ');
    return partes[partes.length - 1].trim().split(' ')[0] || null;
  }
  // Ruta del Maipo: confirmado con datos reales 2026-10-16 que puntoCobro
  // viene como "<código-propio-AGP> PPnXX - <sentido> - 0" (ej. "RDM-GABP
  // PP12NS - Norte - Sur - 0"). El código propio de AGP es el primer token;
  // Gabriela/Tocornal lo traen con una letra de sentido pegada al final
  // (GABP/GABO, TOCP/TOCO) que acá se colapsa a un solo código porque cobran
  // el mismo monto en ambos sentidos (mismo criterio que RDM-ANG, un solo
  // pórtico/geocerca, no un par direccional). RDM-TRM es el código propio de
  // AGP para nuestro RDM-MAIPO (mismo pórtico, confirmado por coordenada y
  // monto real exactos) -- NO renombrar RDM-MAIPO, solo mapear acá.
  if (a === 'RUTA DEL MAIPO') {
    const primerToken = p.split(' ')[0] || '';
    if (primerToken === 'RDM-TRM') return 'RDM-MAIPO';
    if (primerToken === 'RDM-QTA') return 'RDM-QUINTA';
    const sinSentido = primerToken.replace(/^(RDM-(?:GAB|TOC))[PO]$/, '$1');
    return sinSentido || null;
  }
  // Requínoa/Rosario: confirmado 2026-10-21, AGP los reporta como
  // "Requínoa Poniente (vía Norte-Sur)" / "Rosario Oriente (vía
  // Sur-Norte)" (correo Sergio Hidalgo) -- no el formato "RDM-XXX PPnXX"
  // de Gabriela/Tocornal/Angostura, así que van aparte.
  if (p.startsWith('REQUÍNOA') || p.startsWith('REQUINOA')) {
    if (p.includes('PONIENTE')) return 'RDM-REQ-PTE';
    if (p.includes('ORIENTE')) return 'RDM-REQ-OTE';
    return null;
  }
  if (p.startsWith('ROSARIO')) return 'RDM-ROS';
  // Ruta del Maule (Survías): confirmado 2026-10-16, puntoCobro = "<nombre>
  // <sentido>" (ej. "Rio Claro SN", "Retiro NS").
  if (a === 'SURVÍAS' || a === 'SURVIAS') {
    if (p.startsWith('RIO CLARO')) return 'RDMA-RCLARO';
    if (p.startsWith('RETIRO')) return 'RDMA-RETIRO';
    return null;
  }
  // Vespucio Sur: confirmado 2026-10-20 (correo Sergio Hidalgo con el
  // tarifario oficial), puntoCobro viene como "PdC<codigo>" (ej. "PdC5.1",
  // "PdC1.3") -- el código propio ya coincide 1:1 con nuestro catálogo
  // ("5.1", "1.3"), solo hay que sacarle el prefijo "PDC".
  if (a === 'VESPUCIO SUR') {
    return p.startsWith('PDC') ? p.slice(3) : null;
  }
  // RutaPass (Ruta 78, Ruta 68, Ruta 66, Itata): confirmado 2026-10-20,
  // puntoCobro viene como "T<n> - <nombre> <sentido> [R78]" (ej. "T2 -
  // Rinconada Oriente [R78]"). Solo mapeamos las plazas "[R78]" (Autopista
  // del Sol, el resto no está en nuestro catálogo todavía); el primer token
  // ("T2") más el prefijo "RT78" da nuestro código.
  if (a.startsWith('RUTAPASS')) {
    if (!p.endsWith('[R78]')) return null;
    const plaza = p.split(' - ')[0]?.trim();
    return plaza ? `RT78${plaza}` : null;
  }
  // Ruta Sur: agregada 2026-10-20 a partir de 5 transitos reales que
  // reportó Sergio (AGP) sin cruce de pasada -- nunca vimos el formato
  // real de "autopista"/"puntoCobro" de esta concesionaria, así que este
  // mapeo es tentativo (busca el código de AGP como token suelto en
  // cualquiera de los dos campos) hasta confirmar con un dato real nuevo.
  if (a.includes('RUTA SUR') || p.includes('SANTA CLARA') || p.includes('LAS MAICAS') || p.includes('LOS ANGELES') || p.includes('LOS ÁNGELES')) {
    if (/\bSCL\b/.test(p) || p.includes('SANTA CLARA')) return 'SCL';
    if (/\bLMA\b/.test(p) || p.includes('LAS MAICAS')) return 'LMA';
    if (/\bLANM\b/.test(p) || p.includes('LOS ANGELES') || p.includes('LOS ÁNGELES')) return 'LANM';
    return null;
  }
  return null;
}

async function consultarAGP(ppu, desde, hasta) {
  const res = await fetch(AGP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AGP_TRANSITOS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ppu, desde, hasta, id_sucursal: AGP_ID_SUCURSAL, porcentaje: 0 }),
  });
  if (!res.ok) throw new Error(`AGP consulta falló para ${ppu} (HTTP ${res.status}): ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

// AGP documenta que "fecha" puede venir como YYYY-MM-DD o DD-MM-YYYY según
// la concesionaria que la reporta — normalizar antes de combinar con "hora".
function normalizarFecha(fecha) {
  return /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : fecha.split('-').reverse().join('-');
}

// Guarda CADA tránsito que AGP reporta (calce o no con una pasada nuestra)
// en agp_transitos_recibidos -- antes solo se logueaba el "sin pasada" y se
// descartaba, así que nunca pudimos medir "AGP vio N, nosotros capturamos
// M" automáticamente (el número que se reportaba antes, ej. "21 tránsitos
// confirmados, capturamos 15", salía de cruzar el correo de Sergio a mano).
// Pedido explícito del usuario 2026-10-26 tras una reunión con AGP/Tracklink
// sobre reportar esto en el correo diario. onConflict por la unique
// (vehiculo_id, ts_transito, punto_cobro) -- AGP_DIAS_ATRAS=14 hace que el
// mismo tránsito se vuelva a recibir varios días seguidos, upsert evita
// duplicarlo y de paso permite que un tránsito "sin pasada" se actualice
// solo si calza más adelante (ej. llega la pasada un día después).
async function guardarTransitoRecibido(vehiculoId, t, tsTransito, codigo, pasadaId) {
  const { error } = await supabase.from('agp_transitos_recibidos').upsert({
    vehiculo_id: vehiculoId,
    ts_transito: tsTransito.toISOString(),
    autopista: t.autopista,
    punto_cobro: t.puntoCobro,
    codigo_interno: codigo,
    monto: Number(t.monto),
    pasada_id: pasadaId,
  }, { onConflict: 'vehiculo_id,ts_transito,punto_cobro' });
  if (error) throw new Error(`Error guardando agp_transitos_recibidos: ${error.message}`);
}

async function emparejarYActualizar(vehiculoId, transitos) {
  let actualizadas = 0, sinMapear = 0, sinPasada = 0;
  for (const t of transitos) {
    const codigo = codigoInterno(t.autopista, t.puntoCobro);
    const tsTransito = new Date(`${normalizarFecha(t.fecha)}T${t.hora}:00-03:00`); // hora Chile real

    if (!codigo) {
      sinMapear++;
      await guardarTransitoRecibido(vehiculoId, t, tsTransito, null, null);
      continue;
    }

    // Sin el filtro `.is('monto_agp', null)` -- antes lo tenía, pero eso
    // hacía que un tránsito YA emparejado en una corrida anterior (el rango
    // de AGP_DIAS_ATRAS=14 vuelve a traerlo varios días seguidos) dejara de
    // encontrar su pasada acá, y guardarTransitoRecibido() lo registraba con
    // pasada_id=null como si nunca se hubiera capturado -- bug real
    // encontrado 2026-10-26 al revisar agp_transitos_recibidos recién
    // creada (3 tránsitos del 19-oct, ya capturados de verdad, salían como
    // "sin pasada"). Ahora se busca la pasada sin importar si monto_agp ya
    // tiene valor, y el UPDATE de abajo solo escribe si todavía está null
    // (no pisa un valor ya cargado).
    const { data: candidatas, error } = await supabase
      .from('porticos_pasadas_reales')
      .select('id, ts, monto_agp')
      .eq('vehiculo_id', vehiculoId)
      .eq('confirmado', true)
      .eq('portico_codigo', codigo)
      .gte('ts', new Date(tsTransito.getTime() - VENTANA_EMPAREJAR_MS).toISOString())
      .lte('ts', new Date(tsTransito.getTime() + VENTANA_EMPAREJAR_MS).toISOString());
    if (error) throw new Error(`Error buscando pasada: ${error.message}`);
    if (!candidatas || !candidatas.length) {
      sinPasada++;
      console.log(`[agp-transitos][sin-pasada] ${t.autopista} / "${t.puntoCobro}" -> código ${codigo}, ${t.fecha} ${t.hora} (tsTransito=${tsTransito.toISOString()}), monto $${t.monto} -- sin pasada confirmada en ±${VENTANA_EMPAREJAR_MS / 60000}min.`);
      await guardarTransitoRecibido(vehiculoId, t, tsTransito, codigo, null);
      continue;
    }

    let mejor = candidatas[0];
    let mejorDiff = Math.abs(new Date(mejor.ts).getTime() - tsTransito.getTime());
    for (const c of candidatas.slice(1)) {
      const diff = Math.abs(new Date(c.ts).getTime() - tsTransito.getTime());
      if (diff < mejorDiff) { mejor = c; mejorDiff = diff; }
    }

    if (mejor.monto_agp == null) {
      const { error: errUpdate } = await supabase
        .from('porticos_pasadas_reales')
        .update({ monto_agp: Number(t.monto) })
        .eq('id', mejor.id);
      if (errUpdate) throw new Error(`Error actualizando pasada ${mejor.id}: ${errUpdate.message}`);
      actualizadas++;
    }
    await guardarTransitoRecibido(vehiculoId, t, tsTransito, codigo, mejor.id);
  }
  console.log(`[agp-transitos] ${actualizadas} actualizadas, ${sinPasada} sin pasada confirmada cercana, ${sinMapear} sin código mapeado.`);
}

async function main() {
  if (!PATENTES_AGP.length) {
    console.log('[agp-transitos] PATENTES_AGP vacío — nada que hacer todavía (ver nota arriba, pendiente instalación FTC).');
    return;
  }
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - AGP_DIAS_ATRAS * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  for (const { patente, ppu } of PATENTES_AGP) {
    const { data: vehiculo, error } = await supabase.from('porticos_vehiculos').select('id').eq('patente', patente).maybeSingle();
    if (error) throw new Error(`Error buscando vehículo ${patente}: ${error.message}`);
    if (!vehiculo) { console.log(`[agp-transitos] ${patente} no está en porticos_vehiculos, se omite.`); continue; }

    console.log(`[agp-transitos] Consultando ${ppu} (${fmt(desde)} a ${fmt(hoy)})...`);
    const resultado = await consultarAGP(ppu, fmt(desde), fmt(hoy));
    console.log(`[agp-transitos] ${resultado.transitos.length} tránsito(s) recibido(s).`);
    await emparejarYActualizar(vehiculo.id, resultado.transitos);
  }
}

main().catch((err) => {
  console.error('ERROR FATAL:', err.message);
  process.exit(1);
});
