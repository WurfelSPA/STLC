# Contexto piloto AGP — sesión 2026-10-13

Resumen para retomar el trabajo en otro PC/sesión de Claude. Usuario: Alex
Meléndez (alex.melendez@tracklink.cl / amelendez@patagonica.cl).

## Repos y despliegue

- **STLC** (`WurfelSPA/STLC`, rama `main`): `scripts/sync-tlchile.js` es el
  detector de pasadas por pórtico (geocerca GPS sobre `reportTravel` de
  TrackGTS). Corre cada 30 min en GitHub Actions ("Sync tlchile", :05 y :35).
  El script es compartido con el cliente Santa Marta: aislar cambios a la
  sección de pórticos.
- **tracklink-porticos-portal** (`WurfelSPA/tracklink-porticos`, rama
  `master`): dashboard (`public/dashboard.html`) + API Next.js en Vercel
  (auto-deploy desde master). `/api/agp/pasadas` con Bearer `AGP_API_KEY`.
- **Supabase** (`lomkolhgmkvshucqjuhf`): `porticos_catalogo` es la FUENTE REAL
  de coordenadas/tarifas en producción. `PORTICOS_FALLBACK`/`TARIFAS_FALLBACK`
  en sync-tlchile.js son solo respaldo: cambiar coordenadas exige actualizar
  la tabla (el código solo no basta). Hay además copias de pórticos/tarifas en
  `dashboard.html` y `app/lib/tarifas.ts` del portal (4 catálogos en total).
- En el PC de la oficina no hay `SUPABASE_SERVICE_ROLE_KEY`; los cambios a la
  base los corrió el usuario en el SQL Editor.

## Qué pasó

AGP (Sergio Hidalgo) cruzó VHRX-66 y TTXR-82 (instalados 8-oct) contra la
concesionaria: Tracklink capturaba 8 de 46 tránsitos confirmados (17 %), meta
del piloto ~1 % de desviación. Archivos de AGP en Descargas:
`transitos_detalle_{TTXR82,VHRX66}_2026-10-08_2026-10-13.pdf`. Historial GPS
completo en `Reporte historial {TTXR82,VHRX66}.xlsx` (hora Chile).

Causas encontradas:
1. Alta tardía: vehículos cargados 9-oct 20:17; no hay backfill automático
   (18 tránsitos). El GPS reportó continuo desde 8-oct 12:34.
2. Catálogo sin interurbanas ni PA1–PA4 (21 tránsitos) — agregado en
   `2878568` (y en Supabase).
3. Pórticos mal ubicados: coordenadas sacadas del track de VVJG-14 y
   "validadas" solo porque el monto calzaba. Corregidas con OSM
   (`highway=toll_gantry`, ref + nombre oficial).
4. Pórticos de un solo sentido cobrados en ambos sentidos.

## Cambios hechos (todo en producción)

- `86729f9` (STLC): `SENTIDO_UNICO` + `cumpleSentidoUnico()`; PA5/PA6 par;
  PA37 reubicado; Vespucio Sur: pares 3.1/3.2 y 3.3/3.4 (estaban cruzados),
  4.1 y 4.3 gantries separados, 5.4 reubicado.
- `53ef0c4` (STLC): Eje Gral. Velásquez PA19–PA28 estaba corrido ~un gantry;
  PA15/PA16 y PA19/PA20 separados (1,4–1,5 km) con sentido único.
- `supabase/porticos_catalogo_fix_osm_2026-10-13.sql`: 22 filas, YA aplicado
  por el usuario. Producción carga 99 pórticos (verificado en el run de 22:35).
- `c87f726` (portal): `/api/pasadas-recientes`, `/api/lecturas-manuales` y el
  panel "Comparación de precisión GV58LAU vs FTC927" solo para admin.
- Supabase (aplicado por el usuario): `amelendez` es_admin=true; VVJG-14
  `cliente_usuario = NULL` (solo admin lo ve); usuario `agp` creado y probado
  (ve solo VHRX-66 y TTXR-82). `AGP_API_KEY` existe en Vercel Production
  (desde 31-ago, token fijo, no caduca).

## Resultado (replay offline, 8–12 oct, vs PDF de AGP)

- 44 de 46 tránsitos confirmados capturados (96 %); 41 con monto exacto.
- Desviación en $ total +1,4 %, pero por vehículo −3,9 % (TTXR-82) y +9,2 %
  (VHRX-66): hay compensación, NO afirmar que se llegó al 1 %.
- Método: copia del loop de detección de sync-tlchile.js alimentada con el
  Excel de historial (hora Chile = UTC−3 en octubre), sin Supabase. Las
  herramientas quedaron en una carpeta temporal del PC de la oficina (no en
  el repo): si se necesitan, reconstruirlas igual.

## Pendientes (por prioridad)

1. **Reprocesar 8–13 oct en `porticos_pasadas_reales`**: la base sigue con las
   pasadas viejas erróneas (ej. sentido contrario del 10-oct) y faltan 8–9 oct;
   la API de AGP los devuelve tal cual. Necesita service key.
2. **Feriados**: no hay manejo en ningún lado (sync, `tarifas.ts`, dashboard).
   12-oct (feriado): urbanas cobraron TBFP (calculamos TBP en 3.4), Ruta 78
   cobró $495 vs $330.
3. Regla `VENTANA_MISMA_PASADA_MS` (3 h) se activa también con detecciones no
   confirmadas y bloquea pasadas reales repetidas (TTXR-82 13-oct PA12 09:02).
   También PA16 13-oct 08:07 quedó sin confirmar a 107 km/h y 22 m.
4. Troncales Gabriela ($621) y Tocornal ($207) de Acceso Sur (Ruta del Maipo):
   sin coordenada confiable (OSM solo tiene las caleteras Oriente/Poniente).
5. Nueva Angostura 9-oct: cobraron $1.000 vs $3.800 (¿tarifa tramo corto?).
6. Tarifas EP/EV de Costanera Norte ~mitad de Smart Report.
7. Coordenadas del mapa en `dashboard.html` desactualizadas (solo visual).

## Reunión con AGP (14-oct)

Página de preparación (privada del usuario):
https://claude.ai/artifact/JD5qqJQgr1DsCnBYm2gYco
Compromisos razonables: reprocesar 8–13 oct, corregir feriados, que AGP
vuelva a medir 14–20 oct. No prometer 1 % ni 100 % de captura.
