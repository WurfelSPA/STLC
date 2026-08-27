import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://lomkolhgmkvshucqjuhf.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvbWtvbGhnbWt2c2h1Y3FqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MDUyNTUsImV4cCI6MjA5MDI4MTI1NX0.I_13jMA2DAa6Jzff4VBQitezdR2kfrXSVacaBn0QZbo"
);

// Este endpoint ya NO se conecta a TrackGTS en vivo. La cuenta "amelendez"/
// "tlchile" tiene un rate-limit agresivo y TrackGTS no lo va a bajar (ya se
// les pidió varias veces) — así que ahora hay UN solo punto de contacto con
// TrackGTS en todo el proyecto: scripts/sync-tlchile.js, corriendo en GitHub
// Actions. Ese script guarda "Tracklink"/"MZDConnect" en Supabase y deja un
// checkpoint (SyncCheckpoints, key "tlchile_last_success") con la hora de su
// última corrida exitosa. Este endpoint solo LEE ese checkpoint — el botón
// "API actualizar" del panel interno (Navbar.tsx) es de solo lectura.
const TLCHILE_LAST_SUCCESS_KEY = "tlchile_last_success";

export async function POST() {
  try {
    const { data, error } = await supabase
      .from("SyncCheckpoints")
      .select("value")
      .eq("key", TLCHILE_LAST_SUCCESS_KEY)
      .maybeSingle();

    if (error) {
      const msg = `❌ Error leyendo estado: ${error.message}`;
      return NextResponse.json({ success: false, tracklink: { message: msg }, mzd: { message: msg } }, { status: 500 });
    }

    if (!data?.value) {
      const msg = "⏳ Aún no hay ninguna sincronización registrada.";
      return NextResponse.json({ success: false, tracklink: { message: msg }, mzd: { message: msg } });
    }

    const minutos = Math.max(0, Math.round((Date.now() - new Date(data.value).getTime()) / 60_000));
    const msg = `✅ Última sincronización con TrackGTS: hace ${minutos} min.`;
    return NextResponse.json({ success: true, tracklink: { message: msg }, mzd: { message: msg } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    const msg = `❌ Error: ${message}`;
    return NextResponse.json({ success: false, tracklink: { message: msg }, mzd: { message: msg } }, { status: 500 });
  }
}
