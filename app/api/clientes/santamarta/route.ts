import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://lomkolhgmkvshucqjuhf.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvbWtvbGhnbWt2c2h1Y3FqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MDUyNTUsImV4cCI6MjA5MDI4MTI1NX0.I_13jMA2DAa6Jzff4VBQitezdR2kfrXSVacaBn0QZbo"
);

const API_KEY = process.env.SANTAMARTA_API_KEY;

// IMEIs de las unidades de Santa Marta habilitadas para esta API.
const IMEIS_SANTAMARTA = [
  "868589061400860", // CATERPILAR 1250 Bulldozer
  "868589061200856", // KOMATSU 1550 Retroexcavadora
  "868589061490010", // MERCEDES-BENZ-4144-HKSX-54
  "868589061373570", // BULLDOZER-KOMTASU-D155-AC
  "868589061071729", // EXCAVADORA-KOMATSU-1401-PC-220
];

const CHECKPOINT_KEY = "santamarta_delivery";
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000; // si no hay checkpoint ni ?since=: últimas 24h
const MAX_FILAS = 5000; // red de seguridad, no un límite de operación normal

// Historial acumulado (reportTravel) — pedido del cliente 2026-08-24: recibir
// TODO lo nuevo desde su última consulta exitosa, no solo el último dato.
//
// Comportamiento:
//   - Sin ?since=: se usa una marca de agua automática guardada en
//     SyncCheckpoints (key "santamarta_delivery") — cero cambios necesarios
//     del lado del cliente, siguen llamando exactamente igual que siempre.
//   - Con ?since=<ISO>: el cliente controla el checkpoint explícitamente
//     (útil para reintentar sin perder nada si un envío falla de su lado).
//     En ese caso NO se actualiza la marca de agua automática, para no
//     interferir con el flujo por defecto.
async function obtenerHistorial(sinceParam: string | null) {
  let since: string;
  let esAutomatico = false;

  if (sinceParam) {
    const parsed = new Date(sinceParam);
    if (isNaN(parsed.getTime())) {
      return { error: "Parámetro 'since' inválido, debe ser una fecha ISO." };
    }
    since = parsed.toISOString();
  } else {
    esAutomatico = true;
    const { data } = await supabase
      .from("SyncCheckpoints")
      .select("value")
      .eq("key", CHECKPOINT_KEY)
      .maybeSingle();
    since = data?.value ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  }

  const ahora = new Date().toISOString();

  const { data: historial, error } = await supabase
    .from("SantaMartaHistorial")
    .select("*")
    .in("IMEI", IMEIS_SANTAMARTA)
    .gt("gpsUtcTime", since)
    .order("gpsUtcTime", { ascending: true })
    .limit(MAX_FILAS);

  if (error) return { error: error.message };

  if (esAutomatico) {
    await supabase.from("SyncCheckpoints").upsert({ key: CHECKPOINT_KEY, value: ahora });
  }

  return { historial, desde: since, hasta: ahora };
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const key = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!key || key !== API_KEY) {
    return NextResponse.json(
      { error: "No autorizado. Envíe el header 'Authorization: Bearer <key>'." },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const sinceParam = searchParams.get("since");

  const [snapshotRes, historialRes] = await Promise.all([
    supabase.from("Tracklink").select("*").in("IMEI", IMEIS_SANTAMARTA),
    obtenerHistorial(sinceParam),
  ]);

  if (snapshotRes.error) {
    return NextResponse.json({ error: snapshotRes.error.message }, { status: 500 });
  }
  if (historialRes.error) {
    return NextResponse.json({ error: historialRes.error }, { status: 500 });
  }

  return NextResponse.json({
    cliente: "Santa Marta",
    generadoEn: new Date().toISOString(),
    totalUnidades: snapshotRes.data?.length ?? 0,
    unidades: snapshotRes.data,
    historial: historialRes.historial,
    historialDesde: historialRes.desde,
    historialHasta: historialRes.hasta,
  });
}
