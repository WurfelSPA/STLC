> Este archivo lo lee Emily (asistente por voz). Actualízalo al cerrar cada avance.
# Estado — STLC (Tracklink Chile)

**Fecha de actualización:** 2026-10-20

> SENSIBLE: este repo se comparte con clientes reales (Santa Marta, ya validado). Aislar cualquier cambio a la sección de pórticos en `sync-tlchile.js`.

## Resumen
Sistema de Tracklink: scripts de sincronización con TrackGTS (`sync-tlchile.js`, `sync-agp-transitos.js`, `sync-smartreport.js`) por GitHub Actions, detección de pasadas por pórticos con GPS, panel Next.js y el bot de renovaciones por WhatsApp ("Tracky"). El portal de pórticos vive en el repo hermano tracklink-porticos.

## Qué funciona
- Detección de pasadas por pórticos, con feriados chilenos (tarifa de domingo), recorrido GPS diario para el mapa y alerta de pórticos desconocidos.
- Piloto AGP (Lucano Rent a Car, VHRX-66 y TTXR-82): catálogo con PA1-PA4 e interurbanas, Gabriela y Tocornal cerrados, tarifa PA26 TS corregida a 1266.
- Fix de flapping direccional (lock por racha de cruce, 2026-10-16) y limpieza de 184 pasadas fantasma.
- Bot de Renovaciones `/bot-renovaciones` (simulación y piloto WhatsApp con número de prueba de Meta), hitos 60/30/20/10/5/0 días, 3 plantillas Meta.
- Policies anónimas de Supabase cerradas (2026-10-04).

## Pendientes / próximos pasos
- Catálogo: RDM-ANG "tramo corto" sin resolver; RutaPass T3-T10 pendiente.
- Bot: número nuevo dedicado, verificación y plantillas Meta, Trackcity (base y precios), precios de planes especiales; transcripción de audio en standby por decisión del usuario.
- Renovar `AGP_TRANSITOS_TOKEN` (GitHub secret) cuando venza: pedírselo a AGP, dura ~30 días (renovado 2026-10-16).
- Scraping de concesionarias pausado (Vespucio Sur/Costanera Norte/Autopase bloquean login headless).

## Problemas conocidos
- Regla crítica: nunca inventar coordenadas ni tarifas de pórticos.
- Los códigos "alterno" de PARES_DIRECCIONALES nunca llevan geocerca propia (ya duplicó pasadas dos veces).
- Santa Marta, Kadel y Enerfrost usan la misma cuenta TrackGTS: no correr crons a la misma hora.
- El catálogo tiene fuente única en la tabla `porticos_catalogo` (Supabase `lomkolhgmkvshucqjuhf`) con fallback local; mantener ambos sincronizados.

## Dónde está (URL de producción, repo, dependencias)
- Repo: github.com/WurfelSPA/STLC
- Producción: https://tracklink-chile.vercel.app
- Depende de: Vercel, Supabase, TrackGTS, GitHub Actions, Meta WhatsApp Cloud API, Anthropic, AGP (API de tránsitos).
