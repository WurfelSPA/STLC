import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://lomkolhgmkvshucqjuhf.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvbWtvbGhnbWt2c2h1Y3FqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MDUyNTUsImV4cCI6MjA5MDI4MTI1NX0.I_13jMA2DAa6Jzff4VBQitezdR2kfrXSVacaBn0QZbo"
);

const BASE_URL  = "https://tlchile.trackgts.com:8081";
const API_USER  = "amelendez";
const API_PASS  = "alex2026";
const CUSTOMER  = "tlchile";

export async function POST() {
  try {
    // PASO 1: Autenticar
    const authRes = await fetch(`${BASE_URL}/api/Authenticate/Auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: API_USER, password: API_PASS, customer: CUSTOMER }),
    });

    if (authRes.status === 429)
      return NextResponse.json({ success: false, rateLimited: true, message: "Has superado el límite de solicitudes. Espera al menos 20 minutos antes de volver a intentarlo." }, { status: 429 });

    if (!authRes.ok)
      return NextResponse.json({ success: false, message: "Error de autenticación con la API." }, { status: 400 });

    const authData = await authRes.json();
    const accessToken = authData.data?.accessToken;
    const user = authData.data?.user;
    const retailId = (authData.data?.parentCustomerId ?? user?.parentCustomerId)?.toString();

    if (!accessToken || !retailId)
      return NextResponse.json({ success: false, message: "No se pudo obtener el token o retailId." }, { status: 400 });

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
      return NextResponse.json({ success: false, rateLimited: true, message: "Has superado el límite de solicitudes. Espera al menos 20 minutos antes de volver a intentarlo." }, { status: 429 });

    if (!reportRes.ok)
      return NextResponse.json({ success: false, message: "Error al obtener el reporte de la API." }, { status: 400 });

    const reportData = await reportRes.json();
    const unidades = reportData.data ?? [];

    if (!unidades.length)
      return NextResponse.json({ success: false, message: "La API no devolvió unidades." }, { status: 400 });

    // PASO 3: Upsert a Supabase
    const registros = unidades.map((u: Record<string, unknown>) => ({
      "IMEI":                    u.imei,
      "Unit ID":                 u.unitId,
      "Serie":                   u.serie,
      "Fecha Ultimo Reporte":    u.fechaUltimoReporte,
      "Ubicación":               u.ubicacion,
      "Antigüedad (minutos)":    u.antiguedadMinutos,
      "Mensaje":                 u.mensaje,
      "EstadoGPS":               u.estadoGPS,
      "EstadoIgnición":          u.estadoIgnicion,
      "EstadoMotor":             u.estadoMotor,
      "Velocidad":               String(u.velocidad ?? ""),
      "Odómetro":                String(u.odometro ?? ""),
      "VBatExterna":             String(u.vBatExterna ?? ""),
      "%BatExterna":             u.porcentBatInterna,
      "Fabricante AVL":          u.fabricanteAVL,
      "Modelo AVL":              u.modeloAVL,
      "Modelo AVL Ref":          u.modeloAVLRef,
      "Protocolo":               u.protocolo,
      "Teléfono SIM":            u.telefonoSim,
      "Serie SIM":               u.serieSim,
      "GPRS":                    u.gprs,
      "Servicio":                u.servicio,
      "Servicio Comercial":      u.servicioComercial,
      "Serv. Desde":             u.servDesde,
      "Serv. Hasta":             u.servHasta,
      "TipoInstalacion":         u.tipoInstalacion,
      "Alias":                   u.alias,
      "Tipo":                    u.tipo,
      "Marca":                   u.marca,
      "Modelo":                  u.modelo,
      "Año":                     u.anio,
      "Placa":                   u.placa,
      "Color":                   u.color,
      "Chasis":                  u.chasis,
      "Motor":                   u.motor,
      "Cliente/Empresa":         u.clienteEmpresa,
      "Cust ID":                 u.custId,
      "Nombre":                  u.nombre,
      "Apellido":                u.apellido,
      "Direccion":               u.direccion,
      "Pais":                    u.pais,
      "Correo":                  u.correo,
      "Usuario":                 u.usuario,
      "Telefono":                u.telefono,
      "ClienteAdicional1":       u.clienteAdicional1 ?? "",
      "ClienteAdicional2":       u.clienteAdicional2 ?? "",
      "ClienteAdicional3":       u.clienteAdicional3 ?? "",
      "ClienteAdicional4":       u.clienteAdicional4 ?? "",
    }));

    const { error } = await supabase.from("Tracklink").upsert(registros, { onConflict: "IMEI" });

    if (error)
      return NextResponse.json({ success: false, message: `Error al guardar en Supabase: ${error.message}` }, { status: 500 });

    return NextResponse.json({ success: true, total: unidades.length, message: `✅ Sincronización exitosa. ${unidades.length} unidades actualizadas.` });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ success: false, message: `Error: ${message}` }, { status: 500 });
  }
}
