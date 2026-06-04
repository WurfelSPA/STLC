import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://lomkolhgmkvshucqjuhf.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvbWtvbGhnbWt2c2h1Y3FqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MDUyNTUsImV4cCI6MjA5MDI4MTI1NX0.I_13jMA2DAa6Jzff4VBQitezdR2kfrXSVacaBn0QZbo"
);

const BASE_URL_TRACKLINK = "https://tlchile.trackgts.com:8081";
const BASE_URL_MCONNECT  = "https://mconnect.trackgts.com:8081";
const API_USER = "tu_usuario";
const API_PASS = "tu_password";

type SyncResult = {
  success: boolean;
  rateLimited?: boolean;
  total?: number;
  message: string;
};

async function sincronizar(customer: string, tabla: string, baseUrl: string): Promise<SyncResult> {
  // Autenticar
  const authRes = await fetch(`${BASE_URL}/api/Authenticate/Auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: API_USER, password: API_PASS, customer }),
  });

  if (authRes.status === 429)
    return { success: false, rateLimited: true, message: `Rate limit alcanzado para ${tabla}. Espera ~20 minutos.` };

  if (!authRes.ok)
    return { success: false, message: `Error de autenticación para ${tabla}.` };

  const authData = await authRes.json();
  const accessToken = authData.data?.accessToken;
  const user = authData.data?.user;
  const retailId = (authData.data?.parentCustomerId ?? user?.parentCustomerId)?.toString();

  if (!accessToken || !retailId)
    return { success: false, message: `No se obtuvo token o retailId para ${tabla}.` };

  // Obtener reporte
  const reportRes = await fetch(`${BASE_URL}/api/HealthCheck/GetReportHealthCheck`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ retailId }),
  });

  if (reportRes.status === 429)
    return { success: false, rateLimited: true, message: `Rate limit alcanzado para ${tabla}. Espera ~20 minutos.` };

  if (!reportRes.ok)
    return { success: false, message: `Error al obtener reporte para ${tabla}.` };

  const reportData = await reportRes.json();
  const unidades = reportData.data ?? [];

  if (!unidades.length)
    return { success: false, message: `La API no devolvió unidades para ${tabla}.` };

  // Mapear registros
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
    return { success: false, message: `Error al guardar en ${tabla}: ${error.message}` };

  return { success: true, total: unidades.length, message: `✅ ${tabla}: ${unidades.length} unidades sincronizadas.` };
}

export async function POST() {
  try {
    const [tracklink, mzd] = await Promise.allSettled([
      sincronizar("tlchile",  "Tracklink",  BASE_URL_TRACKLINK),
      sincronizar("mconnect", "MZDConnect", BASE_URL_MCONNECT),
    ]);

    const resultTracklink = tracklink.status === "fulfilled" ? tracklink.value : { success: false, message: `Error inesperado en Tracklink.` };
    const resultMZD       = mzd.status === "fulfilled"       ? mzd.value       : { success: false, message: `Error inesperado en MZDConnect.` };

    const ambosOk       = resultTracklink.success && resultMZD.success;
    const algunRateLimit = resultTracklink.rateLimited || resultMZD.rateLimited;

    return NextResponse.json({
      success:    ambosOk,
      rateLimited: algunRateLimit,
      tracklink:  resultTracklink,
      mzd:        resultMZD,
      message:    `${resultTracklink.message} | ${resultMZD.message}`,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ success: false, message: `Error: ${message}` }, { status: 500 });
  }
}
