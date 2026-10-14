-- Corrección de coordenadas de porticos_catalogo contra OpenStreetMap
-- (highway=toll_gantry, ref + nombre oficial) y el cruce real de AGP
-- (TTXR82 / VHRX66, 8-13 oct 2026). Acompaña el commit que agrega
-- SENTIDO_UNICO y corrige PARES_DIRECCIONALES en scripts/sync-tlchile.js.
-- Correr en el SQL editor de Supabase. Los alterno (PA6, 5.3, 3.2, 3.4)
-- se actualizan igual aunque no tengan geocerca propia, para que el mapa
-- del dashboard quede consistente.

begin;

-- Autopista Central sur
update porticos_catalogo set lat = -33.596894, lon = -70.715792 where codigo = 'PA37';
update porticos_catalogo set lat = -33.582754, lon = -70.713842 where codigo = 'PA5';
update porticos_catalogo set lat = -33.582412, lon = -70.713975 where codigo = 'PA6';

-- Vespucio Sur
update porticos_catalogo set lat = -33.496067, lon = -70.584502 where codigo = '5.4';
update porticos_catalogo set lat = -33.495558, lon = -70.584456 where codigo = '5.3';
update porticos_catalogo set lat = -33.529790, lon = -70.604845 where codigo = '4.1';
update porticos_catalogo set lat = -33.541153, lon = -70.615020 where codigo = '4.3';
update porticos_catalogo set lat = -33.539608, lon = -70.652943 where codigo = '3.1';
update porticos_catalogo set lat = -33.539842, lon = -70.652997 where codigo = '3.2';
update porticos_catalogo set lat = -33.533585, lon = -70.676345 where codigo = '3.3';
update porticos_catalogo set lat = -33.533816, lon = -70.676451 where codigo = '3.4';

-- Debe devolver 11 filas con las coordenadas nuevas
select codigo, lat, lon from porticos_catalogo
where codigo in ('PA37','PA5','PA6','5.4','5.3','4.1','4.3','3.1','3.2','3.3','3.4')
order by codigo;

commit;
