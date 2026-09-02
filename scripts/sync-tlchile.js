#!/usr/bin/env node
'use strict';
/**
 * sync-tlchile.js
 *
 * ÚNICO punto de contacto con TrackGTS para la cuenta "amelendez"/"tlchile".
 * Reemplaza a sync-historial-santamarta.js + sync-porticos.js + el cron de
 * /api/sync (Vercel) — los tres autenticaban esta misma cuenta por separado
 * y coincidieron en logins simultáneos, lo que activó el rate-limit de
 * TrackGTS y dejó sin datos a un cliente real (2026-08-27). TrackGTS es una
 * empresa muy cerrada — ya se le pidió reiteradas veces bajar ese límite y
 * no es negociable — así que la solución es de nuestro lado: UNA sola
 * sesión por corrida, y todo lo demás (paneles internos, futuros clientes
 * de pórticos) lee exclusivamente de Supabase, nunca de TrackGTS en vivo.
 *
 * Por corrida:
 *   1) Un solo login clásico (Puppeteer) + una sola llamada a reportTravel
 *      con los unitIds de Santa Marta Y de pórticos juntos → se separan las
 *      filas por unitIdA0 y se guardan en SantaMartaHistorial /
 *      porticos_pasadas_reales (con geocercas + Telegram para pórticos).
 *   2) Authenticate + HealthCheck (API REST, mismo dominio) para los
 *      clientes "tlchile" y "mconnect" → Tracklink / MZDConnect. Antes vivía
 *      en /api/sync (Vercel, cron propio); ahora corre acá para que sea la
 *      MISMA sesión/ventana de rate-limit la que se reserva una sola vez.
 *
 * Variables de entorno esperadas (GitHub Secrets):
 *   TL_USER, TL_PASSWORD, TL_DOMAIN, SUPABASE_SERVICE_ROLE_KEY,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (opcionales, solo para pórticos)
 */

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY');
}
const supabase = createClient(
  'https://lomkolhgmkvshucqjuhf.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Candado / marca de última corrida exitosa -----------------------------
// Ya no hace falta para evitar choques entre procesos (solo queda este), pero
// se mantiene como red de seguridad ante un disparo manual (forzar-sync) que
// coincida con el cron, y "tlchile_last_success" alimenta el panel interno
// de STLC (botón "Sincronizar" ahora es de solo lectura, ver Navbar.tsx).
const TLCHILE_LOCK_KEY = 'tlchile_auth_lock';
const TLCHILE_LOCK_WINDOW_MS = 20 * 60_000;
const TLCHILE_LAST_SUCCESS_KEY = 'tlchile_last_success';

async function intentarReservarTlchile() {
  const { data } = await supabase
    .from('SyncCheckpoints')
    .select('value')
    .eq('key', TLCHILE_LOCK_KEY)
    .maybeSingle();
  const ultimo = data?.value ? new Date(data.value).getTime() : 0;
  if (Date.now() - ultimo < TLCHILE_LOCK_WINDOW_MS) return false;
  await supabase.from('SyncCheckpoints').upsert({ key: TLCHILE_LOCK_KEY, value: new Date().toISOString() });
  return true;
}

// --- Santa Marta -------------------------------------------------------------
const UNIDADES_SANTAMARTA = [
  { unitId: 6702, imei: '868589061400860', alias: 'CATERPILAR 1250 Bulldozer' },
  { unitId: 6567, imei: '868589061200856', alias: 'KOMATSU 1550 Retroexcavadora' },
  { unitId: 6700, imei: '868589061490010', alias: 'MERCEDES-BENZ-4144-HKSX-54' },
  { unitId: 6568, imei: '868589061373570', alias: 'BULLDOZER-KOMTASU-D155-AC' },
  { unitId: 5969, imei: '868589061071729', alias: 'EXCAVADORA-KOMATSU-1401-PC-220' },
];
const SANTAMARTA_CHECKPOINT_KEY = 'santamarta_pull';

// --- Pórticos ------------------------------------------------------------
const PORTICOS_CHECKPOINT_KEY = 'porticos_pull';
const PATENTES_NOTIFICAR_TELEGRAM = ['VVJG-14'];
// "patente|codigo" conocidos como falso positivo — el radio de 150m alcanza
// a rozar el pórtico pero el vehículo nunca lo cruza de verdad. La regla de
// "confirmado" (¿salió del radio después?) no alcanza a distinguir esto en
// nudos con varios pórticos reales muy juntos: el vehículo sale del radio
// de UNO porque se desvía hacia otro pórtico vecino o una calle local, no
// porque siguió de largo por la autopista. P11/PA17 (nudo de Vespucio
// Norte, Conchalí) — confirmado 2026-08-31 por el usuario: nunca le cobran
// ahí, es la salida hacia su oficina, no un cruce real.
// OJO con agregar códigos acá a la ligera: si el usuario alguna vez cruza
// ese pórtico DE VERDAD, esta lista lo silencia sin avisar. Solo van acá
// códigos donde ya se descartó explícitamente que sea un cruce real (P11
// es la salida hacia la oficina, jamás un tránsito) — no basta con "generó
// una fila pendiente sin confirmar", porque ESO ya lo resuelve solo la
// regla de "confirmado" (exige ver al vehículo salir del radio) sin
// necesidad de excluir nada. P10 se sacó de esta lista 2026-09-01 por
// justamente esa razón: es un pórtico real que el usuario sí podría cruzar
// (ej. de vuelta), y una fila pendiente sin confirmar no le genera ningún
// falso positivo visible (no notifica, no aparece en el dashboard).
const FALSOS_POSITIVOS_CONOCIDOS = new Set(['VVJG-14|P11', 'VVJG-14|PA17']);
const RADIO_GEOCERCA_M = 150;
const MIN_GAP_MS = 2 * 60 * 1000;
// Un tránsito real de un pórtico de flujo libre puede tener velocidad baja
// puntualmente (congestión) — confirmado 2026-08-28: el pórtico 3.3 registró
// velocidad_kmh=0 en una pasada REAL (monto $520,53 anotado en pantalla por
// el usuario), así que NO se puede filtrar por velocidad en la detección
// inicial. Lo que sí es señal inequívoca de vehículo estacionado (no un
// tránsito) es la MISMA pasada de un pórtico repitiéndose con velocidad baja
// y en prácticamente la misma coordenada — confirmado el mismo día: P11
// (Vespucio Norte, cerca del trabajo del usuario en Conchalí) generó 3
// "pasadas" separadas por horas, todas velocidad_kmh=0 y casi la misma
// coordenada exacta (vehículo estacionado ahí toda la jornada) — el filtro
// de 3h (VENTANA_MISMA_PASADA_MS) no las agarraba porque estaban espaciadas
// por más de 3h entre sí. Para una repetición de baja velocidad se usa una
// ventana mucho más larga (un día laboral completo) en vez de 3h.
const VELOCIDAD_MINIMA_TRANSITO_KMH = 5;
const VENTANA_ESTACIONADO_MS = 20 * 60 * 60 * 1000;

const PORTICOS = [
  { codigo: 'P3',   concesionaria: 'Costanera Norte',   tramo: 'Puente Lo Saldes – Vivaceta',                lat: -33.4240, lon: -70.6220 },
  { codigo: 'P8',   concesionaria: 'Vespucio Norte',    tramo: 'Ruta 5 Norte – Condell',                     lat: -33.3730, lon: -70.7113 },
  { codigo: 'P11',  concesionaria: 'Vespucio Norte',    tramo: 'Pedro Fontova – Ruta 5 Norte',                lat: -33.3658, lon: -70.6951 },
  { codigo: 'P13',  concesionaria: 'Vespucio Norte',    tramo: 'Recoleta – Pedro Fontova',                    lat: -33.3734, lon: -70.6646 },
  // Vespucio Norte tiene un corredor completo de 17 pórticos (P1-P17), cada
  // uno de un solo sentido y en un punto físico DISTINTO (a diferencia de
  // Autopista Central, acá no hay pares base/alterno en la misma
  // coordenada) — solo P8/P11/P13 estaban cargados. Faltaba el resto,
  // incluyendo todo el tramo occidental (Costanera Norte–Ruta 68–Ruta 78).
  // Confirmado 2026-08-31: el regreso real de VVJG-14 esa noche pasó por
  // ahí (P9 confirmado por proximidad al track GPS; el resto del tramo
  // Ruta 68/Ruta 78 quedó geográficamente identificado pero sin poder
  // calzar con certeza cuáles de los ~8 pórticos candidatos cobraron
  // realmente los 6 montos que el usuario anotó — el TAG del vehículo
  // (contrato de arriendo) no tiene cuenta propia con historial accesible).
  // Coordenadas: capa pública tag.cl/OSM. Tarifas: oficial 2026 MOP
  // (concesiones.mop.gob.cl/uploads/sites/4/2026/01/VESPUCIO-NORTE.pdf) —
  // esta misma fuente resuelve la incertidumbre vieja de P8/P11/P13 (ver
  // TARIFAS abajo, quedan actualizados con esta fuente oficial).
  { codigo: 'P15',  concesionaria: 'Vespucio Norte', tramo: 'El Salto – Recoleta',                lat: -33.388664, lon: -70.632967 },
  { codigo: 'P14',  concesionaria: 'Vespucio Norte', tramo: 'Guanaco – El Salto',                 lat: -33.388604, lon: -70.633316 },
  { codigo: 'P12',  concesionaria: 'Vespucio Norte', tramo: 'Pedro Fontova – Guanaco',            lat: -33.373394, lon: -70.664973 },
  { codigo: 'P10',  concesionaria: 'Vespucio Norte', tramo: 'Ruta 5 Norte – Pedro Fontova',       lat: -33.365948, lon: -70.696904 },
  { codigo: 'P9',   concesionaria: 'Vespucio Norte', tramo: 'Lo Echevers – Ruta 5 Norte',         lat: -33.368877, lon: -70.704343 },
  { codigo: 'P7',   concesionaria: 'Vespucio Norte', tramo: 'Condell – Lo Echevers',              lat: -33.381320, lon: -70.753937 },
  // P6/P5 y P17/P1 quedan a 30-60m entre sí — a diferencia del resto del
  // corredor (puntos físicos distintos), estos dos SÍ son el mismo punto
  // real en direcciones opuestas (igual que Autopista Central) y ambos
  // caían dentro del radio del otro, disparando doble por un solo cruce.
  // Solo se agrega el código en sentido Oriente-Poniente (el que usa la
  // ruta real observada) como entrada física; P5/P1 quedan como `alterno`
  // en PARES_DIRECCIONALES.
  { codigo: 'P6',   concesionaria: 'Vespucio Norte', tramo: 'Condell – Costanera Norte',          lat: -33.399353, lon: -70.775564 },
  { codigo: 'P4',   concesionaria: 'Vespucio Norte', tramo: 'Costanera Norte – Ruta 68',          lat: -33.431288, lon: -70.784851 },
  // "P3VN" para no chocar con el P3 de Costanera Norte (arriba) — mismo
  // código público "P3" pero son dos pórticos físicos distintos de dos
  // concesionarias distintas (coincidencia real de numeración, no un error).
  { codigo: 'P3VN', concesionaria: 'Vespucio Norte', tramo: 'Ruta 68 – Costanera Norte',          lat: -33.438714, lon: -70.783138 },
  { codigo: 'P2',   concesionaria: 'Vespucio Norte', tramo: 'Ruta 68 – Los Mares',                lat: -33.456380, lon: -70.767152 },
  { codigo: 'P16',  concesionaria: 'Vespucio Norte', tramo: 'Santa Elena – Ruta 68',              lat: -33.451213, lon: -70.772985 },
  { codigo: 'P17',  concesionaria: 'Vespucio Norte', tramo: 'Los Mares – Ruta 78',                lat: -33.482867, lon: -70.753573 },
  // PA19 — coordenada actualizada 2026-08-28 (la anterior nunca se validó con
  // una pasada real). Nueva coordenada calculada por distancia acumulada real
  // sobre el track GPS de VVJG-14, entre 2.2 y el resto de pórticos de
  // Autopista Central (Eje Gral. Velásquez) — ver PA21/PA23/PA25 abajo.
  { codigo: 'PA19', concesionaria: 'Autopista Central', tramo: 'Ruta 5 Sur – Américo Vespucio',               lat: -33.510753, lon: -70.699381 },
  { codigo: 'PA21', concesionaria: 'Autopista Central', tramo: 'Américo Vespucio – Carlos Valdovinos',        lat: -33.473049, lon: -70.687728 },
  { codigo: 'PA23', concesionaria: 'Autopista Central', tramo: 'Carlos Valdovinos – Alameda',                 lat: -33.438662, lon: -70.691992 },
  { codigo: 'PA25', concesionaria: 'Autopista Central', tramo: 'Alameda – Río Mapocho',                       lat: -33.408249, lon: -70.694405 },
  // PA24/PA26/PA20/PA22/PA29 (sentido Norte-Sur, de vuelta) y PA28 (tramo
  // norte, ver más abajo) — mismo punto físico que su par de ida, código
  // distinto según sentido. IMPORTANTE: NO se agregan como entradas propias
  // acá — solo existen como `alterno` dentro de PARES_DIRECCIONALES (igual
  // que 4.3/3.4/3.2 de Vespucio Sur). Agregarlos como entrada física
  // duplicada (bug real encontrado y corregido 2026-08-29) hace que la
  // geocerca dispare AMBOS códigos para el mismo cruce, porque el punto
  // cae dentro del radio de las dos entradas por separado — una de ellas se
  // resuelve bien por dirección, pero la otra (sin par definido para SU
  // propio código) siempre devuelve su código tal cual, sin importar el
  // sentido real de circulación.
  { codigo: 'PA28', concesionaria: 'Autopista Central', tramo: 'Río Mapocho – Ruta 5 Norte',                   lat: -33.391238, lon: -70.699554 },
  // Autopista Central tiene DOS ejes físicos distintos que comparten la
  // numeración "PA" pero son corredores separados: el bloque de arriba
  // (PA19/21/23/25/28) es el "Eje Gral. Velásquez"; este bloque es el
  // "Eje Norte-Sur" (alineado con Av. Departamental/Carlos Valdovinos/Av.
  // Río Mapocho/14 de la Fama). Faltaba por completo — confirmado
  // 2026-08-31 con el track GPS real de VVJG-14 (La Florida → El Cortijo,
  // Conchalí): el sistema solo detectó P11 de los 3 pórticos que el
  // usuario vio en pantalla ($738/$364/$850) porque este eje entero no
  // tenía geocercas cargadas. Coordenadas de la capa pública de OSM
  // (barrier=toll_booth / highway=toll_gantry, exportada por el usuario),
  // cruzadas contra el track GPS real (6-90m de distancia en cada una).
  // Tarifas TBFP/TBP del tarifario oficial 2026 (concesiones.mop.gob.cl);
  // TS = 3×TBFP (misma fórmula que la tarifa base declarada en ese PDF:
  // TBFP 92,021 $/km, TBP 184,042 $/km, TS 276,063 $/km — TS no lo usa hoy
  // bandaHeuristica, que solo elige entre TBFP/TBP). PA31/PA13/PA16
  // CONFIRMADOS: el TBP calculado coincidió exacto con lo que el usuario
  // vio en pantalla a las 08:00/08:06/08:10 ese día. PA30/PA10/PA9/PA11/
  // PA17/PA18/PA12/PA14/PA15 son el resto del mismo corredor (Departamental
  // hasta Vespucio Norte) con tarifa oficial pero sin cruce real todavía.
  { codigo: 'PA30', concesionaria: 'Autopista Central', tramo: 'Américo Vespucio – Departamental',             lat: -33.507288, lon: -70.669319 },
  { codigo: 'PA10', concesionaria: 'Autopista Central', tramo: 'Departamental – Carlos Valdovinos',            lat: -33.495772, lon: -70.663899 },
  { codigo: 'PA31', concesionaria: 'Autopista Central', tramo: 'Carlos Valdovinos – Alameda',                 lat: -33.469011, lon: -70.656243 },
  { codigo: 'PA13', concesionaria: 'Autopista Central', tramo: 'Alameda – Río Mapocho',                       lat: -33.448923, lon: -70.659592 },
  { codigo: 'PA16', concesionaria: 'Autopista Central', tramo: 'Río Mapocho – 14 de la Fama',                 lat: -33.417186, lon: -70.678723 },
  { codigo: 'PA17', concesionaria: 'Autopista Central', tramo: '14 de la Fama – Américo Vespucio Norte',      lat: -33.368582, lon: -70.699104 },
  { codigo: '2.2',  concesionaria: 'Vespucio Sur',      tramo: 'Gral. Velásquez – Ruta 5',                    lat: -33.5263, lon: -70.6941 },
  { codigo: '5.2',  concesionaria: 'Vespucio Sur',      tramo: 'Quilín – Grecia',                             lat: -33.4810, lon: -70.5788 },
  // Vespucio Sur 4.1/3.1/3.3 — agregados 2026-08-28. Coordenadas tomadas del
  // propio track GPS real de VVJG-14 (frenada/parada del vehículo justo en
  // ese punto), confirmadas porque el monto coincide EXACTO con la tarifa
  // oficial investigada (311,52 / 665,24 / 520,53 — ver dashboard.html) y el
  // usuario anotó ese mismo monto en pantalla del pórtico el 2026-08-28.
  { codigo: '4.1',  concesionaria: 'Vespucio Sur',      tramo: 'Gnmo. de Alderete – Santa Julia',            lat: -33.541545, lon: -70.640163 },
  { codigo: '3.1',  concesionaria: 'Vespucio Sur',      tramo: 'Santa Rosa – Gran Avenida',                  lat: -33.538576, lon: -70.658991 },
  { codigo: '3.3',  concesionaria: 'Vespucio Sur',      tramo: 'Gran Avenida – Ruta 5',                      lat: -33.534718, lon: -70.672764 },
  // 1.1/4.2 — agregados 2026-09-01, confirmados con el regreso real de
  // VVJG-14 esa noche (11m de distancia al track GPS real en ambos casos,
  // monto TBFP exacto: $532,59≈$532 y $798,89≈$798). Tarifario oficial 2026
  // MOP (concesiones.mop.gob.cl/uploads/sites/4/2026/01/VESPUCIO-SUR.pdf) —
  // esa misma fuente confirma sin cambios los montos ya cargados de 2.2/
  // 5.2/4.1/3.1/3.3/4.3/3.4/3.2.
  { codigo: '1.1',  concesionaria: 'Vespucio Sur',      tramo: 'General Velásquez – Ruta 78',                lat: -33.516561, lon: -70.712534 },
  { codigo: '4.2',  concesionaria: 'Vespucio Sur',      tramo: 'Gnmo. de Alderete – Vicuña Mackenna',        lat: -33.526802, lon: -70.602574 },
  // Ruta 5 Norte — agregados 2026-08-27. Únicos peajes interurbanos con
  // coordenadas confiables encontradas (OpenStreetMap, cruzadas con el km
  // oficial MOP/concesionaria) — el resto del catálogo nacional (Tarifas)
  // no tiene coordenadas publicadas y queda solo de referencia.
  { codigo: 'LAMPA',        concesionaria: 'Ruta 5 Norte (Aconcagua)', tramo: 'Km 26, Lampa',                lat: -33.2356, lon: -70.7589 },
  { codigo: 'LASVEGAS',     concesionaria: 'Ruta 5 Norte (Aconcagua)', tramo: 'Km 89, Llay-Llay',             lat: -32.8433, lon: -70.9893 },
  { codigo: 'PICHIDANGUI',  concesionaria: 'Ruta 5 Norte (Aconcagua)', tramo: 'Km 163, La Ligua',             lat: -32.1750, lon: -71.5207 },
  { codigo: 'TRONCALSUR',   concesionaria: 'Ruta 5 Norte (Ruta del Elqui)', tramo: 'Km 283, Canela (Troncal Sur)', lat: -31.4200, lon: -71.5704 },
  { codigo: 'TONGOY',       concesionaria: 'Ruta 5 Norte (Ruta del Elqui)', tramo: 'Acceso sur Tongoy (Lateral)',  lat: -30.3517, lon: -71.4323 },
  { codigo: 'GUANAQUEROS',  concesionaria: 'Ruta 5 Norte (Ruta del Elqui)', tramo: 'Guanaqueros (Lateral)',        lat: -30.1974, lon: -71.3880 },
  { codigo: 'PTACOLORADA',  concesionaria: 'Ruta 5 Norte (Ruta del Algarrobo)', tramo: 'Km 554, La Higuera (Punta Colorada)', lat: -29.3710, lon: -71.0732 },
  { codigo: 'TOTORAL',      concesionaria: 'Ruta 5 Norte (Valles del Desierto)', tramo: 'Km 732, norte de Vallenar (Totoral)', lat: -27.9971, lon: -70.5658 },
  { codigo: 'PTOVIEJO',     concesionaria: 'Ruta 5 Norte (Valles del Desierto)', tramo: 'Km 841, norte de Copiapó (Puerto Viejo)', lat: -27.3482, lon: -70.6364 },
  // Costanera Norte completo (P0-P9, EP/EV/SB) — agregado 2026-09-01, ver
  // fuentes en TARIFAS abajo. El P3 de esta concesionaria ya estaba cargado
  // (arriba, junto a P8/P11/P13) y coincide exacto con esta misma fuente
  // oficial — no se duplica.
  { codigo: 'P0',   concesionaria: 'Costanera Norte', tramo: 'Puente Padre Arteaga – Puente San Francisco', lat: -33.371106, lon: -70.522745 },
  { codigo: 'P1CN', concesionaria: 'Costanera Norte', tramo: 'Puente San Francisco – Gran Vía',              lat: -33.375775, lon: -70.542855 },
  { codigo: 'P2.1', concesionaria: 'Costanera Norte', tramo: 'Gran Vía – Centenario',                        lat: -33.384644, lon: -70.592650 },
  { codigo: 'P2.2CN', concesionaria: 'Costanera Norte', tramo: 'Centenario – Puente Lo Saldes',               lat: -33.394427, lon: -70.603456 },
  { codigo: 'P4CN', concesionaria: 'Costanera Norte', tramo: 'Vivaceta – Torres Tajamar',                    lat: -33.430225, lon: -70.657961 },
  { codigo: 'P5CN', concesionaria: 'Costanera Norte', tramo: 'Vivaceta – Carrascal',                         lat: -33.426438, lon: -70.669833 },
  { codigo: 'P6.1', concesionaria: 'Costanera Norte', tramo: 'Carrascal – Petersen',                         lat: -33.411710, lon: -70.739581 },
  { codigo: 'P6.2', concesionaria: 'Costanera Norte', tramo: 'Petersen – Américo Vespucio Poniente',         lat: -33.412972, lon: -70.766457 },
  { codigo: 'P7CN', concesionaria: 'Costanera Norte', tramo: 'Estoril – Las Tranqueras',                     lat: -33.387681, lon: -70.542926 },
  { codigo: 'P8.0', concesionaria: 'Costanera Norte', tramo: 'Las Tranqueras – Costanera Norte',             lat: -33.408073, lon: -70.599764 },
  { codigo: 'P8.1', concesionaria: 'Costanera Norte', tramo: 'Las Tranqueras – Costanera Norte',             lat: -33.408141, lon: -70.599763 },
  { codigo: 'P8.2', concesionaria: 'Costanera Norte', tramo: 'Costanera Norte – Las Tranqueras',              lat: -33.408491, lon: -70.601945 },
  { codigo: 'P8.3', concesionaria: 'Costanera Norte', tramo: 'Costanera Norte – Las Tranqueras',              lat: -33.409988, lon: -70.602224 },
  { codigo: 'P9CN', concesionaria: 'Costanera Norte', tramo: 'Ruta 68 – Américo Vespucio Poniente',          lat: -33.418078, lon: -70.791003 },
  { codigo: 'EP',   concesionaria: 'Costanera Norte', tramo: 'Entrada Purísima',                              lat: -33.430280, lon: -70.657227 },
  { codigo: 'EV',   concesionaria: 'Costanera Norte', tramo: 'Entrada Vivaceta',                              lat: -33.430280, lon: -70.657227 },
  { codigo: 'SB',   concesionaria: 'Costanera Norte', tramo: 'Salida Bellavista',                             lat: -33.422147, lon: -70.619825 },
  // AVO (Américo Vespucio Oriente, tramo El Salto–Príncipe de Gales) —
  // agregado 2026-09-01. OJO: esta concesionaria cobra por KILÓMETROS
  // RECORRIDOS entre el pórtico de entrada y el de salida (no un monto fijo
  // por pórtico individual como el resto del sistema) — no encaja en el
  // modelo TARIFAS[codigo][banda] de este archivo. Se agregan solo las
  // coordenadas para que la detección/geocerca funcione; el monto queda
  // "no estimable" (sin entrada en TARIFAS, ver mensajePasada) hasta que se
  // rediseñe el cálculo para pares entrada-salida.
  { codigo: 'P101', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Bilbao',                    lat: -33.430139, lon: -70.574703 },
  { codigo: 'P102', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Martín de Zamora',          lat: -33.420415, lon: -70.581420 },
  { codigo: 'P103', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Los Militares',             lat: -33.412457, lon: -70.582035 },
  { codigo: 'P104', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Presidente Riesco',         lat: -33.409402, lon: -70.586971 },
  { codigo: 'P105', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Salida Kennedy Oriente',    lat: -33.401491, lon: -70.580488 },
  { codigo: 'P106', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Salida Kennedy Poniente',   lat: -33.405036, lon: -70.586333 },
  { codigo: 'P107', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Kennedy – Vespucio',        lat: -33.409307, lon: -70.586937 },
  { codigo: 'P108', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Costanera Norte – Nororiente', lat: -33.396604, lon: -70.588756 },
  { codigo: 'P109', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Puente Centenario',         lat: -33.392756, lon: -70.592471 },
  { codigo: 'P110', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'La Pirámide',               lat: -33.395250, lon: -70.610110 },
  { codigo: 'P111', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Cerro Colorado',            lat: -33.405036, lon: -70.586333 },
  { codigo: 'P201', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'C. Empresarial – El Salto', lat: -33.396448, lon: -70.619800 },
  { codigo: 'P202', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Viaducto',                  lat: -33.395250, lon: -70.610110 },
  { codigo: 'P203', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Costanera Norte Oriente',   lat: -33.396148, lon: -70.604134 },
  { codigo: 'P204', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Salida Av. Vitacura',       lat: -33.391634, lon: -70.597093 },
  { codigo: 'P205', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Vitacura',                  lat: -33.400234, lon: -70.587549 },
  { codigo: 'P206', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Kennedy – Vespucio Sur',    lat: -33.401491, lon: -70.580488 },
  { codigo: 'P209', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Cristóbal Colón',           lat: -33.424430, lon: -70.578416 },
  { codigo: 'P210', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Isabel la Católica',        lat: -33.425970, lon: -70.575685 },
  { codigo: 'P211', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Tobalaba',                  lat: -33.432543, lon: -70.574492 },
  { codigo: 'P212', concesionaria: 'Vespucio Oriente (AVO)', tramo: 'Costanera Sur',             lat: -33.391634, lon: -70.597093 },
  // Túnel San Cristóbal (Variante Vespucio, El Salto–Kennedy) — agregado
  // 2026-09-01, tarifario oficial 2026 MOP. A diferencia de AVO, este SÍ es
  // un cobro fijo por pórtico (un solo túnel, dos sentidos).
  { codigo: 'PC101', concesionaria: 'Túnel San Cristóbal', tramo: 'El Salto – Kennedy', lat: -33.398616, lon: -70.615725 },
  { codigo: 'PC102', concesionaria: 'Túnel San Cristóbal', tramo: 'Kennedy – El Salto', lat: -33.398800, lon: -70.615132 },
  // Acceso Vial AMB (camino al Aeropuerto A. Merino Benítez) — agregado
  // 2026-09-01. Un solo pórtico. Monto aproximado ("peaje a luca", ~$1.000
  // para categoría 1, anunciado por MOP para 2026) — sin tarifario oficial
  // detallado por banda horaria encontrado todavía, tratar como estimado
  // grueso hasta confirmar con una pasada real.
  { codigo: 'AMB', concesionaria: 'Acceso Vial AMB', tramo: 'Peaje Acceso Vial AMB', lat: -33.416596, lon: -70.792727 },
];

// Algunos pares de pórticos de Vespucio Sur comparten prácticamente la
// misma posición física (las dos calzadas — ida y vuelta — quedan lo
// bastante cerca como para caer en el mismo radio de 150m), pero el código
// y la tarifa oficial correcta dependen del sentido de viaje. Confirmado en
// vivo el 2026-08-28 con el track GPS real de VVJG-14: mismo punto exacto,
// "4.1" a la ida (longitud GPS decreciente, viajando hacia el poniente) y
// "4.3" a la vuelta (longitud creciente, hacia el oriente) — mismo patrón
// para 3.1↔3.4 y 3.3↔3.2. El monto anotado en pantalla por el usuario en
// ambos viajes coincidió exacto con la tarifa oficial de cada código.
// Vespucio Sur (anillo E-O) se resuelve por tendencia de LONGITUD: positivo =
// longitud creciente = hacia el oriente = código alterno. Autopista Central /
// Eje Gral. Velásquez (corredor N-S) se resuelve por tendencia de LATITUD:
// positivo = latitud creciente = hacia el norte = código BASE (las columnas
// "Sur-Norte" del tarifario), negativo = hacia el sur = código alterno
// ("Norte-Sur") — polaridad opuesta a Vespucio Sur, por eso `positivoEsAlterno`.
const PARES_DIRECCIONALES = {
  '4.1': { eje: 'lon', positivoEsAlterno: true,  alterno: '4.3',  tramoAlterno: 'Coronel – Santa Julia' },
  '3.1': { eje: 'lon', positivoEsAlterno: true,  alterno: '3.4',  tramoAlterno: 'Ruta 5 – Gran Avenida' },
  '3.3': { eje: 'lon', positivoEsAlterno: true,  alterno: '3.2',  tramoAlterno: 'Gran Avenida – Santa Rosa' },
  PA23:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA24', tramoAlterno: 'Alameda – Carlos Valdovinos' },
  PA25:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA26', tramoAlterno: 'Río Mapocho – Alameda' },
  PA19:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA20', tramoAlterno: 'Américo Vespucio – Ruta 5 Sur' },
  PA21:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA22', tramoAlterno: 'Carlos Valdovinos – Américo Vespucio' },
  PA28:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA29', tramoAlterno: 'Ruta 5 Norte – Río Mapocho' },
  // Eje Norte-Sur (ver PORTICOS) — misma convención de latitud que Eje Gral.
  // Velásquez, porque ambos corredores corren N-S.
  PA30:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA9',  tramoAlterno: 'Departamental – Américo Vespucio' },
  PA10:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA11', tramoAlterno: 'Carlos Valdovinos – Departamental' },
  PA31:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA12', tramoAlterno: 'Alameda – Carlos Valdovinos' },
  PA13:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA14', tramoAlterno: 'Río Mapocho – Alameda' },
  PA16:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA15', tramoAlterno: '14 de la Fama – Río Mapocho' },
  PA17:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA18', tramoAlterno: 'Américo Vespucio Norte – 14 de la Fama' },
  // Vespucio Norte occidental (ver PORTICOS) — mismo corredor E-O que
  // Vespucio Sur, misma convención de longitud.
  P6:    { eje: 'lon', positivoEsAlterno: true,  alterno: 'P5',   tramoAlterno: 'Costanera Norte – Condell' },
  P17:   { eje: 'lon', positivoEsAlterno: true,  alterno: 'P1',   tramoAlterno: 'Ruta 78 – Santa Elena' },
};

// anterior/actual son los dos puntos GPS consecutivos que generaron la
// detección — si no hay "anterior" (primer punto de la corrida) se asume
// el código base por defecto, no se puede determinar sentido.
function resolverCodigoDireccional(portico, anterior, actual) {
  const par = PARES_DIRECCIONALES[portico.codigo];
  if (!par || !anterior) return { codigo: portico.codigo, tramo: portico.tramo };
  const tendencia = par.eje === 'lat' ? actual.lat - anterior.lat : actual.lon - anterior.lon;
  const esAlterno = par.positivoEsAlterno ? tendencia > 0 : tendencia < 0;
  if (esAlterno) return { codigo: par.alterno, tramo: par.tramoAlterno };
  return { codigo: portico.codigo, tramo: portico.tramo };
}

const TARIFAS = {
  // P3/2.2/5.2 actualizados 2026-08-27 al tarifario 2026 vigente (ver dashboard.html
  // para la fuente/detalle).
  P3:   { TBFP: 719, TBP: 1384, TS: 2097 },
  // Vespucio Norte completo (P1-P17) — tarifario oficial 2026 MOP
  // (concesiones.mop.gob.cl/uploads/sites/4/2026/01/VESPUCIO-NORTE.pdf),
  // agregado 2026-08-31. Esta misma fuente resuelve la incertidumbre vieja
  // de P8/P11/P13 ("cifras contradictorias") — quedan actualizados acá.
  // TS = TBP para los pórticos donde el PDF no define una tercera banda
  // (columna "-"), mismo criterio que el resto del archivo.
  P15:  { TBFP: 141, TBP: 281,  TS: 422  },
  P14:  { TBFP: 483, TBP: 967,  TS: 967  },
  P13:  { TBFP: 412, TBP: 824,  TS: 1236 },
  P12:  { TBFP: 69,  TBP: 139,  TS: 139  },
  P11:  { TBFP: 301, TBP: 603,  TS: 603  },
  P10:  { TBFP: 301, TBP: 603,  TS: 904  },
  P9:   { TBFP: 549, TBP: 1097, TS: 1097 },
  P8:   { TBFP: 653, TBP: 1306, TS: 1306 },
  P7:   { TBFP: 105, TBP: 209,  TS: 209  },
  P6:   { TBFP: 452, TBP: 904,  TS: 904  },
  P5:   { TBFP: 452, TBP: 904,  TS: 1357 },
  P4:   { TBFP: 352, TBP: 703,  TS: 1055 },
  P3VN: { TBFP: 352, TBP: 703,  TS: 1055 },
  P2:   { TBFP: 211, TBP: 422,  TS: 633  },
  P16:  { TBFP: 482, TBP: 965,  TS: 1447 },
  P17:  { TBFP: 392, TBP: 784,  TS: 1176 },
  P1:   { TBFP: 121, TBP: 241,  TS: 362  },
  // PA19/21/23/25 actualizados 2026-08-28 con el tarifario oficial 2026 de
  // autopistacentral.cl (texto limpio, no imagen — alta confianza). PA19 y
  // PA21 son tarifa plana (sin banda horaria definida). PA23/PA25 sí tienen
  // banda punta (07:00-10:00 y 07:00-09:30/14:30-15:00/19:00-19:30
  // respectivamente) — el monto TBP coincidió exacto con lo que el usuario
  // anotó en pantalla (576 y 844) el mismo día en ese horario.
  PA19: { TBFP: 413, TBP: 413,  TS: 413  },
  PA21: { TBFP: 512, TBP: 512,  TS: 512  },
  PA23: { TBFP: 288, TBP: 576,  TS: 576  },
  PA25: { TBFP: 422, TBP: 844,  TS: 844  },
  // PA24/PA26 (sentido Norte-Sur, ver PORTICOS) — mismo monto TBFP/TBP que
  // PA23/PA25, ventana horaria distinta.
  PA24: { TBFP: 288, TBP: 576,  TS: 864  },
  PA26: { TBFP: 422, TBP: 844,  TS: 844  },
  // PA20/PA22 (sentido Norte-Sur, ver PORTICOS) — mismo monto flat que PA19/PA21.
  PA20: { TBFP: 413, TBP: 413,  TS: 413  },
  PA22: { TBFP: 512, TBP: 512,  TS: 512  },
  // PA28 (ida, con TS)/PA29 (vuelta, sin TS) — ver PORTICOS.
  PA28: { TBFP: 512, TBP: 1025, TS: 1537 },
  PA29: { TBFP: 512, TBP: 1025, TS: 1025 },
  // Eje Norte-Sur (ver PORTICOS/PARES_DIRECCIONALES) — tarifario oficial 2026
  // MOP (concesiones.mop.gob.cl), TS = 3×TBFP por la fórmula declarada en ese
  // PDF (no la usa bandaHeuristica hoy, solo referencia). PA31/PA13/PA16
  // CONFIRMADOS: coincidieron exacto con el monto en pantalla el 2026-08-31
  // (08:00/08:06/08:10, TBP en los 3 casos). PA30/PA10/PA9/PA11/PA17/PA18/
  // PA12/PA14/PA15 son la misma fuente oficial sin cruce real todavía.
  PA30: { TBFP: 393, TBP: 786,  TS: 1178 },
  PA9:  { TBFP: 393, TBP: 786,  TS: 1178 },
  PA10: { TBFP: 286, TBP: 572,  TS: 857  },
  PA11: { TBFP: 286, TBP: 572,  TS: 857  },
  PA31: { TBFP: 369, TBP: 738,  TS: 1107 },
  PA12: { TBFP: 369, TBP: 738,  TS: 1107 },
  PA13: { TBFP: 182, TBP: 364,  TS: 546  },
  PA14: { TBFP: 182, TBP: 364,  TS: 546  },
  PA16: { TBFP: 425, TBP: 850,  TS: 1275 },
  PA15: { TBFP: 425, TBP: 850,  TS: 1275 },
  PA17: { TBFP: 462, TBP: 925,  TS: 1387 },
  PA18: { TBFP: 462, TBP: 925,  TS: 1387 },
  '2.2':{ TBFP: 251, TBP: 502,  TS: 754  },
  '5.2':{ TBFP: 290, TBP: 581,  TS: 871  },
  // 1.1/4.2 — ver PORTICOS arriba (fuente y confirmación).
  '1.1':{ TBFP: 533, TBP: 1065, TS: 1065 },
  '4.2':{ TBFP: 266, TBP: 533,  TS: 799  },
  '4.1':{ TBFP: 312, TBP: 623,  TS: 623  },
  '3.1':{ TBFP: 333, TBP: 665,  TS: 998  },
  '3.3':{ TBFP: 260, TBP: 521,  TS: 781  },
  // Códigos "alternos" (sentido contrario) de 4.1/3.1/3.3 — ver
  // PARES_DIRECCIONALES_VESPUCIO_SUR. Confirmados 2026-08-28 con el monto
  // real anotado por el usuario al volver por el mismo tramo.
  '4.3':{ TBFP: 45,  TBP: 90,   TS: 136  },
  '3.4':{ TBFP: 121, TBP: 241,  TS: 362  },
  '3.2':{ TBFP: 472, TBP: 945,  TS: 1417 },
  // Ruta 5 Norte — tarifas planas (sin banda horaria oficial), mismo monto
  // en las 3 columnas para que el cálculo de banda no cambie el resultado.
  LAMPA:       { TBFP: 900,  TBP: 900,  TS: 900  },
  LASVEGAS:    { TBFP: 2900, TBP: 2900, TS: 2900 },
  PICHIDANGUI: { TBFP: 2900, TBP: 2900, TS: 2900 },
  TRONCALSUR:  { TBFP: 4250, TBP: 4250, TS: 4250 },
  TONGOY:      { TBFP: 1100, TBP: 1100, TS: 1100 },
  GUANAQUEROS: { TBFP: 1100, TBP: 1100, TS: 1100 },
  PTACOLORADA: { TBFP: 3150, TBP: 3150, TS: 3150 },
  TOTORAL:     { TBFP: 2900, TBP: 2900, TS: 2900 },
  PTOVIEJO:    { TBFP: 1750, TBP: 1750, TS: 1750 },
  // Costanera Norte — tarifario oficial 2026 MOP
  // (concesiones.mop.gob.cl/uploads/sites/4/2026/07/COSTANERA-NORTE.pdf).
  P0:    { TBFP: 150, TBP: 288,  TS: 437  },
  P1CN:  { TBFP: 449, TBP: 865,  TS: 1310 },
  'P2.1':{ TBFP: 426, TBP: 820,  TS: 1242 },
  'P2.2CN': { TBFP: 264, TBP: 509,  TS: 771  },
  P4CN:  { TBFP: 413, TBP: 795,  TS: 1204 },
  P5CN:  { TBFP: 716, TBP: 1378, TS: 1378 },
  'P6.1':{ TBFP: 240, TBP: 461,  TS: 461  },
  'P6.2':{ TBFP: 365, TBP: 702,  TS: 702  },
  P7CN:  { TBFP: 250, TBP: 482,  TS: 730  },
  'P8.0':{ TBFP: 584, TBP: 1124, TS: 1702 },
  'P8.1':{ TBFP: 584, TBP: 1124, TS: 1702 },
  'P8.2':{ TBFP: 584, TBP: 1124, TS: 1702 },
  'P8.3':{ TBFP: 584, TBP: 1124, TS: 1702 },
  P9CN:  { TBFP: 535, TBP: 1030, TS: 1030 },
  EP:    { TBFP: 226, TBP: 435,  TS: 658  },
  EV:    { TBFP: 119, TBP: 230,  TS: 348  },
  SB:    { TBFP: 234, TBP: 450,  TS: 682  },
  // AVO (P101-P212): sin entrada acá a propósito — cobra por distancia
  // recorrida, no encaja en TARIFAS[codigo][banda]. mensajePasada() ya
  // maneja un código sin tarifa como "no estimable" sin crashear.
  // Túnel San Cristóbal — tarifario oficial 2026 MOP.
  PC101: { TBFP: 565, TBP: 904,  TS: 1131 },
  PC102: { TBFP: 452, TBP: 678,  TS: 678  },
  // Acceso Vial AMB — estimado grueso ("peaje a luca" anunciado por MOP
  // para 2026), sin tarifario oficial detallado por banda encontrado.
  AMB:   { TBFP: 1000, TBP: 1000, TS: 1000 },
};

// --- HealthCheck (Tracklink / MZDConnect) -----------------------------------
const HEALTHCHECK_CUSTOMERS = [
  { customer: 'tlchile',  tabla: 'Tracklink' },
  { customer: 'mconnect', tabla: 'MZDConnect' },
];

async function notificarTelegram(texto) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID no configurados, se omite notificación.');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto, parse_mode: 'HTML' }),
  });
  if (!res.ok) console.log(`[telegram] Error enviando mensaje: HTTP ${res.status} ${await res.text()}`);
}

function fmtFechaHoraChile(iso) {
  const d = new Date(new Date(iso).getTime() - 4 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function diaChile(date) {
  const d = new Date(date.getTime() - 4 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function clp(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

function fmtTL(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Postgres no permite que un mismo upsert() incluya dos filas que apunten
// al mismo conflicto cuando se resuelve con DO UPDATE (a diferencia de
// ignoreDuplicates/DO NOTHING) — revienta con "ON CONFLICT DO UPDATE command
// cannot affect row a second time". reportTravel puede devolver más de un
// punto con el mismo (IMEI, gpsUtcTime) dentro de una misma consulta, así
// que hay que des-duplicar el lote ANTES de cada upsert (se queda con la
// última ocurrencia, que trae los datos más frescos).
function dedupePorClave(filas, claveDe) {
  const porClave = new Map();
  for (const f of filas) porClave.set(claveDe(f), f);
  return Array.from(porClave.values());
}

function haversineMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Distancia mínima entre un punto (el pórtico) y el TRAMO RECTO entre dos
// lecturas GPS consecutivas — no solo la distancia a cada lectura suelta.
// Con GPS que reporta cada 30-60+ segundos, un auto a velocidad de autopista
// puede cruzar un círculo de 150m ENTRE dos lecturas sin que ninguna caiga
// adentro; revisando el tramo se detecta igual. Aproximación plana (válida
// para segmentos de unos pocos km, muy por sobre la distancia real entre
// dos puntos GPS consecutivos de un mismo vehículo).
function distanciaPuntoASegmentoMetros(latP, lonP, latA, lonA, latB, lonB) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const cosRef = Math.cos(toRad(latP));
  const ax = toRad(lonA - lonP) * cosRef * R;
  const ay = toRad(latA - latP) * R;
  const bx = toRad(lonB - lonP) * cosRef * R;
  const by = toRad(latB - latP) * R;
  const dx = bx - ax, dy = by - ay;
  const lenCuadrado = dx * dx + dy * dy;
  let t = lenCuadrado === 0 ? 0 : (-ax * dx - ay * dy) / lenCuadrado;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

// Un tránsito real SIGUE de largo después del pórtico; un vehículo que
// termina su viaje (se estaciona) justo dentro del radio de una geocerca
// real nunca vuelve a aparecer fuera de ella. Antes de dar una pasada por
// confirmada (y recién ahí notificar por Telegram / contarla en el
// dashboard o en la API de AGP) se exige encontrar al menos un punto GPS
// POSTERIOR ya fuera del radio — mismo criterio tanto dentro de la corrida
// actual (un tránsito real en autopista sale del radio en la siguiente
// lectura, 30-60s después) como entre corridas (se reintenta cada 30 min
// contra las pasadas todavía sin confirmar). Bug real confirmado
// 2026-08-31: la oficina de un cliente quedó dentro del radio de 150m de
// un pórtico real de Vespucio Norte (P11) — cada llegada a estacionarse
// generaba una "pasada" y una notificación falsas, sin ningún cruce real.
function hayPuntoFueraDelRadio(puntos, lat, lon) {
  return puntos.some((p) => haversineMetros(p.lat, p.lon, lat, lon) > RADIO_GEOCERCA_M);
}

// Ventanas oficiales de banda punta CONFIRMADAS por pórtico (hora Chile, L-V,
// en minutos desde medianoche). `null` = tarifa plana / sin banda punta entre
// semana (confirmado con lectura real de 4.1: $311,52 = TBFP a las 07:14, hora
// en que la heurística genérica de abajo habría dicho erróneamente TBP).
// Pórticos no listados acá siguen usando la heurística genérica 07-09/18-21
// hasta que se confirme su ventana oficial real.
const VENTANAS_PUNTA_PORTICO = {
  '4.1': null,
  // Confirmado 2026-08-28: lectura real de 2.2 en pantalla fue $251,22 tanto
  // a la ida (07:24, dentro de la ventana genérica 07-09h que habría dado
  // erróneamente TBP/$502) como a la vuelta (15:17, fuera de ventana
  // genérica) — mismo monto TBFP en ambos casos, sin banda punta L-V.
  '2.2': null,
  // Confirmado 2026-08-31: lecturas reales de 1.1 ($532,59→$532) y 4.2
  // ($798,89→$798) a las 18:21 y 18:46 — ambas dentro de la ventana
  // genérica 18-21h (que habría dado erróneamente TBP) mostraron TBFP.
  '1.1': null,
  '4.2': null,
  PA19: null,
  PA21: null,
  PA23: [[7 * 60, 10 * 60]],
  PA25: [[7 * 60, 9 * 60 + 30], [14 * 60 + 30, 15 * 60], [19 * 60, 19 * 60 + 30]],
  // PA24/PA26 (sentido Norte-Sur, de vuelta) — ventana punta vespertina, no
  // matutina como su par PA23/PA25. Se aproxima la franja TS de PA24
  // (18:30-19:00) como parte de la ventana TBP por simplicidad (el sistema
  // solo modela 2 bandas, TBFP/TBP, no 3).
  PA24: [[18 * 60, 20 * 60 + 30]],
  PA26: [[18 * 60 + 30, 20 * 60 + 30]],
  PA20: null,
  PA22: null,
  // PA28 (ida): TBP 07:00-07:30/08:30-09:30/10:00-10:30/18:00-19:00, TS
  // 07:30-08:30 — ver VENTANAS_SATURACION_PORTICO abajo (ya no se aproxima
  // como parte de TBP, el sistema modela TS aparte desde 2026-09-02).
  PA28: [[7 * 60, 9 * 60 + 30], [10 * 60, 10 * 60 + 30], [18 * 60, 19 * 60]],
  // PA29 (vuelta): TBP 17:00-20:30, sin TS. Confirmado 2026-08-28: cruce real
  // a las 14:52 (fuera de esta ventana) mostró $512 (TBFP), como corresponde.
  PA29: [[17 * 60, 20 * 60 + 30]],
};

// Ventanas oficiales de SATURACIÓN (TS) confirmadas — hora Chile, L-V, en
// minutos desde medianoche. Agregado 2026-09-02: el sistema nunca había
// modelado esta tercera banda (solo TBFP/TBP), así que cualquier pasada
// real en horario de saturación salía mal estimada sin importar la
// tarifa cargada. Confirmado con lecturas reales del mismo día: 3.1
// ($997≈$997,86) y 3.3 ($780,80 exacto) a las 07:31-07:32, y PA28
// ($1.537 exacto) a las 08:00 — las 3 caen dentro de estas ventanas.
// PA31/PA13/PA24 son la misma fuente oficial (MOP 2026) sin cruce real
// todavía. Pórticos no listados acá nunca devuelven 'TS' — 2.2 en
// particular muestra "----" (sin ventana fija) en el tarifario oficial de
// Vespucio Sur pese a una lectura real de $753,87 en banda TS el mismo
// día — sugiere que ahí la saturación se activa por congestión real, no
// por horario fijo, y no se puede modelar con esta heurística.
const VENTANAS_SATURACION_PORTICO = {
  '3.1': [[7 * 60 + 30, 8 * 60 + 30]],
  '3.3': [[7 * 60 + 30, 8 * 60 + 30]],
  PA28: [[7 * 60 + 30, 8 * 60 + 30]],
  PA31: [[8 * 60 + 30, 9 * 60]],
  PA13: [[8 * 60 + 30, 9 * 60]],
  PA24: [[18 * 60 + 30, 19 * 60]],
};

// HEURÍSTICA de banda horaria: TS confirmada > TBP confirmada/genérica >
// TBFP. La ventana oficial del pórtico manda si existe; si no, cae de
// vuelta en la heurística genérica (no es la ventana exacta de las
// concesionarias que aún no hemos investigado).
function bandaHeuristica(fecha, porticoCodigo) {
  const dow = fecha.getDay();
  const h = fecha.getHours();
  const min = fecha.getMinutes();
  if (dow === 0 || dow === 6) return 'TBFP';
  const minutosDia = h * 60 + min;

  const ventanasTS = porticoCodigo ? VENTANAS_SATURACION_PORTICO[porticoCodigo] : null;
  if (ventanasTS && ventanasTS.some(([ini, fin]) => minutosDia >= ini && minutosDia < fin)) return 'TS';

  if (porticoCodigo && Object.prototype.hasOwnProperty.call(VENTANAS_PUNTA_PORTICO, porticoCodigo)) {
    const ventanas = VENTANAS_PUNTA_PORTICO[porticoCodigo];
    if (!ventanas) return 'TBFP';
    return ventanas.some(([ini, fin]) => minutosDia >= ini && minutosDia < fin) ? 'TBP' : 'TBFP';
  }

  if ((h >= 7 && h < 9) || (h >= 18 && h < 21)) return 'TBP';
  return 'TBFP';
}

// Extraído para poder armar el mismo texto tanto al confirmar una pasada al
// toque (mismo lote de puntos) como al confirmar una pasada que quedó
// pendiente de una corrida anterior (ver "Confirmación diferida" abajo).
function mensajePasada(patente, pasada) {
  const banda = bandaHeuristica(new Date(new Date(pasada.ts).getTime() - 4 * 3600 * 1000), pasada.portico_codigo);
  // Un código sin TARIFAS cargada (ej. AVO — cobra por distancia recorrida
  // entrada/salida, no por pórtico individual, no encaja en este modelo) no
  // debe tirar el sync entero — antes esto reventaba con "Cannot read
  // properties of undefined" apenas se confirmaba la primera pasada real de
  // un pórtico así, cortando la corrida completa (incluida la sección de
  // Santa Marta si el error ocurría antes... no es el caso acá porque
  // pórticos corre después, pero igual dejaba sin health-check ni checkpoint
  // final). Bug real encontrado 2026-09-01 al agregar AVO.
  const monto = TARIFAS[pasada.portico_codigo] ? TARIFAS[pasada.portico_codigo][banda] : null;
  const montoTxt = monto == null ? "no estimable (cobro por distancia recorrida)" : clp(monto);
  return (
    `🚗 <b>${patente}</b> — pasada por pórtico\n` +
    `📅 ${fmtFechaHoraChile(pasada.ts)}\n` +
    `🛣️ Pórtico: ${pasada.portico_codigo} (${pasada.concesionaria})\n` +
    `✅ Estado: OK\n` +
    `💰 Facturado: ${montoTxt}\n` +
    `💰 Correcto: ${montoTxt}`
  );
}

async function obtenerCheckpoint(key, lookbackMs) {
  const { data, error } = await supabase.from('SyncCheckpoints').select('value').eq('key', key).maybeSingle();
  if (error) throw new Error(`Error leyendo checkpoint ${key}: ${error.message}`);
  if (data?.value) return new Date(data.value);
  return new Date(Date.now() - lookbackMs);
}

async function guardarCheckpoint(key, fecha) {
  const { error } = await supabase.from('SyncCheckpoints').upsert({ key, value: fecha.toISOString() });
  if (error) throw new Error(`Error guardando checkpoint ${key}: ${error.message}`);
}

async function obtenerVehiculosPorticos() {
  const { data, error } = await supabase.from('porticos_vehiculos').select('id, patente, unit_id, imei, empresa');
  if (error) throw new Error(`Error leyendo vehiculos: ${error.message}`);
  return data || [];
}

// El alias del vehículo en Tracklink puede cambiar (ej. "DEMOGV58LAU" ->
// "ALMELENDEZ", mismo IMEI/patente) — se refleja solo en el portal de
// pórticos en vez de quedar pegado al valor que tenía al agregarlo.
async function sincronizarAliasVehiculos(vehiculosPorticos) {
  const imeis = vehiculosPorticos.map((v) => v.imei).filter(Boolean);
  if (!imeis.length) return;
  const { data: filasTracklink, error } = await supabase
    .from('Tracklink')
    .select('"IMEI", "Alias"')
    .in('IMEI', imeis);
  if (error) { console.log(`[alias] Error leyendo Tracklink: ${error.message}`); return; }
  const aliasPorImei = new Map((filasTracklink || []).map((f) => [f['IMEI'], f['Alias']]));

  for (const v of vehiculosPorticos) {
    const aliasNuevo = aliasPorImei.get(v.imei);
    if (aliasNuevo && aliasNuevo !== v.empresa) {
      const { error: errUpdate } = await supabase
        .from('porticos_vehiculos')
        .update({ empresa: aliasNuevo })
        .eq('id', v.id);
      if (errUpdate) console.log(`[alias] Error actualizando ${v.patente}: ${errUpdate.message}`);
      else console.log(`[alias] ${v.patente}: "${v.empresa}" → "${aliasNuevo}"`);
    }
  }
}

async function loginYConsultarTravel({ TL_USER, TL_PASSWORD, TL_DOMAIN, startDate, endDate, unitIds }) {
  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 90_000;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      const loginUrl = `https://${TL_DOMAIN}.trackgts.com/admin/login.html`;
      console.log(`[login] Intento ${attempt}/${MAX_ATTEMPTS} — ${loginUrl}`);
      await page.goto(loginUrl, { waitUntil: 'networkidle0', timeout: 60_000 });
      await page.waitForSelector('#username', { timeout: 30_000 });

      await page.evaluate(() => localStorage.setItem('sltLanguage', '0'));
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForSelector('#username', { timeout: 30_000 });

      await page.evaluate((user, password, domain) => {
        const K = 'd5fg4df5sg4ds5fg';
        const S = { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6', g: '7', h: '8', i: '9' };
        const k = CryptoJS.enc.Utf8.parse(K);
        const iv = CryptoJS.enc.Utf8.parse(K);
        const a = [];
        for (const c of password) {
          a.push(
            CryptoJS.AES.encrypt(
              CryptoJS.enc.Utf8.parse(S[c] || c), k,
              { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
            ).toString()
          );
        }
        ARRAYPSWD = a;
        document.getElementById('username').value = user;
        document.getElementById('domain').value = domain;
        document.getElementById('password').value = '********';
        LOGININPROCESS = false;
        onLoginOn();
      }, TL_USER, TL_PASSWORD, TL_DOMAIN);

      console.log('[login] Esperando sesión (15s)...');
      await new Promise((r) => setTimeout(r, 15_000));

      console.log(`[travel] Consultando reportTravel: ${startDate} → ${endDate}`);
      const result = await page.evaluate(async (startStr, endStr, unitIdsStr) => {
        const h = JSONUSER.hash;
        const res = await fetch(`https://www.trackgts.com:82/api/reportTravel/${h}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json;charset=utf-8' },
          body: JSON.stringify([{ startDate: startStr, endDate: endStr, unitIds: unitIdsStr }]),
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch (e) {
          return { error: `Respuesta no-JSON: ${text.slice(0, 300)}` };
        }
        if (typeof json === 'string') {
          try { json = JSON.parse(json); } catch (e) {
            return { error: `Doble-parse falló: ${text.slice(0, 300)}` };
          }
        }
        if (json && json.idResult !== undefined) {
          return { error: `idResult=${json.idResult} (sesión inválida)` };
        }
        if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[1])) {
          return { error: `Forma inesperada: ${JSON.stringify(json).slice(0, 300)}` };
        }
        return { rows: json[1] };
      }, startDate, endDate, unitIds);

      if (result.error) throw new Error(result.error);
      return result.rows || [];
    } catch (err) {
      lastError = err;
      console.log(`[!] Intento ${attempt}/${MAX_ATTEMPTS} falló: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`[!] Esperando ${Math.round(RETRY_DELAY_MS / 1000)}s antes de reintentar...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    } finally {
      await browser.close();
    }
  }
  throw lastError;
}

async function sincronizarHealthCheck(TL_USER, TL_PASSWORD, TL_DOMAIN, customer, tabla) {
  const BASE_URL = `https://${TL_DOMAIN}.trackgts.com:8081`;
  const authRes = await fetch(`${BASE_URL}/api/Authenticate/Auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: TL_USER, password: TL_PASSWORD, customer }),
  });
  if (authRes.status === 429) {
    console.log(`[healthcheck:${tabla}] ⚠️ Rate limit al autenticar.`);
    return;
  }
  if (!authRes.ok) {
    console.log(`[healthcheck:${tabla}] ❌ Error de autenticación: HTTP ${authRes.status}`);
    return;
  }
  const authData = await authRes.json();
  const accessToken = authData.data?.accessToken;
  const retailId = authData.data?.user?.parentCustomerId?.toString();
  if (!accessToken || !retailId) {
    console.log(`[healthcheck:${tabla}] ❌ No se obtuvo token o retailId.`);
    return;
  }

  const reportRes = await fetch(`${BASE_URL}/api/HealthCheck/GetReportHealthCheck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ retailId }),
  });
  if (reportRes.status === 429) {
    console.log(`[healthcheck:${tabla}] ⚠️ Rate limit al obtener reporte.`);
    return;
  }
  if (!reportRes.ok) {
    console.log(`[healthcheck:${tabla}] ❌ Error al obtener reporte: HTTP ${reportRes.status}`);
    return;
  }
  const reportData = await reportRes.json();
  const unidades = reportData.data ?? [];
  if (!unidades.length) {
    console.log(`[healthcheck:${tabla}] ❌ La API no devolvió unidades.`);
    return;
  }

  const registros = unidades.map((u) => ({
    'IMEI':                 u.imei,
    'Unit ID':              u.unitId,
    'Serie':                u.serie,
    'Fecha Ultimo Reporte': u.fechaUltimoReporte,
    'Ubicación':            u.ubicacion,
    'Antigüedad (minutos)': u.antiguedadMinutos,
    'Mensaje':              u.mensaje,
    'EstadoGPS':            u.estadoGPS,
    'EstadoIgnición':       u.estadoIgnicion,
    'EstadoMotor':          u.estadoMotor,
    'Velocidad':            String(u.velocidad ?? ''),
    'Odómetro':             String(u.odometro ?? ''),
    'Horómetro':            u.horometro ?? null,
    'VBatExterna':          String(u.vBatExterna ?? ''),
    '%BatExterna':          u.porcentBatInterna,
    'Fabricante AVL':       u.fabricanteAVL,
    'Modelo AVL':           u.modeloAVL,
    'Modelo AVL Ref':       u.modeloAVLRef,
    'Protocolo':            u.protocolo,
    'Teléfono SIM':         u.telefonoSim,
    'Serie SIM':            u.serieSim,
    'GPRS':                 u.gprs,
    'Servicio':             u.servicio,
    'Servicio Comercial':   u.servicioComercial,
    'Serv. Desde':          u.servDesde,
    'Serv. Hasta':          u.servHasta,
    'TipoInstalacion':      u.tipoInstalacion,
    'Alias':                u.alias,
    'Tipo':                 u.tipo,
    'Marca':                u.marca,
    'Modelo':               u.modelo,
    'Año':                  u.anio,
    'Placa':                u.placa,
    'Color':                u.color,
    'Chasis':               u.chasis,
    'Motor':                u.motor,
    'Cliente/Empresa':      u.clienteEmpresa,
    'Cust ID':              u.custId,
    'Nombre':               u.nombre,
    'Apellido':             u.apellido,
    'Direccion':            u.direccion,
    'Pais':                 u.pais,
    'Correo':               u.correo,
    'Usuario':              u.usuario,
    'Telefono':             u.telefono,
    'ClienteAdicional1':    u.clienteAdicional1 ?? '',
    'ClienteAdicional2':    u.clienteAdicional2 ?? '',
    'ClienteAdicional3':    u.clienteAdicional3 ?? '',
    'ClienteAdicional4':    u.clienteAdicional4 ?? '',
  }));

  const { error } = await supabase.from(tabla).upsert(registros, { onConflict: 'IMEI' });
  if (error) {
    console.log(`[healthcheck:${tabla}] ❌ Error al guardar: ${error.message}`);
    return;
  }
  console.log(`[healthcheck:${tabla}] ✅ ${unidades.length} unidades sincronizadas.`);
}

// Empareja los montos ingresados a mano desde el celular (registrar.html,
// tracklink-porticos-portal) contra las pasadas reales detectadas — mismo
// criterio que se venía usando a mano en el chat: la pasada CONFIRMADA más
// cercana en el tiempo, del mismo vehículo, todavía sin monto_real. Corre
// en cada sync (cada 30 min) y también reintenta lecturas de corridas
// anteriores que en su momento no encontraron pasada (porque la pasada
// real recién se confirma más tarde) — por eso la ventana de búsqueda de
// lecturas pendientes es de 24h, igual que VENTANA_ESTACIONADO_MS.
const VENTANA_EMPAREJAR_LECTURA_MS = 20 * 60 * 1000; // ±20 min entre el ingreso a mano y la pasada real

async function emparejarLecturasManuales(vehiculosPorticos) {
  for (const vehiculo of vehiculosPorticos) {
    const { data: pendientes, error: errPendientes } = await supabase
      .from('porticos_lecturas_manuales')
      .select('id, monto, ts_ingreso')
      .eq('vehiculo_id', vehiculo.id)
      .is('pasada_id', null)
      .gte('ts_ingreso', new Date(Date.now() - VENTANA_ESTACIONADO_MS).toISOString());
    if (errPendientes) { console.log(`[lecturas] Error leyendo pendientes de ${vehiculo.patente}: ${errPendientes.message}`); continue; }
    if (!pendientes || !pendientes.length) continue;

    for (const lectura of pendientes) {
      const tsIngresoMs = new Date(lectura.ts_ingreso).getTime();
      const { data: candidatas, error: errCandidatas } = await supabase
        .from('porticos_pasadas_reales')
        .select('id, ts')
        .eq('vehiculo_id', vehiculo.id)
        .eq('confirmado', true)
        .is('monto_real', null)
        .gte('ts', new Date(tsIngresoMs - VENTANA_EMPAREJAR_LECTURA_MS).toISOString())
        .lte('ts', new Date(tsIngresoMs + VENTANA_EMPAREJAR_LECTURA_MS).toISOString());
      if (errCandidatas) { console.log(`[lecturas] Error buscando pasada para lectura ${lectura.id}: ${errCandidatas.message}`); continue; }
      if (!candidatas || !candidatas.length) continue;

      let mejor = candidatas[0];
      let mejorDiff = Math.abs(new Date(mejor.ts).getTime() - tsIngresoMs);
      for (const c of candidatas.slice(1)) {
        const diff = Math.abs(new Date(c.ts).getTime() - tsIngresoMs);
        if (diff < mejorDiff) { mejor = c; mejorDiff = diff; }
      }

      const { error: errUpdatePasada } = await supabase
        .from('porticos_pasadas_reales')
        .update({ monto_real: lectura.monto })
        .eq('id', mejor.id);
      if (errUpdatePasada) { console.log(`[lecturas] Error guardando monto_real en pasada ${mejor.id}: ${errUpdatePasada.message}`); continue; }

      const { error: errUpdateLectura } = await supabase
        .from('porticos_lecturas_manuales')
        .update({ pasada_id: mejor.id, emparejado_en: new Date().toISOString() })
        .eq('id', lectura.id);
      if (errUpdateLectura) console.log(`[lecturas] Error marcando lectura ${lectura.id} como emparejada: ${errUpdateLectura.message}`);
      else console.log(`[lecturas] ✅ ${vehiculo.patente}: $${lectura.monto} emparejado con pasada ${mejor.id} (Δ${Math.round(mejorDiff / 1000)}s)`);
    }
  }
}

// Km recorridos por día = odómetro del último punto GPS del día menos el
// del primero (el odómetro del vehículo es monotónico creciente en el
// tiempo, así que "primer punto" = mínimo y "último punto" = máximo, no
// hace falta comparar valores). Cada corrida solo trae los puntos nuevos
// desde el último checkpoint, así que el inicio/fin de un día se va
// extendiendo de a poco en cada corrida — por eso se compara contra lo que
// ya había guardado (si existe) en vez de sobreescribir directo.
async function actualizarOdometroDiario(vehiculosPorticos, puntosPorVehiculo) {
  for (const vehiculo of vehiculosPorticos) {
    const puntos = (puntosPorVehiculo.get(vehiculo.id) || [])
      .filter((p) => p.odometro != null && !isNaN(p.time))
      .sort((a, b) => a.time - b.time);
    if (!puntos.length) continue;

    const porDia = new Map();
    for (const p of puntos) {
      const dia = diaChile(p.time);
      const actual = porDia.get(dia);
      if (!actual) {
        porDia.set(dia, { odometro_inicio: p.odometro, ts_inicio: p.time, odometro_fin: p.odometro, ts_fin: p.time });
      } else {
        if (p.time < actual.ts_inicio) { actual.odometro_inicio = p.odometro; actual.ts_inicio = p.time; }
        if (p.time > actual.ts_fin) { actual.odometro_fin = p.odometro; actual.ts_fin = p.time; }
      }
    }

    for (const [dia, tramo] of porDia) {
      const { data: existente, error: errExistente } = await supabase
        .from('porticos_odometro_diario')
        .select('odometro_inicio, ts_inicio, odometro_fin, ts_fin')
        .eq('vehiculo_id', vehiculo.id)
        .eq('dia', dia)
        .maybeSingle();
      if (errExistente) { console.log(`[odometro] Error leyendo ${vehiculo.patente} ${dia}: ${errExistente.message}`); continue; }

      let odometro_inicio = tramo.odometro_inicio, ts_inicio = tramo.ts_inicio;
      let odometro_fin = tramo.odometro_fin, ts_fin = tramo.ts_fin;
      if (existente) {
        if (new Date(existente.ts_inicio) < ts_inicio) { odometro_inicio = existente.odometro_inicio; ts_inicio = new Date(existente.ts_inicio); }
        if (new Date(existente.ts_fin) > ts_fin) { odometro_fin = existente.odometro_fin; ts_fin = new Date(existente.ts_fin); }
      }

      const { error: errUpsert } = await supabase
        .from('porticos_odometro_diario')
        .upsert({
          vehiculo_id: vehiculo.id, dia,
          odometro_inicio, ts_inicio: ts_inicio.toISOString(),
          odometro_fin, ts_fin: ts_fin.toISOString(),
          actualizado_en: new Date().toISOString(),
        }, { onConflict: 'vehiculo_id,dia' });
      if (errUpsert) console.log(`[odometro] Error guardando ${vehiculo.patente} ${dia}: ${errUpsert.message}`);
    }
  }
}

async function main() {
  const { TL_USER, TL_PASSWORD, TL_DOMAIN } = process.env;
  if (!TL_USER || !TL_PASSWORD || !TL_DOMAIN) throw new Error('Faltan TL_USER, TL_PASSWORD o TL_DOMAIN');

  const tlchileDisponible = await intentarReservarTlchile();
  if (!tlchileDisponible) {
    console.log('⏭️  Omitido: la cuenta tlchile fue usada hace menos de 20 min (candado activo).');
    return;
  }

  // --- 1) Una sola sesión clásica: Santa Marta + Pórticos juntos -----------
  const vehiculosPorticos = await obtenerVehiculosPorticos();
  const santamartaCheckpoint = await obtenerCheckpoint(SANTAMARTA_CHECKPOINT_KEY, 2 * 60 * 60_000);
  const porticosCheckpoint = await obtenerCheckpoint(PORTICOS_CHECKPOINT_KEY, 2 * 60 * 60_000);
  const OVERLAP_MS = 5 * 60_000;
  const ahora = new Date();
  const startMs = Math.min(santamartaCheckpoint.getTime(), porticosCheckpoint.getTime()) - OVERLAP_MS;
  const start = new Date(startMs);

  const unitIds = [
    ...UNIDADES_SANTAMARTA.map((u) => u.unitId),
    ...vehiculosPorticos.map((v) => v.unit_id),
  ].join(',');

  console.log(`=== Sync tlchile: ${fmtTL(start)} → ${fmtTL(ahora)} (${UNIDADES_SANTAMARTA.length} Santa Marta + ${vehiculosPorticos.length} pórticos) ===`);

  const rows = await loginYConsultarTravel({
    TL_USER, TL_PASSWORD, TL_DOMAIN,
    startDate: fmtTL(start), endDate: fmtTL(ahora),
    unitIds,
  });
  console.log(`[travel] ${rows.length} posiciones GPS recibidas (todas las unidades)`);

  // --- Santa Marta -----------------------------------------------------------
  const porUnitIdSantaMarta = new Map(UNIDADES_SANTAMARTA.map((u) => [u.unitId, u]));
  const registrosSantaMarta = rows
    .filter((r) => porUnitIdSantaMarta.has(r.unitIdA0))
    .map((r) => {
      const u = porUnitIdSantaMarta.get(r.unitIdA0);
      return {
        'IMEI': u.imei,
        'Unit ID': r.unitIdA0,
        'Alias': u.alias,
        'gpsUtcTime': r.gpsUtcTimeC13,
        'Odómetro': r.odometerC14 ?? null,
        'Horómetro': r.hourmeterC15 ?? null,
        'Velocidad': r.speedC8 ?? null,
        'Latitud': r.latC12 ?? null,
        'Longitud': r.lonC11 ?? null,
      };
    });
  console.log(`[santamarta] ${registrosSantaMarta.length} filas válidas`);
  if (registrosSantaMarta.length) {
    const registrosSantaMartaSinDuplicar = dedupePorClave(registrosSantaMarta, (r) => `${r['IMEI']}|${r['gpsUtcTime']}`);
    const { error } = await supabase
      .from('SantaMartaHistorial')
      // ignoreDuplicates:false (default) = ON CONFLICT DO UPDATE: si una fila ya
      // existía con algún campo vacío (por una corrida anterior incompleta o con
      // código viejo), esta corrida la corrige sola en vez de dejarla pegada.
      .upsert(registrosSantaMartaSinDuplicar, { onConflict: 'IMEI,gpsUtcTime' });
    if (error) throw new Error(`Error al guardar historial Santa Marta: ${error.message}`);
    console.log(`[santamarta] ✅ ${registrosSantaMartaSinDuplicar.length} registros insertados/verificados.`);
  }
  await guardarCheckpoint(SANTAMARTA_CHECKPOINT_KEY, ahora);

  // --- Pórticos --------------------------------------------------------------
  const porUnitIdPorticos = new Map(vehiculosPorticos.map((v) => [v.unit_id, v]));
  const puntosPorVehiculo = new Map();
  for (const r of rows) {
    const vehiculo = porUnitIdPorticos.get(r.unitIdA0);
    if (!vehiculo) continue;
    if (!puntosPorVehiculo.has(vehiculo.id)) puntosPorVehiculo.set(vehiculo.id, []);
    puntosPorVehiculo.get(vehiculo.id).push({
      time: new Date(r.gpsUtcTimeC13.replace(' ', 'T') + 'Z'),
      lat: r.latC12, lon: r.lonC11, speed: r.speedC8 || 0, odometro: r.odometerC14,
    });
  }

  // Si el vehículo queda estacionado/detenido cerca de un pórtico (ej. su
  // destino final queda al lado), cada corrida futura volvía a "detectar"
  // el mismo pórtico una y otra vez (el dedup de MIN_GAP_MS solo mira dentro
  // de la corrida actual, no recuerda corridas anteriores) — generaba
  // pasadas y notificaciones de Telegram falsas mientras el auto seguía
  // parado ahí. Por eso antes de detectar se consulta cuándo fue la ÚLTIMA
  // pasada real ya guardada de cada vehículo+pórtico, y no se vuelve a
  // contar si pasaron menos de VENTANA_MISMA_PASADA_MS desde esa última vez.
  const VENTANA_MISMA_PASADA_MS = 3 * 60 * 60 * 1000; // 3 horas

  let totalDetecciones = 0;
  for (const vehiculo of vehiculosPorticos) {
    const puntos = (puntosPorVehiculo.get(vehiculo.id) || [])
      .filter((p) => p.lat && p.lon && !isNaN(p.time))
      .sort((a, b) => a.time - b.time);
    console.log(`[porticos] ${vehiculo.patente}: ${puntos.length} puntos GPS válidos`);

    // OJO: el lookback de esta consulta tiene que ser al MENOS tan largo como
    // la ventana más larga que se usa más abajo (VENTANA_ESTACIONADO_MS, 20h),
    // no VENTANA_MISMA_PASADA_MS (3h) — si se corre un sync más de 3h después
    // de la última pasada real de un pórtico y el auto sigue estacionado ahí,
    // esta consulta "olvidaba" la pasada anterior (quedaba fuera del rango) y
    // el punto estacionado se trataba como detección nueva ("primera vez",
    // que siempre pasa sin importar la velocidad) — generaba una pasada y una
    // notificación de Telegram falsas. Bug real confirmado 2026-08-31: VVJG-14
    // quedó estacionado junto a P11 (cerca de la oficina) desde las 08:22, y
    // un sync a las 11:24 (3h02m después) volvió a "detectarlo" como pasada
    // nueva porque la pasada real de las 08:22 ya había quedado fuera de la
    // ventana de 3h de esta consulta.
    const { data: pasadasPrevias, error: errPrevias } = await supabase
      .from('porticos_pasadas_reales')
      .select('portico_codigo, ts')
      .eq('vehiculo_id', vehiculo.id)
      .gte('ts', new Date(Date.now() - VENTANA_ESTACIONADO_MS).toISOString());
    if (errPrevias) throw new Error(`Error leyendo pasadas previas de ${vehiculo.patente}: ${errPrevias.message}`);
    const ultimaPasadaPorPortico = new Map();
    for (const row of pasadasPrevias || []) {
      const t = new Date(row.ts).getTime();
      const actual = ultimaPasadaPorPortico.get(row.portico_codigo);
      if (!actual || t > actual) ultimaPasadaPorPortico.set(row.portico_codigo, t);
    }

    // Confirmación diferida: una pasada que quedó "confirmado=false" en una
    // corrida anterior (porque en ese momento no había ningún punto GPS
    // posterior fuera del radio todavía) se reintenta acá contra los puntos
    // NUEVOS de esta corrida. Si esos puntos nuevos muestran que el vehículo
    // ya salió del radio, recién ahora se confirma y se notifica por
    // Telegram (con la fecha/hora ORIGINAL del cruce, no la de esta
    // corrida). Si el vehículo lleva más de VENTANA_ESTACIONADO_MS sin
    // confirmarse, se abandona en silencio — fue un estacionamiento dentro
    // del radio de un pórtico real, nunca un tránsito.
    if (puntos.length) {
      const { data: pendientes, error: errPendientes } = await supabase
        .from('porticos_pasadas_reales')
        .select('*')
        .eq('vehiculo_id', vehiculo.id)
        .eq('confirmado', false)
        .gte('ts', new Date(Date.now() - VENTANA_ESTACIONADO_MS).toISOString());
      if (errPendientes) throw new Error(`Error leyendo pasadas pendientes de ${vehiculo.patente}: ${errPendientes.message}`);
      for (const pendiente of pendientes || []) {
        if (!hayPuntoFueraDelRadio(puntos, pendiente.lat, pendiente.lon)) continue;
        const { error: errConfirmar } = await supabase
          .from('porticos_pasadas_reales')
          .update({ confirmado: true })
          .eq('id', pendiente.id);
        if (errConfirmar) { console.log(`[porticos] Error confirmando pasada pendiente de ${vehiculo.patente}: ${errConfirmar.message}`); continue; }
        console.log(`[porticos] ✅ ${vehiculo.patente}: pasada pendiente de ${pendiente.portico_codigo} (${fmtTL(new Date(pendiente.ts))}) confirmada esta corrida.`);
        if (PATENTES_NOTIFICAR_TELEGRAM.includes(vehiculo.patente)) {
          await notificarTelegram(mensajePasada(vehiculo.patente, pendiente));
        }
      }
    }

    const detecciones = [];
    let ultimoPortico = null;
    let ultimoTs = null;
    for (let i = 0; i < puntos.length; i++) {
      const p = puntos[i];
      const anterior = puntos[i - 1];
      for (const portico of PORTICOS) {
        const d = anterior
          ? distanciaPuntoASegmentoMetros(portico.lat, portico.lon, anterior.lat, anterior.lon, p.lat, p.lon)
          : haversineMetros(p.lat, p.lon, portico.lat, portico.lon);
        if (d <= RADIO_GEOCERCA_M) {
          const tsMs = p.time.getTime();
          const resuelto = resolverCodigoDireccional(portico, anterior, p);
          const esNuevoEnEstaCorrida = resuelto.codigo !== ultimoPortico || !ultimoTs || tsMs - ultimoTs > MIN_GAP_MS;
          const ultimaConocida = ultimaPasadaPorPortico.get(resuelto.codigo);
          // Ventana de "misma pasada" extendida si el punto actual sugiere
          // vehículo estacionado (velocidad baja) — evita recontar como
          // tránsito nuevo a un vehículo que simplemente sigue parqueado
          // cerca del pórtico horas después. La primera detección de un
          // código (ultimaConocida indefinida) siempre pasa, sin importar la
          // velocidad — así no se pierde un tránsito real a baja velocidad
          // por congestión (ver nota de 3.3 más arriba).
          const ventanaAplicable = p.speed < VELOCIDAD_MINIMA_TRANSITO_KMH ? VENTANA_ESTACIONADO_MS : VENTANA_MISMA_PASADA_MS;
          const esNuevoVsHistorico = !ultimaConocida || tsMs - ultimaConocida > ventanaAplicable;
          const esFalsoPositivoConocido = FALSOS_POSITIVOS_CONOCIDOS.has(`${vehiculo.patente}|${resuelto.codigo}`);
          if (esNuevoEnEstaCorrida && esNuevoVsHistorico && !esFalsoPositivoConocido) {
            // confirmado: ¿hay ya, en esta misma corrida, algún punto GPS
            // posterior que muestre al vehículo fuera del radio? Un tránsito
            // real en autopista lo confirma casi al toque (siguiente lectura,
            // 30-60s después); si no, queda pendiente y se reintenta en la
            // próxima corrida contra los puntos nuevos (ver "Confirmación
            // diferida" más arriba) — nunca se notifica hasta confirmarse.
            detecciones.push({
              vehiculo_id: vehiculo.id,
              ts: p.time.toISOString(),
              portico_codigo: resuelto.codigo,
              concesionaria: portico.concesionaria,
              tramo: resuelto.tramo,
              distancia_m: Math.round(d),
              velocidad_kmh: p.speed,
              lat: p.lat,
              lon: p.lon,
              confirmado: hayPuntoFueraDelRadio(puntos.slice(i + 1), p.lat, p.lon),
            });
            ultimaPasadaPorPortico.set(resuelto.codigo, tsMs);
          }
          ultimoPortico = resuelto.codigo;
          ultimoTs = tsMs;
        }
      }
    }
    // Dedupe defensivo por si el mismo punto GPS (mismo ts) aparece dos veces
    // en la respuesta de reportTravel — evita el mismo error de Postgres que
    // rompía Santa Marta, y de paso evita notificar dos veces por Telegram.
    const deteccionesSinDuplicar = dedupePorClave(detecciones, (d) => `${d.vehiculo_id}|${d.ts}|${d.portico_codigo}`);
    console.log(`[porticos] ${vehiculo.patente}: ${deteccionesSinDuplicar.length} pasadas nuevas detectadas`);
    totalDetecciones += deteccionesSinDuplicar.length;

    if (deteccionesSinDuplicar.length) {
      const { error } = await supabase
        .from('porticos_pasadas_reales')
        // ignoreDuplicates:false (default) = ON CONFLICT DO UPDATE: si esta misma
        // pasada ya estaba guardada (por el solape de 5 min entre corridas, o por
        // haberse insertado con una versión anterior del código) pero le faltaba
        // lat/lon u otro campo, esta corrida la completa sola — sin depender de
        // un rescate manual ni de un login extra a TrackGTS.
        .upsert(deteccionesSinDuplicar, { onConflict: 'vehiculo_id,ts,portico_codigo' });
      if (error) throw new Error(`Error guardando pasadas de ${vehiculo.patente}: ${error.message}`);
      console.log(`[porticos] ✅ ${vehiculo.patente}: ${deteccionesSinDuplicar.length} pasadas insertadas/verificadas`);

      if (!PATENTES_NOTIFICAR_TELEGRAM.includes(vehiculo.patente)) continue;
      // Solo se notifica lo YA confirmado en esta misma corrida (el vehículo
      // ya mostró un punto posterior fuera del radio). Lo que quedó
      // confirmado:false se notifica más adelante, cuando la "Confirmación
      // diferida" de una corrida futura lo confirme — o nunca, si resulta
      // ser un vehículo estacionado dentro del radio y no un tránsito real.
      for (const d of deteccionesSinDuplicar.filter((d) => d.confirmado)) {
        await notificarTelegram(mensajePasada(vehiculo.patente, d));
      }
    }
  }
  if (!totalDetecciones) console.log('[porticos] Sin pasadas nuevas en el rango consultado.');
  await emparejarLecturasManuales(vehiculosPorticos);
  await actualizarOdometroDiario(vehiculosPorticos, puntosPorVehiculo);
  await guardarCheckpoint(PORTICOS_CHECKPOINT_KEY, ahora);

  // --- 2) HealthCheck (API REST) — Tracklink / MZDConnect ---------------------
  // TrackGTS rate-limitó el segundo Authenticate/Auth (mconnect) incluso
  // llamado segundos después del primero (tlchile) dentro de esta MISMA
  // corrida (visto en vivo 2026-08-27) — el límite no es solo "entre
  // procesos", también pega entre llamadas seguidas de la misma corrida.
  // Por eso van con una pausa entre medio en vez de una tras otra.
  const HEALTHCHECK_GAP_MS = 60_000;
  for (let i = 0; i < HEALTHCHECK_CUSTOMERS.length; i++) {
    const { customer, tabla } = HEALTHCHECK_CUSTOMERS[i];
    if (i > 0) {
      console.log(`[healthcheck] Esperando ${HEALTHCHECK_GAP_MS / 1000}s antes de autenticar "${customer}"...`);
      await new Promise((r) => setTimeout(r, HEALTHCHECK_GAP_MS));
    }
    await sincronizarHealthCheck(TL_USER, TL_PASSWORD, TL_DOMAIN, customer, tabla);
  }

  await sincronizarAliasVehiculos(vehiculosPorticos);

  await guardarCheckpoint(TLCHILE_LAST_SUCCESS_KEY, ahora);
  console.log(`=== Sync tlchile completo: ${ahora.toISOString()} ===`);
}

main().catch((err) => {
  console.error('ERROR FATAL:', err.message);
  process.exit(1);
});
