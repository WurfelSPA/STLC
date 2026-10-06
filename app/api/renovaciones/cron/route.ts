import { NextResponse } from "next/server";
import { ejecutarCampana } from "@/app/lib/renovaciones/campana";
import { modoSimulacion } from "@/app/lib/renovaciones/datos";
import { hoyChile } from "@/app/lib/renovaciones/formato";

// Corrida diaria del Bot de Renovaciones (crear casos + enviar D60/30/20/10/5/0).
// Llamar 1 vez al día en horario hábil (ej. 10:00 Chile) con
// Authorization: Bearer <CRON_SECRET>.
export const maxDuration = 300;

export async function GET(request: Request) {
  const secreto = process.env.CRON_SECRET;
  if (!secreto || request.headers.get("authorization") !== `Bearer ${secreto}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    const resumen = await ejecutarCampana(hoyChile(), modoSimulacion());
    return NextResponse.json({ ok: true, simulacion: modoSimulacion(), resumen });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
