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
const { haversineMetros, puntoMasCercanoEnSegmento } = require('./geo-utils');
const { distanciaCalzada, distanciasPorClase } = require('./map-matching');

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
// Notificaciones desactivadas a pedido (2026-09-09) — se reactivan agregando
// de vuelta la patente acá, sin tocar el resto del código de notificación.
const PATENTES_NOTIFICAR_TELEGRAM = [];
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
// P5CN agregado 2026-09-11: cruce real de PA16 (Autopista Central, ancla
// empírica 13m/2 confirmaciones) detectado también en P5CN (Costanera
// Norte, ancla empírica más débil 89m/1 confirmación) 48s después — mismo
// nudo de Puente Manuel Rodríguez donde ambos corredores corren muy cerca.
// Confirmado por el usuario contra su propio recorrido real (no tomó
// Costanera Norte ese tramo).
//
// NO reemplazar esto por un umbral de distancia a la calzada (capa 2 de
// map-matching, ver esCandidatoValidoPorCalzada en map-matching.js) sin
// antes revisar porticos_comparacion_metodos: se intentó 2026-09-15 y los
// datos reales lo descartan — el ruido GPS de VVJG-14 estacionado junto a
// P11 produce distancia_calzada_m de apenas 2-9m (prácticamente idéntico a
// un cruce real confirmado de otro vehículo por ese mismo pórtico, 1-7m),
// mientras que cruces reales confirmados en OTROS pórticos (PA18, P3,
// P101, PA16, PA21) llegan a 44-112m por imprecisión del mapeo OSM del
// corredor. Un umbral de calzada no habría filtrado el falso positivo de
// P11 y sí habría arriesgado ocultar cruces reales en otros pórticos. Ver
// [[project_agp_tracklink_integration]] en memoria para el detalle completo.
const FALSOS_POSITIVOS_CONOCIDOS = new Set(['VVJG-14|P11', 'VVJG-14|PA17', 'VVJG-14|P5CN']);
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

// Filtro de velocidad MÍNIMA por pórtico puntual — no confundir con
// VELOCIDAD_MINIMA_TRANSITO_KMH de arriba (ese es global y a propósito NO
// filtra por velocidad baja, porque 3.3 tuvo un tránsito real a 0 km/h por
// congestión). Este es lo opuesto: para P10 (Vespucio Norte) se investigó
// 2026-09-02 con capturas satelitales del usuario por qué se seguía
// detectando aunque nunca entra a esa autopista — la coordenada de P10 es
// correcta y el radio de 150m no está sobredimensionado (su estacionamiento
// frente a El Cortijo queda genuinamente a ~110-124m, igual que en
// cualquier otro pórtico), pero el camino de acceso/frontis real hacia El
// Cortijo pasa DENTRO de ese radio. La señal que sí los distingue: los
// cruces reales confirmados el mismo día en ese tramo de Vespucio Norte
// (P9/P8/P7/P6) van a 70-100 km/h, mientras las detecciones de P10 junto al
// acceso repiten 0-33 km/h. Por eso el filtro va SOLO en P10 (no global,
// no excluye el código — si el usuario cruza P10 de verdad en la autopista
// algún día, va a ir a esa velocidad y se sigue detectando igual).
const VELOCIDAD_MINIMA_PORTICO = { P10: 40 };

// Techo de velocidad IMPLÍCITA entre dos puntos GPS consecutivos del mismo
// vehículo (distancia/tiempo) — no la velocidad que reporta el punto (esa
// la mide el dispositivo directo, esto es un cálculo propio). 180 km/h es
// muy por sobre el límite real de cualquier autopista chilena (~120 km/h),
// da margen a imprecisión GPS normal, y solo descarta lecturas que
// impliquen un salto físicamente imposible entre dos lecturas.
const VELOCIDAD_MAX_PLAUSIBLE_KMH = 180;

// Copia de emergencia — usada SOLO si cargarCatalogoPorticos() no puede leer
// la tabla porticos_catalogo de Supabase (fuente real desde 2026-09-11, ver
// [[project_agp_tracklink_integration]] en memoria). No hace falta mantener
// esto sincronizado a mano nunca más: para agregar/corregir un pórtico edita
// la tabla, no este archivo. Ver cargarCatalogoPorticos() más abajo.
const PORTICOS_FALLBACK = [
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
  // P14 quitado como entrada física 2026-09-30 -- es el alterno de P15
  // (mismo nudo, sentido contrario, ver PARES_DIRECCIONALES). Mismo bug
  // real que P10/P11, confirmado con track GPS de VVJG-14.
  // P12 quitado como entrada física 2026-09-30 -- es el alterno de P13
  // (mismo nudo, sentido contrario, ver PARES_DIRECCIONALES).
  // P10 quitado como entrada física 2026-09-22 -- es el alterno de P11
  // (mismo nudo, sentido contrario, ver PARES_DIRECCIONALES). Bug real
  // confirmado con track GPS: P10/P11 disparaban juntos en cada cruce.
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
  // Corregido 2026-10-13: la distancia acumulada dejaba cada código ~un
  // gantry corrido (PA19 caía sobre PA21/22, PA21 sobre PA23/24, PA23 sobre
  // PA25/26). Confirmado con el cruce de AGP (TTXR82 8/9/13-oct: la
  // concesionaria cobraba PA21 donde detectábamos PA19, PA26 donde
  // detectábamos PA24, etc.) y coordenadas OSM (ref+nombre oficial).
  // PA19/PA20 NO comparten gantry (1,5km): cada uno con geocerca propia y
  // SENTIDO_UNICO.
  { codigo: 'PA19', concesionaria: 'Autopista Central', tramo: 'Ruta 5 Sur – Américo Vespucio',               lat: -33.551404, lon: -70.709061 },
  { codigo: 'PA20', concesionaria: 'Autopista Central', tramo: 'Américo Vespucio – Ruta 5 Sur',               lat: -33.536473, lon: -70.707659 },
  { codigo: 'PA21', concesionaria: 'Autopista Central', tramo: 'Américo Vespucio – Carlos Valdovinos',        lat: -33.506426, lon: -70.697251 },
  { codigo: 'PA23', concesionaria: 'Autopista Central', tramo: 'Carlos Valdovinos – Alameda',                 lat: -33.469061, lon: -70.688127 },
  { codigo: 'PA25', concesionaria: 'Autopista Central', tramo: 'Alameda – Río Mapocho',                       lat: -33.446740, lon: -70.692080 },
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
  { codigo: 'PA28', concesionaria: 'Autopista Central', tramo: 'Río Mapocho – Ruta 5 Norte',                   lat: -33.382239, lon: -70.695562 },
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
  // PA5/PA6/PA7/PA32/PA37: extremo sur del Eje Norte-Sur (San Bernardo),
  // agregado 2026-09-02. Coordenadas del usuario (Google Places) cruzadas
  // contra tramo+km real de Smart Report (cuenta kcerda) para confirmar
  // identidad — el archivo original traía PA4↔PA37 y PA6↔PA37 con las
  // coordenadas cruzadas entre sí (mismo texto de tramo apuntaba a otro
  // código), corregido acá.
  // PA1/PA2/PA3/PA4: extensión sur (La Capilla/Los Guindos/Calera de Tango,
  // camino a Buin/Paine) agregada 2026-10-13 a partir del cruce real de AGP
  // (correo Sergio Hidalgo) — faltaban por completo, confirmado con
  // coordenadas OSM reales. PA3/PA4 son el mismo gantry físico (90m de
  // separación) en sentidos opuestos: PA4 queda como `alterno` de PA3 en
  // PARES_DIRECCIONALES, NO se agrega como entrada física acá (mismo
  // criterio que 5.1/PA9/etc.).
  { codigo: 'PA1',  concesionaria: 'Autopista Central', tramo: 'La Capilla – Los Guindos',                     lat: -33.695400, lon: -70.723700 },
  { codigo: 'PA2',  concesionaria: 'Autopista Central', tramo: 'Los Guindos – La Capilla',                     lat: -33.647300, lon: -70.711600 },
  { codigo: 'PA3',  concesionaria: 'Autopista Central', tramo: 'La Capilla – Colón',                           lat: -33.622800, lon: -70.714600 },
  // PA37/PA5 corregidos 2026-10-13 contra OSM (ref+nombre oficial) y el
  // cruce real de AGP del 10-oct (TTXR82): la coordenada vieja de PA37 caía
  // sobre el gantry PA3/PA4 y la de PA6 sobre el gantry real de PA37. PA5 y
  // PA6 son el MISMO gantry (40m) en sentidos opuestos -> PA6 pasa a ser
  // `alterno` de PA5 (PARES_DIRECCIONALES), sin geocerca propia. PA37 cobra
  // solo hacia el sur (ver SENTIDO_UNICO).
  { codigo: 'PA37', concesionaria: 'Autopista Central', tramo: 'Colón – Calera de Tango',                      lat: -33.596894, lon: -70.715792 },
  { codigo: 'PA5',  concesionaria: 'Autopista Central', tramo: 'Colón – Las Acacias',                          lat: -33.582754, lon: -70.713842 },
  { codigo: 'PA32', concesionaria: 'Autopista Central', tramo: 'Las Acacias – Lo Blanco',                      lat: -33.558862, lon: -70.710671 },
  { codigo: 'PA7',  concesionaria: 'Autopista Central', tramo: 'Las Acacias – Américo Vespucio',               lat: -33.547848, lon: -70.696958 },
  { codigo: 'PA30', concesionaria: 'Autopista Central', tramo: 'Américo Vespucio – Departamental',             lat: -33.507288, lon: -70.669319 },
  { codigo: 'PA10', concesionaria: 'Autopista Central', tramo: 'Departamental – Carlos Valdovinos',            lat: -33.495772, lon: -70.663899 },
  { codigo: 'PA31', concesionaria: 'Autopista Central', tramo: 'Carlos Valdovinos – Alameda',                 lat: -33.469011, lon: -70.656243 },
  { codigo: 'PA13', concesionaria: 'Autopista Central', tramo: 'Alameda – Río Mapocho',                       lat: -33.448923, lon: -70.659592 },
  { codigo: 'PA16', concesionaria: 'Autopista Central', tramo: 'Río Mapocho – 14 de la Fama',                 lat: -33.417186, lon: -70.678723 },
  // PA15 separado de PA16 2026-10-13: gantries a 1,4km según OSM (antes
  // par direccional en el punto de PA16 -- TTXR82 9-oct: detectado 16:39,
  // la concesionaria lo cobró 16:48). Ver SENTIDO_UNICO.
  { codigo: 'PA15', concesionaria: 'Autopista Central', tramo: '14 de la Fama – Río Mapocho',                 lat: -33.426515, lon: -70.668895 },
  { codigo: 'PA17', concesionaria: 'Autopista Central', tramo: '14 de la Fama – Américo Vespucio Norte',      lat: -33.368582, lon: -70.699104 },
  { codigo: '2.2',  concesionaria: 'Vespucio Sur',      tramo: 'Gral. Velásquez – Ruta 5',                    lat: -33.5263, lon: -70.6941 },
  // 5.1 (alterno de 5.2, mismo punto físico, sentido contrario — ver
  // PARES_DIRECCIONALES) y 5.4 (nuevo, ~230m al norte de 5.2 en el mismo
  // corredor) — agregados 2026-09-15. Antes ambos colapsaban en "5.2" al
  // no tener geocerca propia (bug real: el usuario vio $122 y $1.149 reales
  // en pantalla, tarifas de 5.1/5.4, mientras el sistema calculaba con la
  // tarifa de 5.2 — ver [[project_agp_tracklink_integration]] en memoria).
  // Coordenadas del track GPS real de VVJG-14, confirmadas porque el monto
  // coincide EXACTO con la tarifa oficial (TBFP 5.1=$122, TS 5.4=$1.149).
  { codigo: '5.2',  concesionaria: 'Vespucio Sur',      tramo: 'Quilín – Grecia',                             lat: -33.4810, lon: -70.5788 },
  // 5.4 movido 2026-10-13 a su gantry real según OSM (~2km al sur de 5.2,
  // compartido con 5.3) -- la coordenada vieja (track de VVJG-14) quedaba
  // junto a 5.2 y generaba 5.4 + 5.2 en el mismo punto (caso real VHRX66
  // 11-oct 22:39), perdiendo el cruce real de 5.4.
  { codigo: '5.4',  concesionaria: 'Vespucio Sur',      tramo: 'Las Torres – Quilín',                         lat: -33.496067, lon: -70.584502 },
  // Vespucio Sur 4.1/3.1/3.3 — agregados 2026-08-28. Coordenadas tomadas del
  // propio track GPS real de VVJG-14 (frenada/parada del vehículo justo en
  // ese punto), confirmadas porque el monto coincide EXACTO con la tarifa
  // oficial investigada (311,52 / 665,24 / 520,53 — ver dashboard.html) y el
  // usuario anotó ese mismo monto en pantalla del pórtico el 2026-08-28.
  // Corregidos 2026-10-13 contra OSM (ref+nombre oficial): el monto exacto
  // confirmaba que el código se cobró en ese viaje, no DÓNDE está el gantry.
  // 4.1 y 4.3 son gantries distintos (1,6km), no un par direccional; 3.1 va
  // con 3.2 y 3.3 con 3.4 (antes cruzados, intercambiaba 3.2/3.4 hacia el
  // oriente). 4.3 confirmado con VHRX66 11-oct 22:34 ($45, ~50m del gantry).
  { codigo: '4.1',  concesionaria: 'Vespucio Sur',      tramo: 'Gnmo. de Alderete – Santa Julia',            lat: -33.529790, lon: -70.604845 },
  { codigo: '4.3',  concesionaria: 'Vespucio Sur',      tramo: 'Coronel – Santa Julia',                      lat: -33.541153, lon: -70.615020 },
  { codigo: '3.1',  concesionaria: 'Vespucio Sur',      tramo: 'Santa Rosa – Gran Avenida',                  lat: -33.539608, lon: -70.652943 },
  { codigo: '3.3',  concesionaria: 'Vespucio Sur',      tramo: 'Gran Avenida – Ruta 5',                      lat: -33.533585, lon: -70.676345 },
  // 1.1/4.2 — agregados 2026-09-01, confirmados con el regreso real de
  // VVJG-14 esa noche (11m de distancia al track GPS real en ambos casos,
  // monto TBFP exacto: $532,59≈$532 y $798,89≈$798). Tarifario oficial 2026
  // MOP (concesiones.mop.gob.cl/uploads/sites/4/2026/01/VESPUCIO-SUR.pdf) —
  // esa misma fuente confirma sin cambios los montos ya cargados de 2.2/
  // 5.2/4.1/3.1/3.3/4.3/3.4/3.2.
  { codigo: '1.1',  concesionaria: 'Vespucio Sur',      tramo: 'General Velásquez – Ruta 78',                lat: -33.516561, lon: -70.712534 },
  { codigo: '4.2',  concesionaria: 'Vespucio Sur',      tramo: 'Gnmo. de Alderete – Vicuña Mackenna',        lat: -33.526802, lon: -70.602574 },
  // 1.3 -- gap conocido desde 2026-10-20, cerrado el mismo día: el usuario
  // mandó una coordenada de investigación web (-33.506,-70.727) que se
  // confirmó contra OSM (nodo "P1.3 2a Transversal - Camino a Melipilla",
  // ref=P1.3, a 136m) -- se usa la coordenada exacta del nodo OSM, no la
  // aproximada. Confianza alta.
  { codigo: '1.3',  concesionaria: 'Vespucio Sur',      tramo: '2ª Transversal – Camino a Melipilla',        lat: -33.5058611, lon: -70.728455 },
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
  // PC102 quitado como entrada física 2026-09-22 -- es el alterno de PC101
  // (mismo túnel, sentido contrario, ver PARES_DIRECCIONALES). Bug real
  // confirmado con track GPS: PC101/PC102 disparaban juntos en cada cruce.
  // Acceso Vial AMB (camino al Aeropuerto A. Merino Benítez) — agregado
  // 2026-09-01. Un solo pórtico. Monto aproximado ("peaje a luca", ~$1.000
  // para categoría 1, anunciado por MOP para 2026) — sin tarifario oficial
  // detallado por banda horaria encontrado todavía, tratar como estimado
  // grueso hasta confirmar con una pasada real.
  { codigo: 'AMB', concesionaria: 'Acceso Vial AMB', tramo: 'Peaje Acceso Vial AMB', lat: -33.416596, lon: -70.792727 },
  // Autopistas interurbanas -- agregadas 2026-10-13 a partir del cruce real
  // de AGP (correo Sergio Hidalgo, VHRX66/TTXR82 08-13 oct): el catálogo NO
  // cubría NINGUNA ruta interurbana (solo Santiago urbano + Ruta 5 Norte),
  // por eso 17 tránsitos reales confirmados por las concesionarias no se
  // detectaron. Coordenadas vía OSM/Overpass (nunca inventadas); tarifas =
  // monto real confirmado por Integro Corp/Consulta AGP en ese cruce. Todas
  // tratadas como tarifa plana (TBFP=TBP=TS) por ser gantries free-flow
  // interurbanos sin banda horaria conocida -- corregir si aparece evidencia
  // de sobretarifa punta.
  { codigo: 'RT78T1', concesionaria: 'Autopista del Sol (Ruta 78)', tramo: 'Américo Vespucio (Troncal T1)', lat: -33.4848, lon: -70.7410 },
  { codigo: 'RT78T2', concesionaria: 'Autopista del Sol (Ruta 78)', tramo: 'Rinconada (Troncal T2)',        lat: -33.4956, lon: -70.7772 },
  // Plazas T3/T4/T6/T7/T8/T10 -- gap conocido desde 2026-10-16, cerrado
  // 2026-10-20 con el correo de Sergio Hidalgo (AGP): tarifario RutaPass
  // "Auto o Camioneta" validado contra 12.611 pasadas reales (01-may a
  // 20-oct, mismo monto en ambos sentidos). Coordenadas = referencia OSM que
  // mandó AGP (ellos mismos dicen "no tenemos coordenadas propias, hay que
  // confirmarlas" -- OSM solo tiene un nodo por calzada, sin indicar
  // sentido). T4: AGP reporta 2 nodos candidatos a 1,5km, se usa el que
  // marcaron como el principal. No hay T5 ni T9 (confirmado, no existen).
  { codigo: 'RT78T3',  concesionaria: 'Autopista del Sol (Ruta 78)', tramo: 'Padre Hurtado (Troncal T3)', lat: -33.55283, lon: -70.81390 },
  { codigo: 'RT78T4',  concesionaria: 'Autopista del Sol (Ruta 78)', tramo: 'Malloco (Troncal T4)',        lat: -33.58781, lon: -70.84505 },
  { codigo: 'RT78T6',  concesionaria: 'Autopista del Sol (Ruta 78)', tramo: 'Talagante (Troncal T6)',      lat: -33.64290, lon: -70.87563 },
  { codigo: 'RT78T7',  concesionaria: 'Autopista del Sol (Ruta 78)', tramo: 'El Paico (Troncal T7)',       lat: -33.68482, lon: -70.94317 },
  { codigo: 'RT78T8',  concesionaria: 'Autopista del Sol (Ruta 78)', tramo: 'Melipilla (Troncal T8)',      lat: -33.66930, lon: -71.15072 },
  { codigo: 'RT78T10', concesionaria: 'Autopista del Sol (Ruta 78)', tramo: 'Puangue (Troncal T10)',       lat: -33.64748, lon: -71.36018 },
  // RDM-ANG: AGP reporta el MISMO código con montos distintos según el
  // tránsito ($3800 en casi todos los casos reales vistos, pero $1000 en uno
  // -- 09-oct-2026, VHRX-66). Ruta del Maipo parece ser un sistema de cobro
  // abierto (como AVO, ver estimarCobroAVO) donde el monto depende del
  // tramo real recorrido, no un flat fijo -- sin datos de entrada/salida no
  // se puede reproducir esa fórmula, así que se deja el valor modal ($3800,
  // la gran mayoría de los casos reales) como estimado, documentado como
  // limitación conocida en vez de adivinar una fórmula.
  { codigo: 'RDM-ANG',    concesionaria: 'Ruta del Maipo', tramo: 'Nueva Angostura (km 54)', lat: -33.9076, lon: -70.7312 },
  // RDM-MAIPO = código interno de AGP "RDM-TRM" (confirmado 2026-10-16: GPS
  // real de VHRX-66 en el cruce real de ese código, 09-oct 12:15 hora Chile,
  // cae a ~700m de esta coordenada y el monto real $621 coincide exacto con
  // el ya cargado acá) -- mismo pórtico, agregado el mapeo en codigoInterno().
  { codigo: 'RDM-MAIPO',  concesionaria: 'Ruta del Maipo', tramo: 'Río Maipo (km 19)',       lat: -33.6626, lon: -70.6679 },
  // Coordenada refinada 2026-10-16 con el cruce real de AGP (RDM-QTA,
  // VHRX-66, 09-oct 14:58 hora Chile) -- "QTA" es el código interno de AGP
  // para este mismo pórtico "Quinta", confianza alta (antes triangulada sin
  // cruce real, confianza media-alta).
  { codigo: 'RDM-QUINTA', concesionaria: 'Ruta del Maipo', tramo: 'Quinta (km 162)',         lat: -34.7883, lon: -71.0461 },
  // Gabriela y Tocornal -- gap conocido desde 2026-10-13 (sin coordenadas
  // confirmadas), cerrado 2026-10-16 con el cruce real de AGP (códigos
  // internos propios RDM-GABP/RDM-GABO y RDM-TOCP/RDM-TOCO según sentido,
  // mismo monto en ambos sentidos -- un solo código/geocerca acá, igual que
  // RDM-ANG) cruzado contra el GPS real de VHRX-66 ese mismo viaje, 09-oct
  // 12:08/12:10 hora Chile respectivamente. Precisión de AGP es a nivel de
  // minuto (no segundo), así que la coordenada puede tener un margen de
  // hasta ~1,5km a lo largo de la ruta -- validar con el chequeo semanal OSM.
  { codigo: 'RDM-GAB', concesionaria: 'Ruta del Maipo', tramo: 'Gabriela',  lat: -33.569272, lon: -70.612921 },
  { codigo: 'RDM-TOC', concesionaria: 'Ruta del Maipo', tramo: 'Tocornal', lat: -33.6052501, lon: -70.6042576 },
  // Requínoa/Rosario -- gap conocido desde 2026-10-13 (sin coordenadas
  // confirmadas por nadie, ni AGP ni OSM con nombre). Cerrado 2026-10-21
  // cruzando 2 fuentes: una tabla de Autofact con el km exacto de cada
  // plaza (Requínoa Poniente km 99,7 / Oriente km 101,5; Rosario Poniente
  // km 107,5 / Oriente km 107,2 -- la misma tabla confirma Gabriela km 4,9
  // y Tocornal km 7,5 EXACTOS a lo ya cargado, buena señal de que el resto
  // de la tabla es confiable) contra 5 nodos `barrier=toll_booth` reales
  // mapeados en OSM en esa zona (sin nombre/ref, pero geográficamente
  // ordenados igual que la tabla de kms).
  // Requínoa Poniente/Oriente quedan a 1,8km entre sí -- son 2 estructuras
  // físicas distintas (no el mismo gantry por los 2 sentidos, a diferencia
  // de Gabriela/Tocornal), así que van como 2 códigos separados.
  // Poniente = la de menor km, nodo más al norte -- es la única con monto
  // real confirmado por AGP ($900, 2 veces, archivo Tag Interurbano ago-26).
  { codigo: 'RDM-REQ-PTE', concesionaria: 'Ruta del Maipo', tramo: 'Requínoa Poniente (km 99,7)', lat: -34.28197, lon: -70.81868 },
  // Oriente: coordenada real (nodo OSM), sin monto confirmado todavía --
  // se deja sin entrada en TARIFAS (monto_estimado queda null, no se
  // adivina) hasta tener un cruce real.
  { codigo: 'RDM-REQ-OTE', concesionaria: 'Ruta del Maipo', tramo: 'Requínoa Oriente (km 101,5)', lat: -34.28899, lon: -70.82191 },
  // Rosario Poniente/Oriente quedan a solo ~300m -- mismo nudo, un código
  // alcanza (el radio de geocerca de 150m cubre ambos lados igual). Sin
  // monto confirmado (el único dato real de AGP para Rosario fue $0, no
  // sirve de referencia) -- sin entrada en TARIFAS, mismo criterio que
  // Requínoa Oriente.
  { codigo: 'RDM-ROS', concesionaria: 'Ruta del Maipo', tramo: 'Rosario', lat: -34.34667, lon: -70.84072 },
  { codigo: 'RDMA-RCLARO', concesionaria: 'Ruta del Maule', tramo: 'Río Claro (km 220)', lat: -35.2097, lon: -71.4113 },
  { codigo: 'RDMA-RETIRO', concesionaria: 'Ruta del Maule', tramo: 'Retiro (km 322)',    lat: -36.0092, lon: -71.7324 },
  // Acceso Norte a Concepción (Región del Biobío) -- NO es Ruta 68 como
  // parecía por el nombre en el correo de AGP ("RutaPass"), confirmado con
  // díptico oficial MOP. Monto solo estimado por Smart Report, sin
  // confirmación de la concesionaria todavía.
  { codigo: 'AGUAMAR', concesionaria: 'Acceso Norte a Concepción', tramo: 'Peaje Troncal Agua Amarilla (km 60)', lat: -36.7300, lon: -72.8602 },
  // "Ruta Sur" -- concesión que faltaba por completo en el catálogo,
  // detectada 2026-10-20 (correo Sergio Hidalgo, 5 tránsitos reales de
  // TTXR-82 sin capturar entre el 14 y el 17-oct). Códigos propios de AGP:
  // SCL (Santa Clara), LMA (Las Maicas), LANM (Los Ángeles). Coordenadas
  // trianguladas con el GPS real de TTXR-82 en los timestamps exactos que
  // dio Sergio -- Santa Clara y Las Maicas confirmadas con 2 cruces
  // independientes cada una (14-oct y 17-oct, calzan dentro de ~1,5km);
  // Los Ángeles con un solo cruce (14-oct), confianza media.
  { codigo: 'SCL',  concesionaria: 'Ruta Sur', tramo: 'Santa Clara',   lat: -36.918,   lon: -72.344   },
  { codigo: 'LMA',  concesionaria: 'Ruta Sur', tramo: 'Las Maicas',    lat: -37.8096,  lon: -72.3352  },
  { codigo: 'LANM', concesionaria: 'Ruta Sur', tramo: 'Los Ángeles',   lat: -37.4859317, lon: -72.4042552 },
];
// Bindings mutables reales que usa el resto del archivo (bandaHeuristica,
// grupoGeometriaPara, mensajePasada, etc. las leen como closure sobre el
// scope del módulo) — arrancan en el fallback y cargarCatalogoPorticos() las
// reemplaza al inicio de main() si Supabase responde bien.
let PORTICOS = PORTICOS_FALLBACK;

// Grupo de geometría real (OSM, ver scripts/geometria-corredores/) que le
// corresponde a cada pórtico — para el método NUEVO de detección (map-
// matching contra la calzada real, en paralelo al radio de 150m mientras se
// valida, ver comparacionesMetodos más abajo). En Santiago un mismo corredor
// (ej. Vespucio Sur completo) comparte una sola geometría cacheada; los
// peajes interurbanos de Ruta 5 NO comparten corredor entre sí (el backbone
// recorre cientos de km) — cada uno es su propia plaza aislada con su propia
// geometría.
const GRUPO_GEOMETRIA_POR_CONCESIONARIA = {
  'Costanera Norte': 'costanera-norte',
  'Vespucio Norte': 'vespucio-norte',
  'Autopista Central': 'autopista-central',
  'Vespucio Sur': 'vespucio-sur',
  'Vespucio Oriente (AVO)': 'avo',
  'Túnel San Cristóbal': 'tunel-san-cristobal',
  'Acceso Vial AMB': 'amb',
};
// El nombre quedó de cuando esto era solo para plazas interurbanas
// aisladas -- desde 2026-09-29 también sirve como override genérico de
// grupo POR CÓDIGO (no por concesionaria) para 5.1/5.2/5.3/5.4, que
// necesitan su propio grupo chico con la caletera cacheada (ver
// esMasCercaDeCaleteraQueDeAutopista). Los 4 códigos apuntan al mismo grupo
// porque es el mismo par de pórticos físicos (5.2 base/5.1 alterno,
// 5.4 base/5.3 alterno) -- 5.1/5.3 hacen falta acá porque la cola de
// "pendientes" más abajo busca por `portico_codigo` YA resuelto por
// dirección (puede ser el alterno), no por el código base de PORTICOS.
const GRUPO_GEOMETRIA_POR_CODIGO_INTERURBANO = {
  LAMPA: 'lampa', LASVEGAS: 'lasvegas', PICHIDANGUI: 'pichidangui',
  TRONCALSUR: 'troncalsur', TONGOY: 'tongoy', GUANAQUEROS: 'guanaqueros',
  PTACOLORADA: 'ptacolorada', TOTORAL: 'totoral', PTOVIEJO: 'ptoviejo',
  '5.1': 'vespucio-sur-grecia-caletera', '5.2': 'vespucio-sur-grecia-caletera',
  '5.3': 'vespucio-sur-grecia-caletera', '5.4': 'vespucio-sur-grecia-caletera',
};
function grupoGeometriaPara(portico) {
  return (
    GRUPO_GEOMETRIA_POR_CODIGO_INTERURBANO[portico.codigo] ||
    GRUPO_GEOMETRIA_POR_CONCESIONARIA[portico.concesionaria] ||
    null
  );
}

// Algunos pares de pórticos de Vespucio Sur comparten prácticamente la
// misma posición física (las dos calzadas — ida y vuelta — quedan lo
// bastante cerca como para caer en el mismo radio de 150m), pero el código
// y la tarifa oficial correcta dependen del sentido de viaje. Confirmado en
// vivo el 2026-08-28 con el track GPS real de VVJG-14. Corregido 2026-10-13
// contra OSM: 4.1/4.3 NO son un par (gantries a 1,6km, ver SENTIDO_UNICO) y
// los pares reales son 3.1↔3.2 y 3.3↔3.4 (antes cruzados 3.1↔3.4/3.3↔3.2).
// Vespucio Sur (anillo E-O) se resuelve por tendencia de LONGITUD: positivo =
// longitud creciente = hacia el oriente = código alterno. Autopista Central /
// Eje Gral. Velásquez (corredor N-S) se resuelve por tendencia de LATITUD:
// positivo = latitud creciente = hacia el norte = código BASE (las columnas
// "Sur-Norte" del tarifario), negativo = hacia el sur = código alterno
// ("Norte-Sur") — polaridad opuesta a Vespucio Sur, por eso `positivoEsAlterno`.
const PARES_DIRECCIONALES = {
  '3.1': { eje: 'lon', positivoEsAlterno: true,  alterno: '3.2',  tramoAlterno: 'Gran Avenida – Santa Rosa' },
  '3.3': { eje: 'lon', positivoEsAlterno: true,  alterno: '3.4',  tramoAlterno: 'Ruta 5 – Gran Avenida' },
  // 2.2/2.1 -- el usuario mandó una coordenada de investigación web para 2.1
  // que resultó estar a ~3km de cualquier pórtico real (verificado contra
  // OSM, nada ahí); el nodo real "P2.1 Ruta 5 - General Velásquez" está a
  // 29m de nuestro 2.2 ya catalogado -- mismo nudo vial, codificado por
  // sentido, igual patrón que 3.3/3.4 (mismo segmento "X – Ruta 5" en el
  // mismo tramo del anillo). Convención de signo por analogía estructural
  // con 3.3/3.4 (mismo tipo de segmento), NO confirmada con cruce real.
  '2.2': { eje: 'lon', positivoEsAlterno: true,  alterno: '2.1',  tramoAlterno: 'Ruta 5 – General Velásquez' },
  PA5:   { eje: 'lat', positivoEsAlterno: false, alterno: 'PA6',  tramoAlterno: 'Lo Blanco – Colón' },
  // 5.2/5.4 — tramo oriente de Vespucio Sur (Quilín/Grecia/Las Torres, La
  // Reina-Peñalolén), donde el anillo corre N-S en vez de E-O como el resto
  // de Vespucio Sur — por eso usa la MISMA convención que Autopista Central
  // (eje lat, positivoEsAlterno false), no la de 4.1/3.1/3.3 de arriba.
  // Agregado 2026-09-15, confirmado con track GPS real: $122 real (TBFP de
  // 5.1) yendo hacia el sur, $1.149 real (TS de 5.4→alterno 5.3) — ver
  // PORTICOS arriba y [[project_agp_tracklink_integration]] en memoria.
  '5.2': { eje: 'lat', positivoEsAlterno: false, alterno: '5.1', tramoAlterno: 'Grecia – Quilín' },
  '5.4': { eje: 'lat', positivoEsAlterno: false, alterno: '5.3', tramoAlterno: 'Quilín – Las Torres' },
  PA23:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA24', tramoAlterno: 'Alameda – Carlos Valdovinos' },
  PA25:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA26', tramoAlterno: 'Río Mapocho – Alameda' },
  PA21:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA22', tramoAlterno: 'Carlos Valdovinos – Américo Vespucio' },
  PA28:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA29', tramoAlterno: 'Ruta 5 Norte – Río Mapocho' },
  // Eje Norte-Sur (ver PORTICOS) — misma convención de latitud que Eje Gral.
  // Velásquez, porque ambos corredores corren N-S.
  PA30:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA9',  tramoAlterno: 'Departamental – Américo Vespucio' },
  PA10:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA11', tramoAlterno: 'Carlos Valdovinos – Departamental' },
  PA31:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA12', tramoAlterno: 'Alameda – Carlos Valdovinos' },
  PA13:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA14', tramoAlterno: 'Río Mapocho – Alameda' },
  PA17:  { eje: 'lat', positivoEsAlterno: false, alterno: 'PA18', tramoAlterno: 'Américo Vespucio Norte – 14 de la Fama' },
  // PA3/PA4 (extremo sur, nudo La Capilla-Calera de Tango) -- agregados
  // 2026-10-13 a partir del cruce real de AGP (ver correo Sergio Hidalgo):
  // mismo gantry físico, confirmado con coordenadas OSM a solo 90m de
  // distancia (igual patrón que P10/P11, PC101/PC102). PA3 (tramo "La
  // Capilla – Colón", northbound) es el código principal con geocerca real;
  // PA4 ("Calera de Tango – La Capilla", southbound) es el alterno.
  PA3:   { eje: 'lat', positivoEsAlterno: false, alterno: 'PA4',  tramoAlterno: 'Calera de Tango – La Capilla' },
  // Vespucio Norte occidental (ver PORTICOS) — mismo corredor E-O que
  // Vespucio Sur, misma convención de longitud.
  P6:    { eje: 'lon', positivoEsAlterno: true,  alterno: 'P5',   tramoAlterno: 'Costanera Norte – Condell' },
  P17:   { eje: 'lon', positivoEsAlterno: true,  alterno: 'P1',   tramoAlterno: 'Ruta 78 – Santa Elena' },
  // P10/P11 (mismo corredor Vespucio Norte, mismo nudo con Ruta 5 Norte) —
  // bug real confirmado 2026-09-22 con el track GPS de VVJG-14 (2026-09-21):
  // los dos códigos disparaban juntos en cada cruce (mismo patrón que P6/P5)
  // porque tenían geocerca propia en vez de resolverse por sentido. Misma
  // convención de longitud que P6/P17 (mismo corredor E-O): positivo =
  // longitud creciente = hacia Pedro Fontova (oriente) = alterno.
  P11:   { eje: 'lon', positivoEsAlterno: true,  alterno: 'P10',  tramoAlterno: 'Ruta 5 Norte – Pedro Fontova' },
  // P12/P13 (nudo Pedro Fontova) y P14/P15 (nudo Guanaco-El Salto) -- mismo
  // patrón real confirmado 2026-09-30 con el track GPS de VVJG-14 (vuelta,
  // rumbo oriente): los 4 códigos disparaban en pares al mismo segundo
  // (17:50:25 y 17:53:25) por no tener par direccional configurado, igual
  // que P10/P11. Misma convención de longitud del corredor: positivo =
  // longitud creciente = hacia el oriente = alterno. Validado con test
  // aislado contra los 2 cruces reales (ambos rumbo oriente, resuelven a
  // P12/P14 respectivamente) antes de pushear.
  P13:   { eje: 'lon', positivoEsAlterno: true,  alterno: 'P12',  tramoAlterno: 'Pedro Fontova – Guanaco' },
  P15:   { eje: 'lon', positivoEsAlterno: true,  alterno: 'P14',  tramoAlterno: 'Guanaco – El Salto' },
  // PC101/PC102 (Túnel San Cristóbal, El Salto↔Kennedy) — mismo bug real,
  // confirmado 2026-09-22 con el mismo track: los dos códigos del túnel
  // disparaban juntos en cada cruce, con tarifas BIEN distintas (TBFP $565
  // vs $452, ver TARIFAS) por lo que el doble conteo también inflaba el
  // monto facturado, no solo la cantidad de pasadas. Corredor propio (no
  // comparte convención con Vespucio Norte/Sur): positivo = longitud
  // creciente = hacia Kennedy (oriente/sur) = código BASE (PC101, sentido
  // real observado en el viaje de vuelta 2026-09-21); negativo = hacia El
  // Salto = alterno (PC102).
  PC101: { eje: 'lon', positivoEsAlterno: false, alterno: 'PC102', tramoAlterno: 'Kennedy – El Salto' },
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

// Distinto de PARES_DIRECCIONALES: estos pórticos son UN SOLO código físico
// (no dos códigos/geocercas separadas) cuya TARIFA cambia según el sentido
// de viaje -- confirmado 2026-09-21 con la calculadora oficial de Costanera
// Norte (P3 en sentido Poniente→Oriente tiene TS de 07:00 a 14:00 seguidas;
// en sentido contrario son 3 ventanas cortas totalmente distintas). Mismo
// mecanismo de eje/tendencia que PARES_DIRECCIONALES, pero el resultado se
// guarda en porticos_pasadas_reales.sentido para que bandaHeuristica elija
// la ventana correcta -- no cambia qué código se guarda, solo con qué
// horario se factura.
// Gantries que cobran en UN solo sentido y no tienen par en la calzada
// opuesta (o lo tienen en otro punto físico). Sin esto, un cruce en sentido
// contrario dentro del radio de 150m se cobraba igual. Confirmado
// 2026-10-13 con el cruce real de AGP (TTXR82 10-oct, Autopista Central
// sur): la concesionaria cobró PA6/PA37/PA4/PA1 hacia el sur y PA2/PA3/PA5
// hacia el norte; Tracklink informaba además PA5/PA2 a la ida y PA1/PA37/
// PA6 a la vuelta. Vespucio Sur 4.1 (poniente) / 4.2 y 4.3 (oriente) según
// tramo oficial en OSM -- 4.1 y 4.2 quedan a 360m, ambos dentro del radio.
// `positivo`: true = solo cobra con tendencia creciente en `eje`
// (lat creciente = norte, lon creciente = oriente).
const SENTIDO_UNICO = {
  PA1:   { eje: 'lat', positivo: false },
  PA2:   { eje: 'lat', positivo: true },
  PA37:  { eje: 'lat', positivo: false },
  PA19:  { eje: 'lat', positivo: true },
  PA20:  { eje: 'lat', positivo: false },
  PA16:  { eje: 'lat', positivo: true },
  PA15:  { eje: 'lat', positivo: false },
  '4.1': { eje: 'lon', positivo: false },
  '4.2': { eje: 'lon', positivo: true },
  '4.3': { eje: 'lon', positivo: true },
};

// Sin punto anterior o sin movimiento neto en el eje no se puede afirmar el
// sentido -- se deja pasar (mismo criterio conservador que calcularSentido).
function cumpleSentidoUnico(codigo, anterior, actual) {
  const cfg = SENTIDO_UNICO[codigo];
  if (!cfg || !anterior) return true;
  const tendencia = cfg.eje === 'lat' ? actual.lat - anterior.lat : actual.lon - anterior.lon;
  if (tendencia === 0) return true;
  return cfg.positivo ? tendencia > 0 : tendencia < 0;
}

const EJE_SENTIDO_PORTICO = {
  // Corredor Costanera Norte, orientación E-O: +lon (menos negativo) =
  // yendo al oriente = "PO". Mismo eje que P6/P17 en PARES_DIRECCIONALES,
  // que están en este mismo corredor.
  P3:    { eje: 'lon', positivoEsPO: true },
  P4CN:  { eje: 'lon', positivoEsPO: true },
  P5CN:  { eje: 'lon', positivoEsPO: true },
  'P6.1': { eje: 'lon', positivoEsPO: true },
  'P6.2': { eje: 'lon', positivoEsPO: true },
  P9CN:  { eje: 'lon', positivoEsPO: true },
};

function calcularSentido(porticoCodigo, anterior, actual) {
  const cfg = EJE_SENTIDO_PORTICO[porticoCodigo];
  if (!cfg || !anterior) return null;
  const tendencia = cfg.eje === 'lat' ? actual.lat - anterior.lat : actual.lon - anterior.lon;
  if (tendencia === 0) return null; // sin movimiento neto en el eje, no se puede afirmar sentido
  const esPO = cfg.positivoEsPO ? tendencia > 0 : tendencia < 0;
  return esPO ? 'PO' : 'OP';
}

// Método nuevo EN PARALELO, solo observacional por ahora (2026-09-21) --
// mismo patrón que el map-matching de calzada (ver nota de "Método NUEVO"
// más abajo): no cambia en nada resolverCodigoDireccional todavía, solo
// registra en el log cuándo el rumbo real del dispositivo (headingC9,
// confirmado que TrackGTS lo manda) habría resuelto la dirección distinto
// que el método actual (delta entre dos puntos GPS consecutivos, ruidoso a
// baja velocidad -- justo donde más importa, en nudos con pórticos muy
// juntos como P10/P11). Sirve para juntar evidencia de cuál es más
// confiable antes de reemplazar nada que afecte tarifas reales.
function diferenciaAngular(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function resolverCodigoDireccionalPorRumbo(portico, heading) {
  const par = PARES_DIRECCIONALES[portico.codigo];
  if (!par || heading == null) return null;
  // eje='lat': avanzar en +lat es rumbo ~0° (norte), -lat ~180° (sur).
  // eje='lon': avanzar en +lon es rumbo ~90° (este), -lon ~270° (oeste).
  const rumboPositivo = par.eje === 'lat' ? 0 : 90;
  const vaEnSentidoPositivo = diferenciaAngular(heading, rumboPositivo) < 90;
  const esAlterno = par.positivoEsAlterno ? vaEnSentidoPositivo : !vaEnSentidoPositivo;
  return esAlterno ? { codigo: par.alterno, tramo: par.tramoAlterno } : { codigo: portico.codigo, tramo: portico.tramo };
}

// Copia de emergencia — ver nota en PORTICOS_FALLBACK arriba.
const TARIFAS_FALLBACK = {
  // P3 (Costanera Norte, Puente Lo Saldes) corregido 2026-09-02: el valor
  // anterior (719/1384/2097) venía de un PDF tarifario "confirmado por dos
  // fuentes independientes", pero el historial de transacciones REALES de
  // Smart Report muestra $306 (16:49) y $589 (16:06) — ninguna lectura real
  // se acerca a 719. TS sin lectura real todavía: se estima con el mismo
  // multiplicador ~1.514× TBP que se repite exacto en P4CN/P7CN/P8.0-8.3 de
  // esta misma concesionaria (899≈589×1.514), no confirmado.
  // 2.2/5.2 actualizados 2026-08-27 al tarifario 2026 vigente (ver dashboard.html
  // para la fuente/detalle).
  P3:   { TBFP: 306, TBP: 589, TS: 892 },
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
  // P8 corregido 2026-09-02: el PDF oficial daba TBP/TS=1306, pero el
  // historial de transacciones REALES de Smart Report (16 cobros de P8,
  // entre las 10:39 y las 20:38, TODOS por $653, incluida hora punta
  // 17:58-20:38) confirma que P8 es tarifa PLANA — nunca cobró 1306. Data
  // real de facturación pesa más que el PDF acá.
  P8:   { TBFP: 653, TBP: 653,  TS: 653  },
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
  // TS corregido 2026-10-16 (844→1266): quedó cargado igual al TBP como
  // placeholder ("sin cruce real todavía"), pero el caso real reportado por
  // AGP (TTXR-82, 08-oct 19:52, tramo Río Mapocho–Alameda, dentro de la
  // ventana TS 18:30-20:30) cobró $1266 = 422×3 -- mismo multiplicador 3x que
  // ya tiene confirmado su par PA24 (864=288×3), no 1x como estaba.
  PA26: { TBFP: 422, TBP: 844,  TS: 1266 },
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
  // PA5/PA6/PA7/PA32/PA37 agregados 2026-09-02: cada uno solo tiene UNA
  // lectura real de Smart Report (todas a media mañana/tarde, fuera de
  // punta) — se toma como TBFP y se deriva TBP/TS con el multiplicador
  // 2×/3× exacto que ya se confirmó en PA30/PA9/PA31/PA13/PA10/PA11 de
  // este mismo corredor (ver fórmula del PDF oficial, nota más abajo). No
  // confirmado independientemente para estos 5 códigos.
  PA37: { TBFP: 455, TBP: 910,  TS: 1365 },
  PA6:  { TBFP: 158, TBP: 316,  TS: 474  },
  PA5:  { TBFP: 335, TBP: 670,  TS: 1005 },
  PA32: { TBFP: 177, TBP: 354,  TS: 531  },
  PA7:  { TBFP: 452, TBP: 904,  TS: 1356 },
  PA30: { TBFP: 393, TBP: 786,  TS: 1178 },
  PA9:  { TBFP: 393, TBP: 786,  TS: 1178 },
  // TS corregido 2026-09-23 (857→1143): era el multiplicador genérico 3x
  // asumido para el corredor, la tabla oficial MOP confirma que este
  // pórtico específico es 4x TBFP (285,79×4=1.143,16). Ver VENTANAS_PUNTA_PORTICO.
  PA10: { TBFP: 286, TBP: 572,  TS: 1143 },
  PA11: { TBFP: 286, TBP: 572,  TS: 857  },
  PA31: { TBFP: 369, TBP: 738,  TS: 1107 },
  PA12: { TBFP: 369, TBP: 738,  TS: 1107 },
  PA13: { TBFP: 182, TBP: 364,  TS: 546  },
  PA14: { TBFP: 182, TBP: 364,  TS: 546  },
  PA16: { TBFP: 425, TBP: 850,  TS: 1275 },
  PA15: { TBFP: 425, TBP: 850,  TS: 1275 },
  PA17: { TBFP: 462, TBP: 925,  TS: 1387 },
  PA18: { TBFP: 462, TBP: 925,  TS: 1387 },
  // PA1/PA2/PA3/PA4 (extensión sur, La Capilla/Los Guindos/Calera de Tango)
  // agregados 2026-10-13 -- cada uno con UNA sola lectura real confirmada
  // por Integro Corp/Consulta AGP (correo AGP), todas fuera de cualquier
  // ventana punta genérica (06:43-06:50 y 23:02-23:03), así que se toman
  // como TBFP y se repiten en TBP/TS por falta de tarifario oficial con
  // bandas -- corregir si aparece evidencia real de sobretarifa punta.
  PA1:  { TBFP: 868, TBP: 868, TS: 868 },
  PA2:  { TBFP: 868, TBP: 868, TS: 868 },
  PA3:  { TBFP: 585, TBP: 585, TS: 585 },
  PA4:  { TBFP: 130, TBP: 130, TS: 130 },
  // Vespucio Sur -- reemplazado 2026-10-20 con el tarifario oficial 2026
  // (vespuciosur.cl/tarifas, Categoría 1) que mandó Sergio Hidalgo (AGP),
  // validado contra 15.690 pasadas reales de Categoría 1 (23-jul a 20-oct,
  // todas calzaron con la banda horaria cargada en VENTANAS de abajo). La
  // concesionaria cobra truncado al peso (no redondeado), por eso estos
  // valores difieren en $1 de los que había antes (que venían redondeados).
  // 4.1/1.1: TS "no aplica" según AGP -- se deja TS=TBP (nunca cobra más
  // que TBP, mismo efecto práctico que "no hay tercera banda").
  '1.3':{ TBFP: 532, TBP: 1065, TS: 1597 },
  '2.2':{ TBFP: 251, TBP: 502,  TS: 753  },
  '3.4':{ TBFP: 120, TBP: 241,  TS: 361  },
  '3.2':{ TBFP: 472, TBP: 944,  TS: 1416 },
  '4.3':{ TBFP: 45,  TBP: 90,   TS: 135  },
  '4.2':{ TBFP: 266, TBP: 532,  TS: 798  },
  '5.4':{ TBFP: 382, TBP: 765,  TS: 1148 },
  '5.2':{ TBFP: 290, TBP: 580,  TS: 871  },
  '5.1':{ TBFP: 121, TBP: 243,  TS: 364  },
  '5.3':{ TBFP: 551, TBP: 1103, TS: 1655 },
  '4.1':{ TBFP: 311, TBP: 623,  TS: 623  },
  '3.1':{ TBFP: 332, TBP: 665,  TS: 997  },
  '3.3':{ TBFP: 260, TBP: 520,  TS: 780  },
  '1.1':{ TBFP: 532, TBP: 1065, TS: 1065 },
  '2.1':{ TBFP: 251, TBP: 502,  TS: 753  },
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
  // Interurbanas agregadas 2026-10-13 a partir del cruce real de AGP (ver
  // PORTICOS arriba) -- tarifa plana, monto = lo confirmado por la
  // concesionaria (Integro Corp/Consulta AGP) en ese cruce.
  // RT78T1/T2: AGP confirmó 2026-10-20 (12.611 pasadas reales) que SÍ existe
  // una sobretarifa 1,5x ($1077/$495 respectivamente), pero solo se activa en
  // salidas/regresos de fin de semana largo -- no es una ventana horaria fija
  // (ej. aparece un miércoles 19:09, un jueves 18:03) y los bordes reales son
  // más anchos que las muestras que mandaron. Sin una regla confiable de
  // cuándo aplica, se deja la tarifa Normal como única banda (falla raro,
  // solo en esos días puntuales, en vez de aplicar mal la sobretarifa en
  // cruces normales). Mismo criterio para T3/T4/T6/T7/T8/T10 de abajo.
  RT78T1:      { TBFP: 718,  TBP: 718,  TS: 718  },
  RT78T2:      { TBFP: 330,  TBP: 330,  TS: 330  },
  RT78T3:      { TBFP: 225,  TBP: 225,  TS: 225  },
  RT78T4:      { TBFP: 225,  TBP: 225,  TS: 225  },
  RT78T6:      { TBFP: 375,  TBP: 375,  TS: 375  },
  RT78T7:      { TBFP: 375,  TBP: 375,  TS: 375  },
  RT78T8:      { TBFP: 599,  TBP: 599,  TS: 599  },
  RT78T10:     { TBFP: 1161, TBP: 1161, TS: 1161 },
  // Ruta Sur -- montos confirmados por AGP en los tránsitos reales del
  // 14/17-oct (ver PORTICOS arriba). Tarifa plana, sin banda horaria
  // conocida todavía (un solo monto visto por plaza).
  SCL:  { TBFP: 3400, TBP: 3400, TS: 3400 },
  LMA:  { TBFP: 3400, TBP: 3400, TS: 3400 },
  LANM: { TBFP: 800,  TBP: 800,  TS: 800  },
  'RDM-ANG':    { TBFP: 3800, TBP: 3800, TS: 3800 },
  'RDM-MAIPO':  { TBFP: 621,  TBP: 621,  TS: 621  },
  'RDM-QUINTA': { TBFP: 3800, TBP: 3800, TS: 3800 },
  'RDM-GAB': { TBFP: 621, TBP: 621, TS: 621 },
  'RDM-TOC': { TBFP: 207, TBP: 207, TS: 207 },
  // RDM-REQ-PTE: único monto real que tenemos para Requínoa ($900, 2 veces,
  // archivo Tag Interurbano ago-2026) -- muestra débil, pero es lo único
  // disponible. RDM-REQ-OTE y RDM-ROS quedan sin entrada acá a propósito
  // (ver PORTICOS arriba) -- se detectan pero el monto queda null.
  'RDM-REQ-PTE': { TBFP: 900, TBP: 900, TS: 900 },
  'RDMA-RCLARO':{ TBFP: 3300, TBP: 3300, TS: 3300 },
  'RDMA-RETIRO':{ TBFP: 3300, TBP: 3300, TS: 3300 },
  // Monto solo estimado por Smart Report (GPS), sin confirmación de la
  // concesionaria todavía -- ver nota en PORTICOS.
  AGUAMAR:     { TBFP: 4400, TBP: 4400, TS: 4400 },
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
let TARIFAS = TARIFAS_FALLBACK;

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

// Partes de una fecha en hora de Chile REAL (con horario de verano incluido)
// — reemplaza los "±4 horas fijas" que tenía todo este archivo. Bug real
// 2026-09-09: Chile pasó a UTC-3 el 6 de septiembre y todo lo que
// sumaba/restaba 4h quedó atrasado 1 hora desde esa fecha (Telegram mostró
// "06:07" para un cruce real de las 07:07, y bandaHeuristica clasificaba mal
// la banda horaria — el error de negocio más serio posible acá). Con Intl +
// el nombre de la zona horaria (no un número fijo) esto no se rompe en el
// próximo cambio de horario.
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

function fmtFechaHoraChile(iso) {
  const p = partesChile(new Date(iso));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}

function diaChile(date) {
  const p = partesChile(date);
  return `${p.year}-${p.month}-${p.day}`;
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

// Filtro genérico de "se estacionó acá" (2026-09-21) -- a diferencia de
// FALSOS_POSITIVOS_CONOCIDOS (curada a mano, patente+pórtico, no escala a
// clientes nuevos), esta señal no depende de qué vehículo ni de qué
// pórtico sea: usa el propio dispositivo Tracklink, no solo la trazada GPS.
// Motivación real: el candidato de P11/P10 (oficina de VVJG-14) cae dentro
// del radio justo cuando el motor se apaga (evento IGF) y el auto no
// vuelve a moverse -- nunca pasa así en un cruce real de autopista
// tarificada (nadie apaga el motor en medio de la vía). distancia_calzada_m
// ya se probó y no sirve para este caso (2-9m, igual a un cruce real
// confirmado, ver nota de P11 en FALSOS_POSITIVOS_CONOCIDOS) -- el apagado
// de motor es una señal del vehículo mismo, no de su posición, así que no
// tiene ese problema de ambigüedad geométrica.
//
// Ventana corta (10 min) a propósito: el IGF real ocurre segundos a pocos
// minutos después de llegar (confirmado con el caso de P11: candidatos
// 07:05:47-07:06:46, IGF a las 07:07:06) -- una ventana larga arriesgaría
// silenciar un cruce real seguido, minutos después, de un apagado en un
// lugar totalmente distinto (ej. el destino final del viaje).
const VENTANA_APAGADO_MS = 10 * 60_000;

// Actualizado 2026-09-21: además del mensaje de transición IGF, se chequea
// ignState directo (booleano, viene en CADA punto, no solo en la
// transición) -- más robusto: si el motor ya estaba apagado ANTES de que
// empezara el rango consultado en esta corrida, nunca va a aparecer un
// mensaje IGF dentro de la ventana, pero el estado "false" en cualquier
// lectura periódica (POS-T/POS-H) igual lo delata.
function hayApagadoCercaDelPortico(puntosDesde, portico) {
  if (!puntosDesde.length) return false;
  const t0 = puntosDesde[0].time.getTime();
  for (const p of puntosDesde) {
    if (p.time.getTime() - t0 > VENTANA_APAGADO_MS) break;
    const motorApagado = p.msgType === 'IGF' || p.ignState === false;
    if (motorApagado && haversineMetros(p.lat, p.lon, portico.lat, portico.lon) <= RADIO_GEOCERCA_M) {
      return true;
    }
  }
  return false;
}

// Una RAMPA de acceso (motorway_link/trunk_link) nace pegada a la vía local
// de la que se desprende — justo antes de separarse, ambas quedan a los
// mismos pocos metros. Por eso "¿hay alguna vía tarificada cerca?" no
// alcanza para distinguir "iba en la caletera paralela" de "iba tomando la
// rampa real": hace falta exigir que el vehículo efectivamente llegue a la
// calzada PRINCIPAL (la autopista misma, no la rampa) para confirmar. Caso
// real 2026-09-10: VVJG-14 midió 6m contra la geometría cacheada del
// pórtico 4.2 (Vespucio Sur) yendo por "Av. Américo Vespucio" a 70km/h,
// sin haber tomado la rampa — lo más cercano ahí era la rampa, no la
// autopista. Si el pórtico no tiene geometría de clase cargada (grupo sin
// vías "principal"/"rampa" cerca, ej. plazas interurbanas aisladas), esto
// no aplica y se sigue confiando en el radio como siempre.
const UMBRAL_CALZADA_PRINCIPAL_M = 30;
const VENTANA_CONFIRMACION_RAMPA_MS = 3 * 60 * 1000;
function requiereConfirmarCalzadaPrincipal(grupo, lat, lon) {
  const d = distanciasPorClase(grupo, lat, lon);
  if (d.principal == null && d.rampa == null) return false;
  if (d.principal != null && d.principal <= UMBRAL_CALZADA_PRINCIPAL_M) return false;
  return d.rampa != null && d.rampa <= UMBRAL_CALZADA_PRINCIPAL_M;
}
function hayPuntoCercaDeCalzadaPrincipal(puntos, grupo, tsBaseMs) {
  for (const p of puntos) {
    if (p.time.getTime() - tsBaseMs > VENTANA_CONFIRMACION_RAMPA_MS) break;
    const d = distanciasPorClase(grupo, p.lat, p.lon).principal;
    if (d != null && d <= UMBRAL_CALZADA_PRINCIPAL_M) return true;
  }
  return false;
}

// Capa 3 del map-matching (2026-09-29): distinto del caso rampa-vs-principal
// de arriba (un umbral fijo SÍ sirve ahí, porque la autopista no corre
// pegada a su propia rampa salvo justo en el empalme). Acá el problema es
// otro: 5.1/5.2/5.3/5.4 (Vespucio Sur, Grecia–Quilín–Las Torres) tienen una
// caletera (Av. Américo Vespucio, highway=primary) corriendo en paralelo a
// pocos metros de la autopista real en un tramo largo -- confirmado real
// 2026-09-28/29 con capturas de Google Maps y consulta directa a OSM (dos
// vías bien etiquetadas, "motorway"+toll=yes vs "primary", no un error de
// mapeo). Un umbral fijo no sirve: cualquier radio lo bastante ancho para
// no perder cruces reales en curvas también agarra la caletera. En vez de
// umbral fijo, comparación RELATIVA entre las dos calzadas reales: si el
// punto está más cerca de la caletera que de la autopista, no es un cruce
// real, sin importar la distancia absoluta a ninguna de las dos.
// `otra` solo tiene datos reales para los grupos que cachean geometría
// ampliada (ver GRUPO_GEOMETRIA_POR_CODIGO_INTERURBANO / fetch-geometria-osm.js)
// -- en cualquier otro grupo (el filtro estricto nunca descarga vías
// "otra") esto no hace nada, `d.otra` sale null y no se rechaza nada.
// Límite conocido, comunicado explícitamente al usuario: en el punto exacto
// de 5.1/5.3 las dos calzadas están a solo ~7m -- ahí el ruido normal de
// GPS puede seguir siendo mayor que la separación real entre vías, así que
// ni esta comparación relativa da 100% de certeza EN ESE punto puntual.
// Margen de 5m en vez de comparar a secas -- probado con datos reales de OSM
// antes de pushear: la propia coordenada catalogada de 5.4 (tomada de un
// track GPS real, no estimada) da principal=4.4m/otra=3.8m, un empate
// técnico donde comparar sin margen la habría rechazado a ella misma. Con
// margen de 5m ese caso (diferencia de 0.6m) NO se rechaza, pero los puntos
// realmente sobre la caletera (probados sobre la geometría real de Av.
// Américo Vespucio) dan otra=0m vs principal=10-14m, muy por sobre el
// margen -- sí se rechazan. El margen absorbe el ruido GPS normal (3-5m)
// sin volver a caer en el mismo problema que un umbral fijo (que si sigue
// resolviendo BIEN, porque acá no se compara contra un número arbitrario
// sino contra la otra calzada real).
const MARGEN_CALETERA_M = 5;
// Generalizado 2026-09-29 a los 5 corredores urbanos (antes solo 5.1-5.4)
// tras un barrido real de todo el catálogo: 71 de 79 pórticos revisados
// tienen una vía paralela a <40m, 66 con orientación casi idéntica a la
// autopista -- NO es el caso aislado de Vespucio Sur, es el patrón normal
// de este tipo de autopista urbana concesionada en Chile (casi siempre se
// construyen con una vía colectora/lateral corriendo pegada a todo el
// trazado). Ver [[project_agp_tracklink_integration]] en memoria.
//
// BUG evitado antes de generalizar: comparar solo contra `principal`
// (motorway/trunk) rompe en AVO, donde varios pórticos están ubicados
// justo en una RAMPA (motorway_link/trunk_link), no en la autopista
// misma -- ahí `d.principal` puede salir lejano o null mientras la rampa
// real está a 0m, y comparar contra la autopista lejana en vez de la
// rampa cercana habría rechazado cruces reales por rampa (falso negativo
// nuevo, peor que el problema que se está resolviendo). Se compara contra
// la MÁS CERCANA entre autopista y rampa (ambas son "vía tarificada"),
// nunca solo contra `principal`.
function esMasCercaDeCaleteraQueDeAutopista(grupo, lat, lon) {
  const d = distanciasPorClase(grupo, lat, lon);
  const distanciasTarificada = [d.principal, d.rampa].filter((x) => x != null);
  if (!distanciasTarificada.length || d.otra == null) return false;
  const distTarificadaMinima = Math.min(...distanciasTarificada);
  return d.otra < distTarificadaMinima - MARGEN_CALETERA_M;
}

// Ventanas oficiales de banda punta CONFIRMADAS por pórtico (hora Chile, L-V,
// en minutos desde medianoche). `null` = tarifa plana / sin banda punta entre
// semana (confirmado con lectura real de 4.1: $311,52 = TBFP a las 07:14, hora
// en que la heurística genérica de abajo habría dicho erróneamente TBP).
// Pórticos no listados acá siguen usando la heurística genérica 07-09/18-21
// hasta que se confirme su ventana oficial real.
// Copia de emergencia — ver nota en PORTICOS_FALLBACK arriba.
const VENTANAS_PUNTA_PORTICO_FALLBACK = {
  // Vespucio Sur -- reemplazado 2026-10-20 con el tarifario oficial que
  // mandó Sergio Hidalgo (AGP), validado contra 15.690 pasadas reales de
  // Categoría 1 (23-jul a 20-oct, todas calzaron). "El inicio queda
  // incluido y el final no" (AGP). Feriados se cobran con horario de
  // domingo y festivo incluso si caen sábado -- ya lo hace `diaTipo` acá
  // mismo (esFeriado fuerza 'domingo' sin importar el día de la semana).
  '1.3': { habil: [[8 * 60 + 30, 9 * 60 + 30]], sabado: [[18 * 60, 21 * 60]], domingo: [[19 * 60, 22 * 60]] },
  '2.2': { habil: [[17 * 60, 17 * 60 + 30]], sabado: [[18 * 60, 21 * 60]], domingo: [[19 * 60, 22 * 60]] },
  '3.4': { habil: [[17 * 60, 18 * 60 + 30], [19 * 60 + 30, 20 * 60]], sabado: [[13 * 60, 15 * 60], [18 * 60, 21 * 60]], domingo: [[19 * 60, 22 * 60]] },
  '3.2': { habil: [[17 * 60, 18 * 60 + 30], [19 * 60 + 30, 20 * 60]], sabado: [[13 * 60, 15 * 60], [18 * 60, 21 * 60]], domingo: [[19 * 60, 22 * 60]] },
  '4.3': { habil: [[8 * 60 + 30, 9 * 60 + 30], [18 * 60, 18 * 60 + 30], [19 * 60 + 30, 20 * 60]], sabado: [[18 * 60, 21 * 60]], domingo: [[19 * 60, 22 * 60]] },
  '4.2': { habil: [[8 * 60 + 30, 9 * 60 + 30], [18 * 60, 18 * 60 + 30], [19 * 60 + 30, 20 * 60]], sabado: [[18 * 60, 21 * 60]], domingo: [[19 * 60, 22 * 60]] },
  '5.4': { habil: [[8 * 60 + 30, 9 * 60 + 30]] },
  '5.2': { habil: [[8 * 60 + 30, 9 * 60 + 30]] },
  '2.1': { habil: [[8 * 60 + 30, 9 * 60 + 30]] },
  '5.1': { habil: [[20 * 60, 22 * 60]], sabado: [[13 * 60, 15 * 60], [20 * 60, 22 * 60]] },
  '5.3': { habil: [[20 * 60, 22 * 60]], sabado: [[13 * 60, 15 * 60], [20 * 60, 22 * 60]] },
  '4.1': { sabado: [[13 * 60, 15 * 60], [20 * 60, 22 * 60]], domingo: [[21 * 60, 23 * 60]] },
  '3.1': { habil: [[7 * 60, 7 * 60 + 30], [8 * 60 + 30, 9 * 60 + 30]], sabado: [[13 * 60, 15 * 60], [20 * 60, 22 * 60]], domingo: [[21 * 60, 23 * 60]] },
  '3.3': { habil: [[7 * 60, 7 * 60 + 30], [8 * 60 + 30, 9 * 60 + 30]], sabado: [[13 * 60, 15 * 60], [20 * 60, 22 * 60]], domingo: [[21 * 60, 23 * 60]] },
  '1.1': { sabado: [[11 * 60, 14 * 60], [19 * 60, 22 * 60]] },
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
  // CORREGIDO 2026-09-23: el 2026-09-11 se puso `null` (sin ventana) a
  // partir de UNA sola lectura real a las 07:26 que mostró TBFP ($286) en
  // vez del TBP genérico ($572) -- conclusión apresurada con un solo dato,
  // justo 4 minutos antes de que abriera la ventana real. Confirmado ahora
  // con la tabla oficial MOP (concesiones.mop.gob.cl/uploads/sites/4/2026/03/AUTOPISTA-CENTRAL.pdf,
  // fila PA10 Departamental-Carlos Valdovinos) Y dos cruces reales nuevos
  // (2026-09-22 07:38 y 2026-09-23 07:41, ambos TBP/$572 en pantalla): la
  // ventana real es 07:30-09:30 hábil y sábado (domingo TBFP todo el día,
  // regla general de la concesionaria). TS oficial de este pórtico también
  // se corrigió (857→1143, ver TARIFAS) -- no es el multiplicador genérico
  // 3x de otros pórticos del corredor, este es 4x TBFP. Domingo agregado
  // el mismo día: se me había pasado en la primera lectura (columna con
  // desfase de alineación distinto al resto de la tabla), confirmado con
  // extracción de coordenadas x/y del PDF en vez de solo texto plano.
  PA10: { habil: [[7 * 60 + 30, 9 * 60 + 30]], sabado: [[7 * 60 + 30, 9 * 60 + 30]], domingo: [[18 * 60 + 30, 20 * 60 + 30]] },
  // PA31/PA13 (mismo corredor, agregados 2026-09-23 con la misma tabla
  // oficial MOP): alta confianza porque la columna TS Laboral de esta
  // misma fila (08:30-09:00) ya estaba cargada en VENTANAS_SATURACION_PORTICO
  // desde antes y coincide exacto -- confirma que la lectura de columnas de
  // esta fila específica es correcta. Antes: ventana_punta=null, corría con
  // la heurística genérica 07-09h (que por casualidad coincidía con los
  // cruces reales de 08:00/08:06/08:10 del 2026-08-31, pero la ventana
  // real es partida en 3 tramos, bastante más angosta/específica).
  PA31: { habil: [[6 * 60 + 30, 8 * 60 + 30], [9 * 60, 14 * 60], [17 * 60, 19 * 60]], sabado: [[10 * 60, 13 * 60]], domingo: [[18 * 60 + 30, 20 * 60 + 30]] },
  PA13: { habil: [[6 * 60 + 30, 8 * 60 + 30], [9 * 60, 14 * 60], [17 * 60, 19 * 60]], sabado: [[10 * 60, 13 * 60]], domingo: [[18 * 60 + 30, 20 * 60 + 30]] },
  // Resto del corredor Eje Norte-Sur, cargado 2026-09-23 con la misma tabla
  // oficial MOP -- antes corrían con la heurística genérica 07-09h/18-21h.
  // Confianza alta: leído por coordenadas x/y del PDF Y confirmado
  // visualmente renderizando la página a imagen (ver scratchpad de la
  // sesión: render-pdf.mjs/crop-pdf.mjs), no solo texto plano (que pierde
  // el orden de columnas cuando el horario de una celda es más largo que
  // el de otra en la misma columna). PA8 (A. Vespucio-Las Acacias) NO se
  // agrega -- no tiene geocerca propia en ningún lado del código, nunca
  // estuvo trackeado, agregarla necesitaría coordenadas reales primero.
  PA5:  { habil: [[6 * 60 + 30, 7 * 60], [8 * 60, 9 * 60 + 30]], domingo: [[18 * 60, 20 * 60]] },
  PA7:  { habil: [[7 * 60 + 30, 9 * 60 + 30]], domingo: [[18 * 60 + 30, 20 * 60 + 30]] },
  PA30: { habil: [[7 * 60 + 30, 9 * 60 + 30]], sabado: [[7 * 60 + 30, 9 * 60 + 30]], domingo: [[18 * 60 + 30, 20 * 60 + 30]] },
  PA16: [[7 * 60 + 30, 9 * 60 + 30]],
  PA17: [[7 * 60, 10 * 60], [10 * 60 + 30, 15 * 60], [16 * 60 + 30, 19 * 60 + 30]],
  PA18: [[7 * 60, 8 * 60 + 30], [9 * 60 + 30, 10 * 60]],
  PA15: [[7 * 60 + 30, 8 * 60], [8 * 60 + 30, 9 * 60], [18 * 60 + 30, 20 * 60 + 30]],
  PA14: { habil: [[7 * 60, 8 * 60 + 30], [9 * 60, 9 * 60 + 30], [15 * 60, 15 * 60 + 30], [16 * 60, 16 * 60 + 30], [18 * 60 + 30, 19 * 60 + 30], [20 * 60, 20 * 60 + 30]], sabado: [[11 * 60, 15 * 60]] },
  PA12: { habil: [[7 * 60, 8 * 60 + 30], [9 * 60, 9 * 60 + 30], [15 * 60, 15 * 60 + 30], [16 * 60, 16 * 60 + 30], [18 * 60 + 30, 19 * 60 + 30], [20 * 60, 20 * 60 + 30]], sabado: [[11 * 60, 15 * 60]] },
  // PA11: sin ventana punta hábil (siempre TBFP en semana) -- solo sábado.
  PA11: { sabado: [[11 * 60, 15 * 60]] },
  PA9:  [[18 * 60, 20 * 60 + 30]],
  PA32: [[18 * 60 + 30, 20 * 60 + 30]],
  PA6:  [[10 * 60, 10 * 60 + 30], [19 * 60 + 30, 20 * 60 + 30]],
  PA37: [[10 * 60, 10 * 60 + 30], [19 * 60 + 30, 20 * 60 + 30]],
};
let VENTANAS_PUNTA_PORTICO = VENTANAS_PUNTA_PORTICO_FALLBACK;

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
// Copia de emergencia — ver nota en PORTICOS_FALLBACK arriba.
const VENTANAS_SATURACION_PORTICO_FALLBACK = {
  // Vespucio Sur -- reemplazado 2026-10-20, misma fuente que
  // VENTANAS_PUNTA_PORTICO_FALLBACK (tarifario oficial AGP, "TS existe solo
  // en día laboral" -- por eso son arrays simples, igual que antes). 4.1 y
  // 1.1 no tienen entrada acá: AGP confirma que no aplica TS para esos dos.
  '1.3': [[7 * 60 + 30, 8 * 60 + 30]],
  '2.2': [[18 * 60 + 30, 19 * 60 + 30]],
  '3.4': [[18 * 60 + 30, 19 * 60 + 30]],
  '3.2': [[18 * 60 + 30, 19 * 60 + 30]],
  '4.3': [[7 * 60 + 30, 8 * 60 + 30], [18 * 60 + 30, 19 * 60 + 30]],
  '4.2': [[7 * 60 + 30, 8 * 60 + 30], [18 * 60 + 30, 19 * 60 + 30]],
  '5.4': [[7 * 60 + 30, 8 * 60 + 30]],
  '5.2': [[7 * 60 + 30, 8 * 60 + 30]],
  '2.1': [[7 * 60 + 30, 8 * 60 + 30]],
  '5.1': [[19 * 60, 20 * 60]],
  '5.3': [[19 * 60, 20 * 60]],
  '3.1': [[7 * 60 + 30, 8 * 60 + 30]],
  '3.3': [[7 * 60 + 30, 8 * 60 + 30]],
  PA28: [[7 * 60 + 30, 8 * 60 + 30]],
  PA31: [[8 * 60 + 30, 9 * 60]],
  PA13: [[8 * 60 + 30, 9 * 60]],
  PA24: [[18 * 60 + 30, 19 * 60]],
  // Resto del corredor Eje Norte-Sur, cargado 2026-09-23 con la tabla
  // oficial MOP (AUTOPISTA-CENTRAL.pdf) -- ver VENTANAS_PUNTA_PORTICO_FALLBACK
  // para el detalle de cómo se leyó (extracción x/y + confirmación visual
  // del PDF renderizado, no solo texto plano).
  PA5: [[7 * 60, 8 * 60]],
  PA18: [[17 * 60 + 30, 18 * 60]],
  PA14: [[10 * 60, 10 * 60 + 30], [11 * 60, 11 * 60 + 30], [15 * 60 + 30, 16 * 60], [19 * 60 + 30, 20 * 60]],
  PA12: [[10 * 60, 10 * 60 + 30], [11 * 60, 11 * 60 + 30], [15 * 60 + 30, 16 * 60], [19 * 60 + 30, 20 * 60]],
  PA32: [[17 * 60 + 30, 19 * 60 + 30]],
  PA6: [[17 * 60 + 30, 19 * 60 + 30]],
};
let VENTANAS_SATURACION_PORTICO = VENTANAS_SATURACION_PORTICO_FALLBACK;

// Carga el catálogo real desde Supabase (tabla porticos_catalogo). Se llama
// una vez al inicio de main(), ANTES de la sección Pórticos — nunca puede
// tumbar Santa Marta: cualquier error acá se atrapa y se sigue con el
// fallback hardcodeado de arriba (ver feedback_cuidado_santa_marta_sync_tlchile
// en memoria: aislar cambios de pórticos de la sección Santa Marta).
async function cargarCatalogoPorticos() {
  const { data, error } = await supabase.from('porticos_catalogo').select('*');
  if (error) throw error;
  if (!data || !data.length) throw new Error('porticos_catalogo devolvió 0 filas');

  // BUG REAL 2026-09-16: los códigos "alterno" (ver PARES_DIRECCIONALES) NO
  // deben tener su propia geocerca física — comparten coordenada con su
  // código base y se resuelven en tiempo real por dirección de viaje
  // (resolverCodigoDireccional). Ya se había encontrado y arreglado este
  // mismo bug el 2026-08-29 (ver comentario histórico más abajo en
  // PARES_DIRECCIONALES), pero se reintrodujo sin querer el 2026-09-11 al
  // migrar el catálogo a Supabase: se agregó una fila propia por cada
  // alterno pensando solo en que necesitaban su propia TARIFA — sí, pero NO
  // su propia geocerca. Efecto real confirmado 2026-09-16: cada cruce de un
  // pórtico con alterno (4.1/4.3, PA10/PA11, PA13/PA14, etc.) generaba DOS
  // pasadas confirmadas idénticas (mismo ts, misma distancia) en vez de una
  // sola resuelta por dirección — el total facturado del día salía
  // duplicado. Los alterno SIGUEN en la tabla (TARIFAS los necesita por
  // código), por eso se filtran acá en vez de borrarse de la DB.
  const codigosAlterno = new Set(Object.values(PARES_DIRECCIONALES).map((par) => par.alterno));

  const porticos = data
    .filter((fila) => !codigosAlterno.has(fila.codigo))
    .map((fila) => ({
      codigo: fila.codigo,
      concesionaria: fila.concesionaria,
      tramo: fila.tramo,
      lat: fila.lat,
      lon: fila.lon,
    }));

  const tarifas = {};
  const ventanasPunta = {};
  const ventanasSaturacion = {};
  for (const fila of data) {
    if (fila.tbfp !== null) {
      tarifas[fila.codigo] = { TBFP: Number(fila.tbfp), TBP: Number(fila.tbp), TS: Number(fila.tarifa_ts) };
    }
    if (fila.ventana_punta_confirmada) {
      ventanasPunta[fila.codigo] = fila.ventana_punta ?? null;
    }
    if (fila.ventana_saturacion) {
      ventanasSaturacion[fila.codigo] = fila.ventana_saturacion;
    }
  }
  return { porticos, tarifas, ventanasPunta, ventanasSaturacion };
}

// Resuelve si minutosDia cae dentro de alguna ventana confirmada, en 3
// formatos posibles de ventana_punta/ventana_saturacion (porticos_catalogo),
// del más viejo al más nuevo -- retrocompatible con todo lo cargado antes
// de 2026-09-21:
//   1. null / undefined                -> nunca aplica
//   2. [[ini,fin], ...]                -> formato de siempre, aplica SOLO
//      día hábil (L-V) -- fin de semana sigue TBFP para estos códigos,
//      exactamente como antes.
//   3. { PO: <2 o 4>, OP: <2 o 4> }     -> el pórtico tiene horario
//      distinto por sentido de viaje (confirmado real: P3/P4CN/P5CN/
//      P6.1/P6.2/P9CN, Costanera Norte -- ver [[project_agp_tracklink_integration]]).
//      Si la pasada no tiene sentido resuelto (o no calza PO/OP), NO se
//      aplica ninguna ventana -- mejor no adivinar que aplicar la del
//      sentido equivocado.
//   4. { habil: [[...]], sabado: [[...]], domingo: [[...]] } -- dentro de
//      un sentido (o directo, sin sentido), cuando el horario TAMBIÉN
//      cambia por tipo de día (confirmado real: P9CN sábado tiene TS de
//      11:30 a 14:59, algo que la heurística vieja nunca podía ver porque
//      colapsaba TODO fin de semana a TBFP antes de mirar cualquier ventana).
function ventanaAplica(ventanaData, sentido, diaTipo, minutosDia) {
  if (!ventanaData) return false;
  if (Array.isArray(ventanaData)) {
    if (diaTipo !== 'habil') return false;
    return ventanaData.some(([ini, fin]) => minutosDia >= ini && minutosDia < fin);
  }
  let nivel = ventanaData;
  if (sentido && Object.prototype.hasOwnProperty.call(nivel, sentido)) {
    nivel = nivel[sentido];
  } else if (nivel.PO || nivel.OP) {
    return false; // tiene desglose por sentido pero esta pasada no lo tiene resuelto
  }
  if (Array.isArray(nivel)) {
    if (diaTipo !== 'habil') return false;
    return nivel.some(([ini, fin]) => minutosDia >= ini && minutosDia < fin);
  }
  const rangos = nivel[diaTipo];
  if (!rangos) return false;
  return rangos.some(([ini, fin]) => minutosDia >= ini && minutosDia < fin);
}

// HEURÍSTICA de banda horaria: TS confirmada > TBP confirmada/genérica >
// TBFP. La ventana oficial del pórtico manda si existe; si no, cae de
// vuelta en la heurística genérica (no es la ventana exacta de las
// concesionarias que aún no hemos investigado).
//
// `sentido` (2026-09-21, ver ventanaAplica arriba): PO/OP/null, solo se usa
// cuando el pórtico tiene horario confirmado distinto por dirección.
// Feriados legales de Chile (2026-10-14) -- API pública gratuita de Boostr,
// confirmada en vivo: https://api.boostr.cl/holidays/<año>.json devuelve
// 2026-10-12 "Encuentro de Dos Mundos" tal cual lo necesitamos. Se carga UNA
// vez por corrida (no por pasada) para todos los años que toca el rango
// consultado ese día, y se cachea en memoria -- si la API falla, esa
// corrida sigue sin feriados reconocidos (degradación graciosa, no rompe la
// detección) y se reintenta sola en la próxima corrida.
let FERIADOS_CHILE = new Set(); // "YYYY-MM-DD"

async function cargarFeriadosChile(anios) {
  for (const anio of anios) {
    try {
      const res = await fetch(`https://api.boostr.cl/holidays/${anio}.json`);
      const json = await res.json();
      if (json.status !== 'success' || !Array.isArray(json.data)) throw new Error(`forma inesperada: ${JSON.stringify(json).slice(0, 200)}`);
      for (const f of json.data) FERIADOS_CHILE.add(f.date);
      console.log(`[feriados] ${anio}: ${json.data.length} feriados cargados.`);
    } catch (err) {
      console.log(`[feriados] ⚠️ No se pudo cargar feriados de ${anio} (${err.message}) -- ese año queda sin feriados reconocidos hasta la próxima corrida.`);
    }
  }
}

function bandaHeuristica(fecha, porticoCodigo, sentido) {
  const p = partesChile(fecha);
  const dow = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay();
  const h = Number(p.hour);
  const min = Number(p.minute);
  const minutosDia = h * 60 + min;
  // Feriado = tarifa de domingo, sin importar el día de la semana real --
  // confirmado real 2026-10-14 (correo de AGP): el 12-oct ("Encuentro de Dos
  // Mundos", lunes) cobró tarifa de domingo y nuestro sistema lo cobró como
  // hábil normal porque solo miraba el día de la semana. Ver FERIADOS_CHILE.
  const esFeriado = FERIADOS_CHILE.has(`${p.year}-${p.month}-${p.day}`);
  const diaTipo = esFeriado || dow === 0 ? 'domingo' : dow === 6 ? 'sabado' : 'habil';

  const ventanasTS = porticoCodigo ? VENTANAS_SATURACION_PORTICO[porticoCodigo] : null;
  if (ventanaAplica(ventanasTS, sentido, diaTipo, minutosDia)) return 'TS';

  if (porticoCodigo && Object.prototype.hasOwnProperty.call(VENTANAS_PUNTA_PORTICO, porticoCodigo)) {
    const ventanas = VENTANAS_PUNTA_PORTICO[porticoCodigo];
    if (ventanaAplica(ventanas, sentido, diaTipo, minutosDia)) return 'TBP';
    // Antes: dow===0||dow===6 devolvía TBFP de inmediato ANTES de mirar
    // ninguna ventana -- eso escondía el caso real de P9CN sábado (arriba).
    // Ahora se sigue devolviendo TBFP en fin de semana salvo que exista una
    // ventana confirmada que diga lo contrario para ESE día específico --
    // mismo comportamiento de siempre para todo lo no confirmado, corregido
    // solo donde hay evidencia real.
    return 'TBFP';
  }

  if (dow === 0 || dow === 6) return 'TBFP';
  if ((h >= 7 && h < 9) || (h >= 18 && h < 21)) return 'TBP';
  return 'TBFP';
}

// Extraído para poder armar el mismo texto tanto al confirmar una pasada al
// toque (mismo lote de puntos) como al confirmar una pasada que quedó
// pendiente de una corrida anterior (ver "Confirmación diferida" abajo).
function mensajePasada(patente, pasada) {
  const banda = bandaHeuristica(new Date(pasada.ts), pasada.portico_codigo, pasada.sentido);
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
  const { data, error } = await supabase.from('porticos_vehiculos').select('id, patente, unit_id, imei, empresa, unit_id_ftc927, imei_ftc927, backfill_pendiente_desde');
  if (error) throw new Error(`Error leyendo vehiculos: ${error.message}`);
  return data || [];
}

// Comparación de precisión GV58LAU vs FTC927 (VVJG-14, 2026-09-18): un mismo
// vehículo puede traer un segundo dispositivo GPS (unit_id_ftc927/imei_ftc927
// en porticos_vehiculos) instalado en paralelo al principal, para comparar
// falsos positivos entre ambos. La detección de geocercas corre una vez por
// cada dispositivo presente ("unidad de detección"), cada una aislada por la
// columna `dispositivo` ('principal'/'secundario') en porticos_pasadas_reales
// y porticos_comparacion_metodos — así no se mezclan ni se hacen dedup
// cruzado entre los dos tracks del mismo vehículo. Para cualquier vehículo
// sin unit_id_ftc927 (todos, hoy, salvo VVJG-14) esto arma exactamente 1
// unidad igual a como era antes de este cambio — cero diferencia de
// comportamiento para el resto del sistema.
function obtenerUnidadesDeteccion(vehiculosPorticos) {
  const unidades = [];
  for (const vehiculo of vehiculosPorticos) {
    unidades.push({ vehiculo, dispositivo: 'principal', unitId: vehiculo.unit_id, imei: vehiculo.imei });
    if (vehiculo.unit_id_ftc927) {
      unidades.push({ vehiculo, dispositivo: 'secundario', unitId: vehiculo.unit_id_ftc927, imei: vehiculo.imei_ftc927 });
    }
  }
  return unidades;
}

// Método nuevo, capa 2: en vez de confiar en la coordenada tipeada a mano o
// en la geometría genérica de OSM (que en un nudo de entradas/salidas no
// distingue la vía tarificada de la rampa/colectora vecina — confirmado
// 2026-09-08 con el caso 4.2/Vicuña Mackenna), se usa como ancla el punto
// de cruce REAL de la pasada CONFIRMADA (con monto_real verificado a mano)
// más precisa que exista para cada pórtico — la que tenga menor
// distancia_m, o sea la que más cerca pasó del pórtico entre todas las
// confirmaciones humanas acumuladas. Se auto-mejora solo con el tiempo (más
// usuarios/cruces confirmados = ancla más precisa), sin depender de que
// una fuente externa (OSM) tenga cada rampa bien tageada.
//
// Requiere el fix de puntoMasCercanoEnSegmento (ver geo-utils.js): antes de
// 2026-09-08 lat/lon guardaba el PING crudo, no el punto de cruce
// interpolado — dos confirmaciones del mismo pórtico con distancia_m<30
// podían quedar guardadas a >400m entre sí. Los anclajes construidos con
// filas anteriores a ese fix pueden traer ese mismo ruido; se corrige solo
// a medida que entran filas nuevas (ya con el fix) con menor distancia_m.
async function obtenerGatesEmpiricos() {
  const { data, error } = await supabase
    .from('porticos_pasadas_reales')
    .select('portico_codigo, lat, lon, distancia_m')
    .not('monto_real', 'is', null)
    .not('lat', 'is', null)
    .not('lon', 'is', null);
  if (error) throw new Error(`Error leyendo gates empíricos: ${error.message}`);

  const porCodigo = new Map();
  for (const fila of data || []) {
    const actual = porCodigo.get(fila.portico_codigo);
    if (!actual) {
      porCodigo.set(fila.portico_codigo, { lat: fila.lat, lon: fila.lon, distancia_m: fila.distancia_m, n: 1 });
    } else {
      actual.n += 1;
      if (fila.distancia_m != null && (actual.distancia_m == null || fila.distancia_m < actual.distancia_m)) {
        actual.lat = fila.lat;
        actual.lon = fila.lon;
        actual.distancia_m = fila.distancia_m;
      }
    }
  }
  return porCodigo;
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
  // MAX_ATTEMPTS subido de 2 a 3 el 2026-09-29 -- un glitch real de TrackGTS
  // (reportTravel devolvió una respuesta con forma de "lista de unidades" en
  // vez del reporte de viaje) agotó los 2 intentos seguidos y tiró abajo la
  // corrida entera. El timeout del job (10 min, ver sync-tlchile.yml) tiene
  // margen de sobra: 3 intentos con 90s de espera entre cada uno caben en
  // ~5 min incluso en el peor caso.
  const MAX_ATTEMPTS = 3;
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

// Comparación GV58LAU/FTC927 (2026-09-18): esta función corre una vez por
// UNIDAD de detección (vehículo+dispositivo, ver obtenerUnidadesDeteccion),
// no una vez por vehículo — así el mismo monto anotado a mano termina
// comparado contra la pasada detectada por CADA dispositivo, no solo una.
//
// El dispositivo "principal" mantiene EXACTAMENTE el comportamiento de
// siempre: usa lectura.pasada_id como gate de "ya emparejada" y lo actualiza
// al emparejar (para cualquier vehículo de un solo dispositivo, esto es la
// única unidad que existe → cero cambio). El "secundario" NO puede usar ese
// mismo campo (ya lo ocupa el principal) — en su lugar se apoya solo en que
// `candidatas` ya viene filtrado por `monto_real IS NULL` de su propio
// dispositivo, y no toca pasada_id/emparejado_en de la lectura.
async function emparejarLecturasManuales(unidadesDeteccion) {
  for (const unidad of unidadesDeteccion) {
    const vehiculo = unidad.vehiculo;
    const dispositivo = unidad.dispositivo;
    const esPrincipal = dispositivo === 'principal';

    let queryPendientes = supabase
      .from('porticos_lecturas_manuales')
      .select('id, monto, ts_ingreso')
      .eq('vehiculo_id', vehiculo.id)
      .gte('ts_ingreso', new Date(Date.now() - VENTANA_ESTACIONADO_MS).toISOString())
      .order('ts_ingreso', { ascending: true });
    // Solo el principal se filtra por pasada_id (ver nota arriba) — el
    // secundario reintenta SIEMPRE todas las lecturas del rango, ya que su
    // propio progreso lo controla monto_real en `candidatas`, no pasada_id.
    if (esPrincipal) queryPendientes = queryPendientes.is('pasada_id', null);
    const { data: pendientes, error: errPendientes } = await queryPendientes;
    if (errPendientes) { console.log(`[lecturas] Error leyendo pendientes de ${vehiculo.patente} (${dispositivo}): ${errPendientes.message}`); continue; }
    if (!pendientes || !pendientes.length) continue;

    // Un solo pool de candidatas para TODAS las lecturas pendientes de este
    // vehículo (no una consulta nueva por lectura) — cubre desde la primera
    // lectura menos la ventana hasta la última más la ventana, y de ahí se
    // va consumiendo. Bug real 2026-09-10: al buscar candidatas por lectura
    // de forma independiente y por cercanía absoluta en el tiempo, sin
    // exigir que el orden cronológico de lecturas↔pasadas se mantenga, una
    // lectura podía "robarle" la pasada a la lectura siguiente cuando dos
    // pórticos quedaban muy seguidos (Vespucio Sur/Autopista Central, unos
    // pocos minutos entre sí) — el monto_real de la pasada 1 terminaba en la
    // pasada 2, el de la 2 en la 3, y así en cadena, todo desalineado en 1.
    const desde = new Date(new Date(pendientes[0].ts_ingreso).getTime() - VENTANA_EMPAREJAR_LECTURA_MS).toISOString();
    const hasta = new Date(new Date(pendientes[pendientes.length - 1].ts_ingreso).getTime() + VENTANA_EMPAREJAR_LECTURA_MS).toISOString();
    const { data: candidatas, error: errCandidatas } = await supabase
      .from('porticos_pasadas_reales')
      .select('id, ts, portico_codigo')
      .eq('vehiculo_id', vehiculo.id)
      .eq('dispositivo', dispositivo)
      .eq('confirmado', true)
      .is('monto_real', null)
      .gte('ts', desde)
      .lte('ts', hasta)
      .order('ts', { ascending: true });
    if (errCandidatas) { console.log(`[lecturas] Error buscando pasadas para ${vehiculo.patente} (${dispositivo}): ${errCandidatas.message}`); continue; }
    if (!candidatas || !candidatas.length) continue;

    // El monto ingresado es más confiable que el reloj para desempatar entre
    // pórticos vecinos: el usuario aprieta "Guardar" justo al pasar bajo el
    // pórtico (casi al mismo tiempo que suena el TAG), pero cuando dos
    // pórticos quedan a pocos minutos entre sí (Vespucio Sur/Autopista
    // Central) esa lectura puede terminar objetivamente más cerca en el
    // reloj del pórtico VECINO que del propio — sin la app enterarse. Bug
    // real 2026-09-10: 4 lecturas quedaron desplazadas en 1 (4.1→4.2,
    // PA21→PA19, PA23→PA21, PA25→PA23) porque el pórtico "equivocado" caía
    // más cerca en el tiempo, aunque el monto delataba cuál era el correcto
    // (ej. $311 calza con la tarifa de 4.1, $312, no con la de 4.2, $266).
    // Por eso ahora se compara el monto contra CUALQUIERA de las tarifas
    // conocidas del pórtico (TBFP/TBP/TS, sin depender de bandaHeuristica —
    // hay pórticos como 2.2 donde la banda TS se activa por congestión real,
    // no por horario fijo, así que la banda "correcta" para ese instante ni
    // siquiera es la que bandaHeuristica habría elegido) y, si algún
    // candidato calza dentro de la tolerancia, se prefiere por sobre uno
    // solo más cercano en el reloj.
    function montosPosiblesPortico(codigo) {
      const tarifa = TARIFAS[codigo];
      return tarifa ? [...new Set(Object.values(tarifa))] : [];
    }
    function toleranciaMonto(monto) {
      return Math.max(5, monto * 0.02); // $5 o 2%, lo que sea mayor — cubre redondeo de centavos sin aceptar un pórtico distinto
    }

    // Emparejamiento secuencial: se recorren lecturas y candidatas en orden
    // cronológico, sin poder retroceder — el pórtico asignado a la lectura N
    // siempre queda antes (en el tiempo) que el asignado a la lectura N+1.
    // Así se preserva el orden real en que se pasó por los pórticos en vez
    // de solo mirar "cuál está más cerca en el tiempo" lectura por lectura.
    let cursor = 0;
    for (const lectura of pendientes) {
      const tsIngresoMs = new Date(lectura.ts_ingreso).getTime();
      let mejorIdxTiempo = -1, mejorDiffTiempo = Infinity;
      let mejorIdxMonto = -1, mejorDiffMonto = Infinity;
      for (let i = cursor; i < candidatas.length; i++) {
        const diffTiempo = Math.abs(new Date(candidatas[i].ts).getTime() - tsIngresoMs);
        if (diffTiempo > VENTANA_EMPAREJAR_LECTURA_MS) {
          if (new Date(candidatas[i].ts).getTime() > tsIngresoMs) break; // ya nos pasamos de la ventana, el resto es peor
          continue; // todavía no llegamos a la ventana de esta lectura
        }
        if (diffTiempo < mejorDiffTiempo) { mejorDiffTiempo = diffTiempo; mejorIdxTiempo = i; }

        const posibles = montosPosiblesPortico(candidatas[i].portico_codigo);
        if (posibles.length) {
          const diffMonto = Math.min(...posibles.map((v) => Math.abs(v - lectura.monto)));
          if (diffMonto <= toleranciaMonto(lectura.monto) && diffMonto < mejorDiffMonto) {
            mejorDiffMonto = diffMonto; mejorIdxMonto = i;
          }
        }
      }
      // El monto manda si algún candidato calzó dentro de la tolerancia;
      // si no (pórtico sin tarifa cargada, ej. AVO, o ningún calce), se cae
      // de vuelta al criterio de solo cercanía en el tiempo.
      const mejorIdx = mejorIdxMonto !== -1 ? mejorIdxMonto : mejorIdxTiempo;
      if (mejorIdx === -1) continue;
      const mejor = candidatas[mejorIdx];
      const criterio = mejorIdxMonto !== -1 ? `monto, Δ$${mejorDiffMonto.toFixed(0)}` : `tiempo, Δ${Math.round(mejorDiffTiempo / 1000)}s`;
      cursor = mejorIdx + 1; // las siguientes lecturas solo pueden emparejar con pasadas posteriores a esta

      const { error: errUpdatePasada } = await supabase
        .from('porticos_pasadas_reales')
        .update({ monto_real: lectura.monto })
        .eq('id', mejor.id);
      if (errUpdatePasada) { console.log(`[lecturas] Error guardando monto_real en pasada ${mejor.id} (${dispositivo}): ${errUpdatePasada.message}`); continue; }

      // Solo el principal actualiza pasada_id/emparejado_en de la lectura —
      // ese campo es un FK singular, ya lo usa el emparejamiento del
      // dispositivo principal (ver nota al inicio de la función).
      if (esPrincipal) {
        const { error: errUpdateLectura } = await supabase
          .from('porticos_lecturas_manuales')
          .update({ pasada_id: mejor.id, emparejado_en: new Date().toISOString() })
          .eq('id', lectura.id);
        if (errUpdateLectura) console.log(`[lecturas] Error marcando lectura ${lectura.id} como emparejada: ${errUpdateLectura.message}`);
      }
      console.log(`[lecturas] ✅ ${vehiculo.patente} (${dispositivo}): $${lectura.monto} emparejado con pasada ${mejor.id} (por ${criterio})`);
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

// --- Estimación de cobro AVO por km recorrido -------------------------------
// AVO (Vespucio Oriente) no cobra por pórtico individual sino por distancia
// recorrida entre el pórtico de entrada y el de salida real — a diferencia
// del resto del sistema, acá SÍ hace falta reconstruir el viaje completo.
// Tarifario oficial 2026 (avo.cl/contenido/95/tarifas-2026), Área 1 (el
// tramo que cubren nuestros códigos P101-P212, El Salto–Príncipe de Gales):
// $232/km fuera de punta, $464/km punta. La ventana horaria oficial de
// punta no está publicada en el sitio — se usa la heurística genérica
// 07-09/18-21 (mismo criterio que el resto de pórticos sin ventana
// confirmada) hasta que se confirme con una lectura real. El usuario
// estima ~$436/km en sus tránsitos habituales (probablemente hora punta,
// $464/km oficial) — dato de calibración, no una lectura real verificada
// todavía.
//
// Requiere el odómetro real (r.odometerC14, viene en "puntos") de la MISMA
// corrida donde se detectó el viaje — no se puede reconstruir después con
// datos ya guardados (porticos_odometro_diario solo guarda inicio/fin del
// DÍA completo, no por tramo). Si un viaje AVO queda partido justo en el
// borde de un checkpoint entre corridas, esta estimación se pierde para
// ese viaje — caso raro dado que un tránsito por AVO dura muchos menos que
// los 30 min entre corridas, pero no imposible.
const AVO_TARIFA_KM = { TBFP: 232, TBP: 464, TS: 464 }; // TS no definido oficialmente en el tarifario, se usa el mismo valor que TBP
const VENTANA_AVO_MS = 40 * 60 * 1000; // mismo criterio que sync-smartreport.js (agruparViajesAVO)
const KM_AVO_MAX_PLAUSIBLE = 60; // el corredor completo mide ~10km — un valor mucho mayor indica odómetro corrupto/reset, se descarta

function agruparViajesAVO(pasadasOrdenadas) {
  const viajes = [];
  let actual = null;
  for (const p of pasadasOrdenadas) {
    const ts = new Date(p.ts).getTime();
    if (actual && ts - actual.ultimoTs <= VENTANA_AVO_MS) {
      actual.salida = p;
      actual.ultimoTs = ts;
    } else {
      actual = { entrada: p, salida: p, ultimoTs: ts };
      viajes.push(actual);
    }
  }
  return viajes;
}

// Punto con odómetro más cercano a tsMs (antes o después) — no exige que sea
// exactamente el punto que generó la pasada, porque ese punto puede no traer
// odómetro en todas las lecturas.
function odometroEnTs(puntosConOdometro, tsMs) {
  let mejor = null, mejorDiff = Infinity;
  for (const p of puntosConOdometro) {
    const diff = Math.abs(p.time.getTime() - tsMs);
    if (diff < mejorDiff) { mejor = p; mejorDiff = diff; }
  }
  return mejor ? mejor.odometro : null;
}

async function estimarCobroAVO(vehiculosPorticos, puntosPorVehiculo) {
  for (const vehiculo of vehiculosPorticos) {
    const puntosConOdometro = (puntosPorVehiculo.get(vehiculo.id) || [])
      .filter((p) => p.odometro != null && !isNaN(p.time));
    if (!puntosConOdometro.length) continue;

    const { data: pendientes, error } = await supabase
      .from('porticos_pasadas_reales')
      .select('id, ts')
      .eq('vehiculo_id', vehiculo.id)
      .eq('concesionaria', 'Vespucio Oriente (AVO)')
      .eq('confirmado', true)
      .is('km_estimado', null)
      .order('ts');
    if (error) { console.log(`[avo-km] Error leyendo pendientes de ${vehiculo.patente}: ${error.message}`); continue; }
    if (!pendientes || !pendientes.length) continue;

    const viajes = agruparViajesAVO(pendientes);
    for (const viaje of viajes) {
      const tsEntrada = new Date(viaje.entrada.ts).getTime();
      const tsSalida = new Date(viaje.salida.ts).getTime();
      const odoEntrada = odometroEnTs(puntosConOdometro, tsEntrada);
      const odoSalida = odometroEnTs(puntosConOdometro, tsSalida);
      if (odoEntrada == null || odoSalida == null) continue;

      const km = Math.round((odoSalida - odoEntrada) * 100) / 100;
      if (km <= 0 || km > KM_AVO_MAX_PLAUSIBLE) {
        console.log(`[avo-km] ${vehiculo.patente}: km sospechoso (${km}) entre ${viaje.entrada.ts} y ${viaje.salida.ts}, se omite.`);
        continue;
      }

      const banda = bandaHeuristica(new Date(viaje.salida.ts), null);
      const monto = Math.round(km * AVO_TARIFA_KM[banda]);
      const { error: errUpdate } = await supabase
        .from('porticos_pasadas_reales')
        .update({ km_estimado: km, monto_avo_estimado: monto })
        .eq('id', viaje.salida.id);
      if (errUpdate) { console.log(`[avo-km] Error actualizando ${viaje.salida.id}: ${errUpdate.message}`); continue; }
      console.log(`[avo-km] ${vehiculo.patente}: viaje AVO ${viaje.entrada.ts} → ${viaje.salida.ts}, ${km}km, banda ${banda}, $${monto} estimado.`);
    }
  }
}

// Recorrido GPS completo por día (2026-10-14, pedido del usuario: el mapa
// del portal solo conectaba los pórticos detectados con líneas rectas,
// porque nunca se guardaba el track GPS completo -- solo lo que matchea un
// pórtico del catálogo). Guarda en porticos_recorrido_diario, downsampled
// (no cada ping de 30s) para no crecer sin límite. Reutiliza los MISMOS
// puntos que ya pide el loop de detección -- cero consultas extra a
// TrackGTS.
const DOWNSAMPLE_DISTANCIA_M = 80;
const DOWNSAMPLE_TIEMPO_MS = 60_000;
const RECORRIDO_MAX_PUNTOS_POR_DIA = 3000; // tope defensivo, no debería acercarse con el downsample de arriba

function diaChile(fecha) {
  const p = partesChile(fecha);
  return `${p.year}-${p.month}-${p.day}`;
}

// Conserva un punto si pasaron >= DOWNSAMPLE_DISTANCIA_M o >=
// DOWNSAMPLE_TIEMPO_MS desde el último conservado -- alcanza para que la
// línea del mapa siga la forma real de la vía sin guardar cada ping.
// Siempre conserva el primer y último punto del lote.
function downsamplePuntos(puntos) {
  if (puntos.length <= 2) return puntos;
  const resultado = [puntos[0]];
  let ultimo = puntos[0];
  for (let i = 1; i < puntos.length - 1; i++) {
    const p = puntos[i];
    const d = haversineMetros(ultimo.lat, ultimo.lon, p.lat, p.lon);
    const t = p.time.getTime() - ultimo.time.getTime();
    if (d >= DOWNSAMPLE_DISTANCIA_M || t >= DOWNSAMPLE_TIEMPO_MS) { resultado.push(p); ultimo = p; }
  }
  resultado.push(puntos[puntos.length - 1]);
  return resultado;
}

async function guardarRecorridoDiario(vehiculoId, dispositivo, puntos) {
  if (!puntos.length) return;
  const porDia = new Map();
  for (const p of puntos) {
    const dia = diaChile(p.time);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(p);
  }
  for (const [dia, puntosDelDia] of porDia) {
    const { data: existente, error: errLeer } = await supabase
      .from('porticos_recorrido_diario')
      .select('puntos')
      .eq('vehiculo_id', vehiculoId).eq('dispositivo', dispositivo).eq('dia', dia)
      .maybeSingle();
    if (errLeer) { console.log(`[recorrido] Error leyendo recorrido previo de ${dia}: ${errLeer.message}`); continue; }

    const previos = (existente?.puntos || []).map((p) => ({ lat: p.lat, lon: p.lon, time: new Date(p.ts) }));
    const nuevos = puntosDelDia.map((p) => ({ lat: p.lat, lon: p.lon, time: p.time }));
    const combinados = [...previos, ...nuevos].sort((a, b) => a.time - b.time);
    // Dedupe por ts exacto (mismo punto ya guardado de una corrida anterior,
    // por el solape de 5 min) antes de volver a aplicar el downsample sobre
    // el conjunto combinado completo.
    const sinDuplicados = [];
    let ultimoTs = null;
    for (const p of combinados) {
      const ts = p.time.getTime();
      if (ts === ultimoTs) continue;
      sinDuplicados.push(p);
      ultimoTs = ts;
    }
    const final = downsamplePuntos(sinDuplicados).slice(-RECORRIDO_MAX_PUNTOS_POR_DIA);
    const puntosParaGuardar = final.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.time.toISOString() }));

    const { error: errGuardar } = await supabase
      .from('porticos_recorrido_diario')
      .upsert(
        { vehiculo_id: vehiculoId, dispositivo, dia, puntos: puntosParaGuardar, actualizado_en: new Date().toISOString() },
        { onConflict: 'vehiculo_id,dispositivo,dia' }
      );
    if (errGuardar) console.log(`[recorrido] Error guardando recorrido ${dia}: ${errGuardar.message}`);
  }
}

// "Alerta de pórtico desconocido" (2026-10-14, optimización post-piloto AGP):
// si un vehículo viaja a velocidad de autopista por un tramo largo sin que
// NINGÚN pórtico del catálogo quede cerca en todo el tramo, es una señal de
// que puede estar en una autopista tarificada que todavía no tenemos
// catalogada -- exactamente el tipo de hueco que esta semana solo se
// descubrió porque AGP lo cruzó a mano (faltaban Ruta del Maipo/Maule/Ruta
// 78 enteras). Reutiliza los MISMOS puntos GPS que ya pide el loop de
// detección normal (cero consultas extra a TrackGTS) -- es deliberadamente
// una heurística gruesa (margen de 3x el radio normal de geocerca, "¿hay
// ALGO catalogado cerca de este tramo?", no una detección fina) para no
// generar ruido por cada pequeño hueco de cobertura dentro de un corredor
// que sí conocemos.
const UMBRAL_VELOCIDAD_DESCONOCIDO_KMH = 70;
const DISTANCIA_MIN_TRAMO_DESCONOCIDO_M = 2000;
const MARGEN_CERCANIA_CATALOGO_M = RADIO_GEOCERCA_M * 3;

function buscarTramosDesconocidos(puntos, patente, dispositivo) {
  let inicioTramo = null, finTramo = null, distanciaTramo = 0, tieneCercania = false;

  function cerrarTramoSiAplica() {
    if (inicioTramo && !tieneCercania && distanciaTramo >= DISTANCIA_MIN_TRAMO_DESCONOCIDO_M) {
      console.log(`[porticos][desconocido] ⚠️ ${patente} (${dispositivo}): tramo de ${Math.round(distanciaTramo / 1000 * 10) / 10}km a velocidad de autopista (${fmtTL(inicioTramo.time)} → ${fmtTL(finTramo.time)}) sin NINGÚN pórtico catalogado cerca -- posible autopista tarificada sin catálogo. Punto de inicio: ${inicioTramo.lat},${inicioTramo.lon}`);
    }
    inicioTramo = null; finTramo = null; distanciaTramo = 0; tieneCercania = false;
  }

  for (let i = 1; i < puntos.length; i++) {
    const anterior = puntos[i - 1], p = puntos[i];
    if (p.speed == null || p.speed < UMBRAL_VELOCIDAD_DESCONOCIDO_KMH) { cerrarTramoSiAplica(); continue; }
    if (!inicioTramo) inicioTramo = anterior;
    distanciaTramo += haversineMetros(anterior.lat, anterior.lon, p.lat, p.lon);
    finTramo = p;
    if (!tieneCercania && PORTICOS.some((portico) => haversineMetros(p.lat, p.lon, portico.lat, portico.lon) <= MARGEN_CERCANIA_CATALOGO_M)) {
      tieneCercania = true;
    }
  }
  cerrarTramoSiAplica();
}

async function main() {
  const { TL_USER, TL_PASSWORD, TL_DOMAIN } = process.env;
  if (!TL_USER || !TL_PASSWORD || !TL_DOMAIN) throw new Error('Faltan TL_USER, TL_PASSWORD o TL_DOMAIN');

  const tlchileDisponible = await intentarReservarTlchile();
  if (!tlchileDisponible) {
    console.log('⏭️  Omitido: la cuenta tlchile fue usada hace menos de 20 min (candado activo).');
    return;
  }

  // Catálogo de pórticos/tarifas — lectura independiente a la sesión TL, no
  // afecta Santa Marta ni el resto de este bloque si falla (usa el fallback
  // hardcodeado de arriba y sigue).
  try {
    const catalogo = await cargarCatalogoPorticos();
    PORTICOS = catalogo.porticos;
    TARIFAS = catalogo.tarifas;
    VENTANAS_PUNTA_PORTICO = catalogo.ventanasPunta;
    VENTANAS_SATURACION_PORTICO = catalogo.ventanasSaturacion;
    console.log(`[catálogo] cargado desde Supabase (${PORTICOS.length} pórticos)`);
  } catch (err) {
    console.warn('[catálogo] no se pudo cargar porticos_catalogo desde Supabase, uso fallback hardcodeado:', err.message);
  }

  // --- Modo backfill (opcional, 2026-10-14) -------------------------------
  // Reprocesa un rango histórico fijo para un subconjunto de patentes, en vez
  // del rolling-window normal por checkpoint. Pedido real: AGP reportó pasadas
  // mal detectadas del 8 al 13 de octubre (coordenadas corregidas DESPUÉS de
  // que esas pasadas ya habían quedado mal guardadas) -- las correcciones de
  // catálogo aplican solo de ahí en adelante, no reprocesan solas lo viejo.
  // Solo se activa si las 3 env vars están puestas (nunca por accidente en la
  // corrida normal de cada 30 min). NO toca Santa Marta ni ningún checkpoint
  // (ni Santa Marta ni pórticos ni TLCHILE_LAST_SUCCESS) para no desalinear el
  // rolling sync real -- quien dispare esto debe borrar a mano, ANTES de
  // correr, las filas viejas de porticos_pasadas_reales/porticos_comparacion_metodos
  // del rango+patentes que va a reprocesar (si no, additiva: el upsert por
  // ts+codigo no pisa una pasada vieja que haya quedado con otro código).
  const { BACKFILL_DESDE, BACKFILL_HASTA, BACKFILL_PATENTES } = process.env;
  const esBackfill = Boolean(BACKFILL_DESDE && BACKFILL_HASTA && BACKFILL_PATENTES);
  const patentesBackfill = esBackfill ? BACKFILL_PATENTES.split(',').map((p) => p.trim()) : null;
  if (esBackfill) console.log(`[backfill] Activo: ${BACKFILL_DESDE} → ${BACKFILL_HASTA}, patentes: ${patentesBackfill.join(', ')}. Sin Santa Marta, sin tocar checkpoints.`);

  // --- 1) Una sola sesión clásica: Santa Marta + Pórticos juntos -----------
  const vehiculosPorticosTodos = await obtenerVehiculosPorticos();
  const vehiculosPorticos = esBackfill
    ? vehiculosPorticosTodos.filter((v) => patentesBackfill.includes(v.patente))
    : vehiculosPorticosTodos;
  if (esBackfill && !vehiculosPorticos.length) throw new Error(`[backfill] Ninguna patente de BACKFILL_PATENTES (${BACKFILL_PATENTES}) encontrada en porticos_vehiculos`);

  const santamartaCheckpoint = esBackfill ? null : await obtenerCheckpoint(SANTAMARTA_CHECKPOINT_KEY, 2 * 60 * 60_000);
  const porticosCheckpoint = esBackfill ? null : await obtenerCheckpoint(PORTICOS_CHECKPOINT_KEY, 2 * 60 * 60_000);
  const OVERLAP_MS = 5 * 60_000;
  const ahora = esBackfill ? new Date(BACKFILL_HASTA) : new Date();
  let start = esBackfill
    ? new Date(BACKFILL_DESDE)
    : new Date(Math.min(santamartaCheckpoint.getTime(), porticosCheckpoint.getTime()) - OVERLAP_MS);

  // Alta con backfill automático (2026-10-14): si algún vehículo tiene
  // backfill_pendiente_desde (seteado al agregarlo, ver
  // agregarVehiculoPorticosAction en el portal), se extiende el inicio de la
  // consulta hasta ahí -- así no hace falta un backfill manual cuando la
  // instalación física fue antes del alta en Supabase (bug real: 18
  // tránsitos perdidos de VHRX66/TTXR82, 2026-10-09). La flag se limpia más
  // abajo recién si esta corrida termina bien. Tope de 14 días: una fecha
  // más vieja probablemente es un error de tipeo o necesita revisión manual,
  // no que la corrida de cada 30 min intente sola (arriesga el timeout de
  // 10 min del job con un reportTravel demasiado grande).
  const TOPE_BACKFILL_AUTOMATICO_MS = 14 * 24 * 60 * 60 * 1000;
  const vehiculosConBackfillPendiente = [];
  if (!esBackfill) {
    for (const v of vehiculosPorticos) {
      if (!v.backfill_pendiente_desde) continue;
      const desdeMs = new Date(v.backfill_pendiente_desde).getTime();
      if (desdeMs >= start.getTime()) { vehiculosConBackfillPendiente.push(v); continue; } // ya cubierto, solo falta limpiar la flag
      if (Date.now() - desdeMs > TOPE_BACKFILL_AUTOMATICO_MS) {
        console.log(`[backfill-auto] ⚠️ ${v.patente}: backfill_pendiente_desde (${fmtTL(new Date(desdeMs))}) supera el tope de 14 días -- requiere backfill manual, no se extiende la ventana sola.`);
        continue;
      }
      console.log(`[backfill-auto] ${v.patente}: extendiendo inicio de consulta a ${fmtTL(new Date(desdeMs))} (alta con instalación anterior).`);
      start = new Date(desdeMs);
      vehiculosConBackfillPendiente.push(v);
    }
  }

  const unidadesDeteccion = obtenerUnidadesDeteccion(vehiculosPorticos);

  const unitIds = [
    ...(esBackfill ? [] : UNIDADES_SANTAMARTA.map((u) => u.unitId)),
    ...unidadesDeteccion.map((u) => u.unitId),
  ].join(',');

  console.log(`=== Sync tlchile${esBackfill ? ' [BACKFILL]' : ''}: ${fmtTL(start)} → ${fmtTL(ahora)} (${esBackfill ? 0 : UNIDADES_SANTAMARTA.length} Santa Marta + ${unidadesDeteccion.length} pórticos [${vehiculosPorticos.length} vehículos]) ===`);

  const aniosEnRango = new Set();
  for (let a = start.getUTCFullYear(); a <= ahora.getUTCFullYear(); a++) aniosEnRango.add(a);
  await cargarFeriadosChile([...aniosEnRango]);

  // Todo lo que sigue depende de `rows` -- si loginYConsultarTravel agota
  // sus reintentos, NO hay nada útil que hacer este ciclo (ni Santa Marta ni
  // pórticos). Antes esto tiraba la excepción hasta afuera y moría todo el
  // proceso con exit 1 -- confirmado real 2026-09-29: TrackGTS devolvió una
  // respuesta con forma de "lista de unidades" en vez del reporte de viaje
  // (Forma inesperada) en los 2 intentos seguidos, glitch de su lado (no de
  // nuestro código), se autorecuperó solo en la corrida siguiente 30 min
  // después. Los checkpoints (santamartaCheckpoint/porticosCheckpoint) recién
  // se guardan más abajo tras procesar `rows` -- no avanzan si este bloque
  // falla, así que la corrida siguiente vuelve a pedir la misma ventana
  // (ampliada) sin perder nada. Se captura acá para que el proceso termine
  // limpio (exit 0) en vez de marcar la corrida entera en rojo por un
  // problema transitorio de TrackGTS que no requiere ninguna acción nuestra.
  let rows;
  try {
    rows = await loginYConsultarTravel({
      TL_USER, TL_PASSWORD, TL_DOMAIN,
      startDate: fmtTL(start), endDate: fmtTL(ahora),
      unitIds,
    });
  } catch (err) {
    console.warn(`[travel] ⚠️ No se pudo obtener el reporte de viaje tras reintentar (${err.message}) -- se salta este ciclo, la próxima corrida (30 min) reintenta con ventana ampliada. Sin acción nuestra pendiente salvo que se repita seguido.`);
    return;
  }
  console.log(`[travel] ${rows.length} posiciones GPS recibidas (todas las unidades)`);
  // Diagnóstico temporal 2026-09-03, ampliado 2026-09-21: rows[0] es
  // cualquier unidad al azar (la primera cronológicamente entre TODAS las
  // de Santa Marta + pórticos mezcladas) -- para confirmar qué campos
  // manda TrackGTS específicamente por CADA dispositivo de un vehículo con
  // comparación GV58LAU/FTC927 (no alcanza con una muestra genérica, un
  // modelo de tracker puede no soportar un campo que otro sí), se busca
  // una fila de ejemplo por cada unitId de unidadesDeteccion. Quitar (o
  // dejar solo rows[0]) una vez que se confirme que ambos dispositivos
  // mandan lo mismo de forma consistente.
  if (rows.length) console.log('[travel][diagnóstico] claves de una fila:', JSON.stringify(rows[0]));
  for (const unidad of unidadesDeteccion) {
    const fila = rows.find((r) => r.unitIdA0 === unidad.unitId);
    console.log(
      `[travel][diagnóstico] ${unidad.vehiculo.patente} (${unidad.dispositivo}, unitId ${unidad.unitId}):`,
      fila ? JSON.stringify(fila) : 'sin posiciones en este rango'
    );
  }

  // --- Santa Marta -----------------------------------------------------------
  // Se salta ENTERO en modo backfill (ver arriba): unitIds ni siquiera pide
  // sus unidades, y no se toca su checkpoint para no desalinear el sync real.
  const porUnitIdSantaMarta = new Map(UNIDADES_SANTAMARTA.map((u) => [u.unitId, u]));
  const registrosSantaMarta = esBackfill ? [] : rows
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
        // Confirmado en vivo 2026-09-02: Horómetro/Odómetro vienen null cuando
        // msgTypeC0 es un evento (DOS10/DOS11/IDA/GEO-A/SPD) en vez de una
        // lectura periódica real (POS-T/POS-H/IGN/IGF) — no es un bug nuestro,
        // es la propia plataforma. Se guarda el tipo para que el cliente pueda
        // distinguir "sin dato real" de "falló la sincronización".
        'Tipo de Mensaje': r.msgTypeC0 ?? null,
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
  if (!esBackfill) await guardarCheckpoint(SANTAMARTA_CHECKPOINT_KEY, ahora);

  // --- Pórticos --------------------------------------------------------------
  const porUnitIdPorticos = new Map(unidadesDeteccion.map((u) => [u.unitId, u]));
  // Puntos por (vehiculo, dispositivo) — aísla los dos tracks de un mismo
  // vehículo cuando tiene dispositivo secundario (ver obtenerUnidadesDeteccion).
  const puntosPorUnidad = new Map();
  // Puntos SOLO del dispositivo principal, igual que antes de este cambio —
  // lo siguen usando actualizarOdometroDiario/estimarCobroAVO más abajo, que
  // no tienen ningún concepto de "dispositivo secundario" (odómetro/AVO son
  // del vehículo, no de cada GPS, así que se calculan una sola vez).
  const puntosPorVehiculo = new Map();
  for (const r of rows) {
    const unidad = porUnitIdPorticos.get(r.unitIdA0);
    if (!unidad) continue;
    const claveUnidad = `${unidad.vehiculo.id}|${unidad.dispositivo}`;
    if (!puntosPorUnidad.has(claveUnidad)) puntosPorUnidad.set(claveUnidad, []);
    const punto = {
      time: new Date(r.gpsUtcTimeC13.replace(' ', 'T') + 'Z'),
      lat: r.latC12, lon: r.lonC11, speed: r.speedC8 || 0, odometro: r.odometerC14, hdop: r.hdopC7,
      // msgType (IGN=motor encendido, IGF=motor apagado, POS-T/POS-H=posición
      // periódica) -- ya se traía para Santa Marta pero nunca se capturaba
      // acá. Se usa para el filtro genérico de "se apagó el motor cerca de
      // este pórtico" (ver hayApagadoCercaDelPortico más abajo).
      msgType: r.msgTypeC0,
      // ignState (booleano, viene en TODOS los puntos, no solo en el evento
      // de transición IGN/IGF) -- confirmado 2026-09-21 vía el diagnóstico
      // de claves crudas (ignStateC41). Más robusto que depender solo del
      // mensaje IGF: si el mensaje de transición no cae dentro de la
      // ventana de esta corrida (ej. el motor ya estaba apagado antes del
      // inicio del rango consultado), el estado sigue disponible en cada
      // lectura periódica igual.
      ignState: r.ignStateC41,
      // heading (rumbo real del dispositivo, 0-360°) -- confirmado
      // 2026-09-21 (headingC9). Capturado pero TODAVÍA NO USADO en la
      // detección; sirve para reforzar resolverCodigoDireccional (hoy
      // infiere dirección solo del delta entre dos puntos GPS, ruidoso a
      // baja velocidad) una vez validado en paralelo contra pasadas ya
      // confirmadas.
      heading: r.headingC9,
      // altitud (metros, altitudeC10) -- confirmado que TrackGTS la manda
      // desde 2026-09-21 pero nunca se había capturado. Caso real 2026-09-29
      // (VVJG-14): PC101 (Túnel San Cristóbal) y P201 (AVO, ramal a Ciudad
      // Empresarial) se dispararon como falsos positivos porque en ese nudo
      // vial (Viaducto El Salto) la autopista AVO pasa por un viaducto
      // ELEVADO justo por encima del túnel y de la rampa -- misma
      // coordenada 2D, nivel físico distinto. Ninguna comparación de
      // lat/lon (radio, calzada real, clase de vía) puede distinguir eso;
      // la altitud sí debería, una vez calibrada con cruces reales. Ver
      // altitudCoincideConNivel (pendiente, necesita datos para calibrar).
      altitud: r.altitudeC10,
    };
    puntosPorUnidad.get(claveUnidad).push(punto);
    if (unidad.dispositivo === 'principal') {
      if (!puntosPorVehiculo.has(unidad.vehiculo.id)) puntosPorVehiculo.set(unidad.vehiculo.id, []);
      puntosPorVehiculo.get(unidad.vehiculo.id).push(punto);
    }
  }

  // Si el vehículo queda estacionado/detenido cerca de un pórtico (ej. su
  // destino final queda al lado), cada corrida futura volvía a "detectar"
  // el mismo pórtico una y otra vez (el dedup de MIN_GAP_MS solo mira dentro
  // de la corrida actual, no recuerda corridas anteriores) — generaba
  // pasadas y notificaciones de Telegram falsas mientras el auto seguía
  // parado ahí. Por eso antes de detectar se consulta cuándo fue la ÚLTIMA
  // pasada real ya guardada de cada vehículo+pórtico, y no se vuelve a
  // contar si pasaron menos de VENTANA_MISMA_PASADA_MS desde esa última vez.
  // Bajado de 3h a 20min 2026-10-14: 3h bloqueaba pasadas reales separadas del
  // mismo código el mismo día (confirmado real con TTXR-82 13-oct: cruce real
  // a las 12:03 bloqueado por un candidato dudoso -- ni siquiera confirmado --
  // de las 10:51). El dedup de pings consecutivos del MISMO cruce ya lo cubre
  // MIN_GAP_MS (2 min) aparte, así que 3h era mucho más de lo necesario.
  const VENTANA_MISMA_PASADA_MS = 20 * 60 * 1000; // 20 minutos

  // Se lee una sola vez por corrida (no por vehículo) — no cambia entre
  // vehículos y no vale la pena una consulta repetida por cada uno.
  const gatesEmpiricos = await obtenerGatesEmpiricos();

  let totalDetecciones = 0;
  for (const unidad of unidadesDeteccion) {
    const vehiculo = unidad.vehiculo;
    const dispositivo = unidad.dispositivo;
    const puntosTotales = puntosPorUnidad.get(`${vehiculo.id}|${dispositivo}`) || [];
    // hdop=0 = posición "Guardado" (caché de TrackGTS, no un fix GPS real) —
    // misma convención que usa su propio reporte de historial de posiciones
    // para pintar "Guardado" vs "OK" (ver getGPSStatus en su código fuente,
    // investigado 2026-09-03 tras confirmar con el usuario que VVJG-14
    // registró 10 pórticos falsos de 4 concesionarias distintas mientras el
    // auto estaba estacionado en casa con el motor apagado). p.hdop es
    // undefined si el campo no viene en la respuesta — ahí NO se filtra
    // (!== 0 deja pasar undefined), así que esto no rompe nada si la
    // hipótesis resulta incorrecta, solo deja de proteger.
    const puntosDescartadosPorHdop = puntosTotales.filter((p) => p.hdop === 0).length;
    if (puntosDescartadosPorHdop) console.log(`[porticos] ${vehiculo.patente} (${dispositivo}): ${puntosDescartadosPorHdop} puntos descartados por hdop=0 (posición en caché, no GPS real).`);
    const puntos = puntosTotales
      .filter((p) => p.lat && p.lon && !isNaN(p.time) && p.hdop !== 0)
      .sort((a, b) => a.time - b.time);
    console.log(`[porticos] ${vehiculo.patente} (${dispositivo}): ${puntos.length} puntos GPS válidos`);
    buscarTramosDesconocidos(puntos, vehiculo.patente, dispositivo);
    await guardarRecorridoDiario(vehiculo.id, dispositivo, puntos);

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
      .eq('dispositivo', dispositivo)
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
        .eq('dispositivo', dispositivo)
        .eq('confirmado', false)
        .gte('ts', new Date(Date.now() - VENTANA_ESTACIONADO_MS).toISOString());
      if (errPendientes) throw new Error(`Error leyendo pasadas pendientes de ${vehiculo.patente}: ${errPendientes.message}`);
      for (const pendiente of pendientes || []) {
        if (!hayPuntoFueraDelRadio(puntos, pendiente.lat, pendiente.lon)) continue;
        const grupoPendiente = GRUPO_GEOMETRIA_POR_CODIGO_INTERURBANO[pendiente.portico_codigo] || GRUPO_GEOMETRIA_POR_CONCESIONARIA[pendiente.concesionaria] || null;
        if (
          requiereConfirmarCalzadaPrincipal(grupoPendiente, pendiente.lat, pendiente.lon) &&
          !hayPuntoCercaDeCalzadaPrincipal(puntos, grupoPendiente, new Date(pendiente.ts).getTime())
        ) continue; // todavía no hay un punto que confirme que llegó a la calzada principal — reintentar la próxima corrida
        // Hecho espacial del punto ya guardado, no va a cambiar reintentando
        // -- se queda pendiente para siempre (nunca se notifica/factura),
        // igual que un falso positivo conocido. Ver esMasCercaDeCaleteraQueDeAutopista.
        if (esMasCercaDeCaleteraQueDeAutopista(grupoPendiente, pendiente.lat, pendiente.lon)) continue;
        const { error: errConfirmar } = await supabase
          .from('porticos_pasadas_reales')
          .update({ confirmado: true })
          .eq('id', pendiente.id);
        if (errConfirmar) { console.log(`[porticos] Error confirmando pasada pendiente de ${vehiculo.patente}: ${errConfirmar.message}`); continue; }
        console.log(`[porticos] ✅ ${vehiculo.patente} (${dispositivo}): pasada pendiente de ${pendiente.portico_codigo} (${fmtTL(new Date(pendiente.ts))}) confirmada esta corrida.`);
        // Telegram solo para el dispositivo principal (ver mismo criterio más abajo).
        if (dispositivo === 'principal' && PATENTES_NOTIFICAR_TELEGRAM.includes(vehiculo.patente)) {
          await notificarTelegram(mensajePasada(vehiculo.patente, pendiente));
        }
      }
    }

    // Método nuevo, capa 3 (trayectoria, no posición): velocidad mínima en
    // los VENTANA_VELOCIDAD_PREVIA_MS previos al candidato. Una autopista
    // tarificada es de flujo libre/segregado (sin semáforos ni cruces) — un
    // tránsito real debería mantenerse en rango de autopista todo ese tramo.
    // Una calle local o rampa de acceso muestra baches de velocidad baja por
    // intersecciones aunque geométricamente pase muy cerca del pórtico (caso
    // real 4.2/Vicuña Mackenna, 2026-09-08: 82km/h sostenido en el cruce real
    // vs 20-25km/h en la caletera, con la posición casi idéntica entre
    // ambos — ninguna de las capas 1/2 por sí sola distingue este caso).
    // Puramente observacional por ahora, igual que capas 1 y 2.
    const VENTANA_VELOCIDAD_PREVIA_MS = 2 * 60 * 1000;
    function velocidadMinimaEnVentana(puntosDelVehiculo, indice) {
      const tsActual = puntosDelVehiculo[indice].time.getTime();
      let min = null;
      let n = 0;
      for (let j = indice; j >= 0; j--) {
        if (tsActual - puntosDelVehiculo[j].time.getTime() > VENTANA_VELOCIDAD_PREVIA_MS) break;
        min = min == null ? puntosDelVehiculo[j].speed : Math.min(min, puntosDelVehiculo[j].speed);
        n++;
      }
      return n > 0 ? min : null;
    }

    const detecciones = [];
    // Método NUEVO en paralelo (ver map-matching.js): por cada candidato
    // dentro del radio de 150m, se registra ADEMÁS la distancia real a la
    // calzada del corredor (map-matching contra geometría OSM) — sin
    // cambiar en nada la detección actual. Se guarda en una tabla aparte
    // (porticos_comparacion_metodos) solo para comparar los dos métodos
    // antes de que el nuevo reemplace al de radio.
    const comparaciones = [];
    let ultimoPortico = null;
    let ultimoTs = null;
    let ultimoPuntoValido = null;
    const direccionVigentePorPortico = new Map();
    for (let i = 0; i < puntos.length; i++) {
      const p = puntos[i];
      // Salto de posición imposible: si el tramo desde el último punto que sí
      // pasó este chequeo implica una velocidad irreal, esta lectura es
      // sospechosa (dato corrupto/cacheado de TrackGTS, no necesariamente un
      // tránsito real) y se descarta ENTERA — no solo se ignora contra el
      // pórtico más cercano, para no arrastrar el punto malo como "anterior"
      // del siguiente. Confirmado 2026-08-02: VVJG-14 registró 6 pórticos de
      // 4 concesionarias distintas en 35 min con el auto ya estacionado en
      // casa según el reporte de posiciones real — este filtro no habría
      // agarrado ESE caso puntual (el salto ahí implicaba una velocidad
      // creíble, ~40 km/h en línea recta), pero sí cubre el caso más simple
      // de una lectura suelta con coordenada corrupta.
      const anterior = ultimoPuntoValido;
      if (anterior) {
        const distanciaKm = haversineMetros(anterior.lat, anterior.lon, p.lat, p.lon) / 1000;
        const horas = (p.time.getTime() - anterior.time.getTime()) / 3_600_000;
        const kmh = horas > 0 ? distanciaKm / horas : (distanciaKm > 0.05 ? Infinity : 0);
        if (kmh > VELOCIDAD_MAX_PLAUSIBLE_KMH) {
          console.log(`[porticos] ⚠️ ${vehiculo.patente}: salto GPS descartado (${distanciaKm.toFixed(1)}km en ${(horas * 60).toFixed(1)}min ≈ ${kmh === Infinity ? '∞' : kmh.toFixed(0)} km/h) entre ${fmtTL(anterior.time)} y ${fmtTL(p.time)} — no se usa para detectar pórticos.`);
          continue;
        }
      }
      ultimoPuntoValido = p;
      for (const portico of PORTICOS) {
        // puntoCruce: el punto de máxima cercanía sobre el TRAMO GPS
        // anterior→actual, no la lectura p cruda — dos pasadas confirmadas
        // del mismo pórtico pueden tener su lectura p a >400m entre sí (dos
        // pings de 30-60s a velocidad de autopista) aunque ambas hayan
        // pasado igual de cerca del pórtico. Guardar el punto interpolado en
        // vez del ping crudo es lo que hace que lat/lon sirvan como ancla
        // empírica del pórtico (ver empirical gates, capa 2 del map-matching).
        const { d, puntoCruce } = anterior
          ? (() => {
              const r = puntoMasCercanoEnSegmento(portico.lat, portico.lon, anterior.lat, anterior.lon, p.lat, p.lon);
              return { d: r.distancia, puntoCruce: { lat: r.lat, lon: r.lon } };
            })()
          : { d: haversineMetros(p.lat, p.lon, portico.lat, portico.lon), puntoCruce: { lat: p.lat, lon: p.lon } };
        if (d <= RADIO_GEOCERCA_M) {
          const tsMs = p.time.getTime();
          // "Lock" direccional (2026-10-16, caso real TTXR-82 09-oct PA13/PA14
          // detectados al mismo segundo, reportado por AGP): un solo ping con
          // ruido GPS cerca del gantry puede invertir el signo de la tendencia
          // lat/lon de un punto a otro aunque la tendencia NETA del cruce sea
          // clarísima (en ese caso, 13 puntos seguidos bajando en latitud --
          // uno solo habría bastado para "voltear" el signo e inventar un
          // segundo tránsito en sentido contrario). Una vez resuelta la
          // dirección para esta racha de cruce (mismo pórtico, sin gap mayor a
          // MIN_GAP_MS entre pings), se mantiene fija en vez de recalcularse en
          // cada punto -- la primera resolución de la racha es la más
          // confiable (el vehículo recién entra al radio, el delta es grande).
          const vigente = direccionVigentePorPortico.get(portico.codigo);
          const resuelto = vigente && tsMs - vigente.tsMs <= MIN_GAP_MS
            ? vigente.resuelto
            : resolverCodigoDireccional(portico, anterior, p);
          direccionVigentePorPortico.set(portico.codigo, { resuelto, tsMs });
          // Cruce en el sentido que este gantry no cobra (ver SENTIDO_UNICO)
          // -- no es candidato, ni siquiera para porticos_comparacion_metodos.
          if (!cumpleSentidoUnico(resuelto.codigo, anterior, p)) continue;
          const sentido = calcularSentido(resuelto.codigo, anterior, p);
          const esNuevoEnEstaCorrida = resuelto.codigo !== ultimoPortico || !ultimoTs || tsMs - ultimoTs > MIN_GAP_MS;
          if (esNuevoEnEstaCorrida) {
            const resueltoPorRumbo = resolverCodigoDireccionalPorRumbo(portico, p.heading);
            if (resueltoPorRumbo && resueltoPorRumbo.codigo !== resuelto.codigo) {
              console.log(`[porticos][rumbo] ⚠️ ${vehiculo.patente} (${dispositivo}): delta-posición dice ${resuelto.codigo}, rumbo (${p.heading}°) dice ${resueltoPorRumbo.codigo} -- ${fmtTL(p.time)}, velocidad ${p.speed} km/h.`);
            }
          }
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
          const velocidadMinima = VELOCIDAD_MINIMA_PORTICO[resuelto.codigo];
          const cumpleVelocidadMinima = velocidadMinima == null || p.speed >= velocidadMinima;
          // Filtro genérico de "se estacionó acá" (2026-09-21): distinto de
          // FALSOS_POSITIVOS_CONOCIDOS (que es una lista curada a mano por
          // patente+pórtico, no escala a clientes nuevos) -- este no depende
          // de qué vehículo ni de qué pórtico sea. Confirmado con el caso
          // real de P11/P10 (oficina de VVJG-14): el candidato cae dentro
          // del radio justo cuando el motor se apaga (evento IGF) y el auto
          // no vuelve a moverse — nunca ocurre así en un cruce real (nadie
          // apaga el motor en medio de una autopista tarificada). Ver
          // hayApagadoCercaDelPortico más abajo.
          const seApagaElMotorAca = hayApagadoCercaDelPortico(puntos.slice(i), portico);

          // Método nuevo en paralelo: se registra para TODO candidato dentro
          // del radio de 150m, incluso los que el método actual descarta por
          // velocidad/falso-positivo-conocido — así se puede comparar contra
          // esos mismos casos ya investigados a mano (P10, P11, PA17, etc).
          if (esNuevoEnEstaCorrida) {
            comparaciones.push({
              vehiculo_id: vehiculo.id,
              dispositivo,
              ts: p.time.toISOString(),
              portico_codigo: resuelto.codigo,
              concesionaria: portico.concesionaria,
              distancia_punto_m: Math.round(d),
              distancia_calzada_m: (() => {
                const dc = distanciaCalzada(grupoGeometriaPara(portico), puntoCruce.lat, puntoCruce.lon);
                return dc == null ? null : Math.round(dc);
              })(),
              distancia_gate_empirico_m: (() => {
                const gate = gatesEmpiricos.get(resuelto.codigo);
                if (!gate) return null;
                return Math.round(haversineMetros(gate.lat, gate.lon, puntoCruce.lat, puntoCruce.lon));
              })(),
              altitud_m: p.altitud ?? null,
              n_confirmaciones_empiricas: gatesEmpiricos.get(resuelto.codigo)?.n ?? 0,
              velocidad_minima_ventana_previa_kmh: velocidadMinimaEnVentana(puntos, i),
              velocidad_kmh: p.speed,
              metodo_actual_habria_confirmado: esNuevoVsHistorico && !esFalsoPositivoConocido && cumpleVelocidadMinima && !seApagaElMotorAca,
            });
          }

          if (esNuevoEnEstaCorrida && esNuevoVsHistorico && !esFalsoPositivoConocido && cumpleVelocidadMinima && !seApagaElMotorAca) {
            // confirmado: ¿hay ya, en esta misma corrida, algún punto GPS
            // posterior que muestre al vehículo fuera del radio? Un tránsito
            // real en autopista lo confirma casi al toque (siguiente lectura,
            // 30-60s después); si no, queda pendiente y se reintenta en la
            // próxima corrida contra los puntos nuevos (ver "Confirmación
            // diferida" más arriba) — nunca se notifica hasta confirmarse.
            const grupo = grupoGeometriaPara(portico);
            const confirmadoPorRadio = hayPuntoFueraDelRadio(puntos.slice(i + 1), p.lat, p.lon);
            const confirmadoPorCalzada = confirmadoPorRadio
              ? !requiereConfirmarCalzadaPrincipal(grupo, puntoCruce.lat, puntoCruce.lon) ||
                hayPuntoCercaDeCalzadaPrincipal(puntos.slice(i + 1), grupo, tsMs)
              : false; // si ni siquiera salió del radio, ni vale la pena chequear la calzada
            // Capa 3 (ver esMasCercaDeCaleteraQueDeAutopista): sin ventana de
            // tiempo como la rampa -- es un hecho espacial del punto de cruce
            // mismo, no algo que un punto posterior pueda todavía confirmar.
            const noEsCaleteraCercana = !esMasCercaDeCaleteraQueDeAutopista(grupo, puntoCruce.lat, puntoCruce.lon);
            detecciones.push({
              vehiculo_id: vehiculo.id,
              dispositivo,
              ts: p.time.toISOString(),
              portico_codigo: resuelto.codigo,
              concesionaria: portico.concesionaria,
              tramo: resuelto.tramo,
              distancia_m: Math.round(d),
              velocidad_kmh: p.speed,
              lat: puntoCruce.lat,
              lon: puntoCruce.lon,
              confirmado: confirmadoPorRadio && confirmadoPorCalzada && noEsCaleteraCercana,
              sentido,
              altitud_m: p.altitud ?? null,
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
    const deteccionesSinDuplicar = dedupePorClave(detecciones, (d) => `${d.vehiculo_id}|${d.dispositivo}|${d.ts}|${d.portico_codigo}`);
    console.log(`[porticos] ${vehiculo.patente} (${dispositivo}): ${deteccionesSinDuplicar.length} pasadas nuevas detectadas`);
    totalDetecciones += deteccionesSinDuplicar.length;

    // Guardar SIEMPRE las comparaciones del método nuevo, sin importar si
    // este vehículo notifica por Telegram — antes del `continue` de más
    // abajo para que nunca se salte esta parte.
    const comparacionesSinDuplicar = dedupePorClave(comparaciones, (c) => `${c.vehiculo_id}|${c.dispositivo}|${c.ts}|${c.portico_codigo}`);
    if (comparacionesSinDuplicar.length) {
      const { error: errComparacion } = await supabase
        .from('porticos_comparacion_metodos')
        .upsert(comparacionesSinDuplicar, { onConflict: 'vehiculo_id,ts,portico_codigo,dispositivo' });
      if (errComparacion) console.log(`[porticos][comparacion] Error guardando comparación de ${vehiculo.patente} (${dispositivo}): ${errComparacion.message}`);
      else console.log(`[porticos][comparacion] ${vehiculo.patente} (${dispositivo}): ${comparacionesSinDuplicar.length} comparaciones guardadas`);
    }

    if (deteccionesSinDuplicar.length) {
      const { error } = await supabase
        .from('porticos_pasadas_reales')
        // ignoreDuplicates:false (default) = ON CONFLICT DO UPDATE: si esta misma
        // pasada ya estaba guardada (por el solape de 5 min entre corridas, o por
        // haberse insertado con una versión anterior del código) pero le faltaba
        // lat/lon u otro campo, esta corrida la completa sola — sin depender de
        // un rescate manual ni de un login extra a TrackGTS.
        .upsert(deteccionesSinDuplicar, { onConflict: 'vehiculo_id,ts,portico_codigo,dispositivo' });
      if (error) throw new Error(`Error guardando pasadas de ${vehiculo.patente} (${dispositivo}): ${error.message}`);
      console.log(`[porticos] ✅ ${vehiculo.patente} (${dispositivo}): ${deteccionesSinDuplicar.length} pasadas insertadas/verificadas`);

      // Telegram solo para el dispositivo principal — si no, cada pasada real
      // notificaría dos veces (una por dispositivo) mientras dure la
      // comparación GV58LAU/FTC927. El secundario queda igual de completo en
      // la base, solo no duplica el aviso.
      if (dispositivo !== 'principal') continue;
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
  // Limpia backfill_pendiente_desde solo si esta corrida llegó hasta acá sin
  // tirar excepción -- si reportTravel o el guardado fallan antes, la flag
  // queda intacta y la próxima corrida (30 min) reintenta la misma extensión.
  if (vehiculosConBackfillPendiente.length) {
    const ids = vehiculosConBackfillPendiente.map((v) => v.id);
    const { error: errLimpiarBackfill } = await supabase.from('porticos_vehiculos').update({ backfill_pendiente_desde: null }).in('id', ids);
    if (errLimpiarBackfill) console.log(`[backfill-auto] ⚠️ No se pudo limpiar backfill_pendiente_desde: ${errLimpiarBackfill.message}`);
    else console.log(`[backfill-auto] ✅ backfill_pendiente_desde limpiado para: ${vehiculosConBackfillPendiente.map((v) => v.patente).join(', ')}`);
  }
  if (esBackfill) {
    console.log('[backfill] Listo -- se omiten HealthCheck, alias, odómetro diario, AVO y TODOS los checkpoints a propósito (efecto colateral innecesario de una corrida puntual sobre un rango viejo).');
    console.log(`=== Sync tlchile [BACKFILL] completo ===`);
    return;
  }
  await emparejarLecturasManuales(unidadesDeteccion);
  await actualizarOdometroDiario(vehiculosPorticos, puntosPorVehiculo);
  await estimarCobroAVO(vehiculosPorticos, puntosPorVehiculo);
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
