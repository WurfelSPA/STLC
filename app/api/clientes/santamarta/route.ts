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
];

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const key = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!key || key !== API_KEY) {
    return NextResponse.json(
      { error: "No autorizado. Envíe el header 'Authorization: Bearer <key>'." },
      { status: 401 }
    );
  }

  const { data, error } = await supabase
    .from("Tracklink")
    .select("*")
    .in("IMEI", IMEIS_SANTAMARTA);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    cliente: "Santa Marta",
    generadoEn: new Date().toISOString(),
    totalUnidades: data?.length ?? 0,
    unidades: data,
  });
}
