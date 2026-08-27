import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://lomkolhgmkvshucqjuhf.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvbWtvbGhnbWt2c2h1Y3FqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MDUyNTUsImV4cCI6MjA5MDI4MTI1NX0.I_13jMA2DAa6Jzff4VBQitezdR2kfrXSVacaBn0QZbo"
);

const BASE_URL = "https://tlchile.trackgts.com:8081";
const API_USER = "amelendez";
const API_PASS = "alex2026";

type SyncResult = {
  success: boolean;
  rateLimited?: boolean;
  total?: number;
  message: string;
};

// Candado compartido (Supabase, tabla SyncCheckpoints) entre TODOS los
// procesos que autentican la cuenta "amelendez"/"tlchile" en TrackGTS:
// este cron de Vercel (/api/sync, cada 20 min), sync-historial-santamarta.js
// y sync-porticos.js (ambos en GitHub Actions, vía login clásico). TrackGTS
// bloquea logins seguidos de la MISMA cuenta (~20 min observado) sin importar
// si es por este endpoint REST o por el login clásico del portal — por eso el
// candado es uno solo, compartido entre los tres. Si otro proceso reservó la
// cuenta hace menos de 20 min, este se salta la corrida en vez de chocar.
const TLCHILE_LOCK_KEY = "tlchile_auth_lock";
const TLCHILE_LOCK_WINDOW_MS = 20 * 60_000;

async function intentarReservarTlchile(): Promise<boolean> {
  const { data } = await supabase
    .from("SyncCheckpoints")
    .select("value")
    .eq("key", TLCHILE_LOCK_KEY)
    .maybeSingle();
  const ultimo = data?.value ? new Date(data.value).getTime() : 0;
  if (Date.now() - ultimo < TLCHILE_LOCK_WINDOW_MS) return false;
  await supabase.from("SyncCheckpoints").upsert({ key: TLCHILE_LOCK_KEY, value: new Date().toISOString() });
  return true;
}

async function sincronizar(customer: string, tabla: string): Promise<SyncResult> {
  // PASO 1: Autenticar
  const authRes = await fetch(`${BASE_URL}/api/Authenticate/Auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: API_USER, password: API_PASS, customer }),
  });

  if (authRes.status === 429)
    return { success: false, rateLimited: true, message: `⚠️ Rate limit para ${tabla}. Espera ~20 minutos.` };
  if (!authRes.ok)
    return { success: false, message: `❌ Error de autenticación para ${tabla}.` };

  const authData = await authRes.json();
  const accessToken = authData.data?.accessToken;
  const user = authData.data?.user;
  const retailId = user?.parentCustomerId?.toString();

  if (!accessToken || !retailId)
    return { success: false, message: `❌ No se obtuvo token o retailId para ${tabla}.` };

  // PASO 2: Obtener reporte
  const reportRes = await fetch(`${BASE_URL}/api/HealthCheck/GetReportHealthCheck`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ retailId }),
  });

  if (reportRes.status === 429)
    return { success: false, rateLimited: true, message: `⚠️ Rate limit para ${tabla}. Espera ~20 minutos.` };
  if (!reportRes.ok)
    return { success: false, message: `❌ Error al obtener reporte para ${tabla}.` };

  const reportData = await reportRes.json();
  const unidades = reportData.data ?? [];

  if (!unidades.length)
    return { success: false, message: `❌ La API no devolvió unidades para ${tabla}.` };

  // PASO 3: Upsert a Supabase
  const registros = unidades.map((u: Record<string, unknown>) => ({
    "IMEI":                 u.imei,
    "Unit ID":              u.unitId,
    "Serie":                u.serie,
    "Fecha Ultimo Reporte": u.fechaUltimoReporte,
    "Ubicación":            u.ubicacion,
    "Antigüedad (minutos)": u.antiguedadMinutos,
    "Mensaje":              u.mensaje,
    "EstadoGPS":            u.estadoGPS,
    "EstadoIgnición":       u.estadoIgnicion,
    "EstadoMotor":          u.estadoMotor,
    "Velocidad":            String(u.velocidad ?? ""),
    "Odómetro":             String(u.odometro ?? ""),
    "Horómetro":            u.horometro ?? null, // agregado por GTS al HealthCheck el 2026-08-19
    "VBatExterna":          String(u.vBatExterna ?? ""),
    "%BatExterna":          u.porcentBatInterna,
    "Fabricante AVL":       u.fabricanteAVL,
    "Modelo AVL":           u.modeloAVL,
    "Modelo AVL Ref":       u.modeloAVLRef,
    "Protocolo":            u.protocolo,
    "Teléfono SIM":         u.telefonoSim,
    "Serie SIM":            u.serieSim,
    "GPRS":                 u.gprs,
    "Servicio":             u.servicio,
    "Servicio Comercial":   u.servicioComercial,
    "Serv. Desde":          u.servDesde,
    "Serv. Hasta":          u.servHasta,
    "TipoInstalacion":      u.tipoInstalacion,
    "Alias":                u.alias,
    "Tipo":                 u.tipo,
    "Marca":                u.marca,
    "Modelo":               u.modelo,
    "Año":                  u.anio,
    "Placa":                u.placa,
    "Color":                u.color,
    "Chasis":               u.chasis,
    "Motor":                u.motor,
    "Cliente/Empresa":      u.clienteEmpresa,
    "Cust ID":              u.custId,
    "Nombre":               u.nombre,
    "Apellido":             u.apellido,
    "Direccion":            u.direccion,
    "Pais":                 u.pais,
    "Correo":               u.correo,
    "Usuario":              u.usuario,
    "Telefono":             u.telefono,
    "ClienteAdicional1":    u.clienteAdicional1 ?? "",
    "ClienteAdicional2":    u.clienteAdicional2 ?? "",
    "ClienteAdicional3":    u.clienteAdicional3 ?? "",
    "ClienteAdicional4":    u.clienteAdicional4 ?? "",
  }));

  const { error } = await supabase.from(tabla).upsert(registros, { onConflict: "IMEI" });

  if (error)
    return { success: false, message: `❌ Error al guardar en ${tabla}: ${error.message}` };

  return { success: true, total: unidades.length, message: `✅ ${unidades.length} unidades sincronizadas.` };
}

export async function POST() {
  try {
    const tlchileDisponible = await intentarReservarTlchile();
    const [tracklink, mzd] = await Promise.allSettled([
      tlchileDisponible
        ? sincronizar("tlchile", "Tracklink")
        : Promise.resolve<SyncResult>({
            success: false,
            rateLimited: true,
            message: "⏭️ Omitido: otro proceso (Vercel o GitHub Actions) usó la cuenta tlchile hace menos de 20 min.",
          }),
      sincronizar("mconnect", "MZDConnect"),
    ]);

    const resultTracklink = tracklink.status === "fulfilled"
      ? tracklink.value
      : { success: false, message: "❌ Error inesperado en Tracklink." };

    const resultMZD = mzd.status === "fulfilled"
      ? mzd.value
      : { success: false, message: "❌ Error inesperado en MZDConnect." };

    return NextResponse.json({
      success:     resultTracklink.success && resultMZD.success,
      rateLimited: resultTracklink.rateLimited || resultMZD.rateLimited,
      tracklink:   resultTracklink,
      mzd:         resultMZD,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ success: false, message: `❌ Error: ${message}` }, { status: 500 });
  }
}

// Vercel Cron Job — llamado automáticamente según vercel.json
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return POST();
}
