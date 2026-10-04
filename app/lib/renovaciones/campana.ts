import "server-only";
import { getSupabaseAdmin } from "@/app/lib/supabaseAdmin";
import type { Caso, Hito, Linea, Vehiculo } from "./tipos";
import { ESTADOS_CERRADOS, HITOS } from "./tipos";
import { actualizarCaso, cargarConfig, cargarGeneral, cargarSegmentos, registrarMensaje } from "./datos";
import { diasEntre, esRutEmpresa, fechaLarga, nombreCorto, normalizarTelefono, patentes } from "./formato";
import { mensajeInicial, mensajeRecordatorio, mensajeVencimiento } from "./textos";
import { enviarProactivo } from "./canal";

// Corrida diaria (sección 3 + 5 del spec):
//  1. Lee la base sincronizada desde TrackGTS (tabla "Tracklink").
//  2. Crea casos para vencimientos de los próximos 30 días — consolidando la
//     flota de un mismo cliente en un solo caso.
//  3. Envía el contacto que corresponda (D30 / D20 / D10 / D3 / D0).
//  4. Cierra como RENOVADO los que ya aparecen renovados en TrackGTS (renovación
//     hecha por fuera del bot) y pasa a gestión manual los sin respuesta.

const VENTANA_DIAS = 30;

type FilaTL = Record<string, string | null>;

export type ResumenCampana = {
  hoy: string;
  vehiculosEnVentana: number;
  casosNuevos: number;
  vehiculosNuevos: number;
  envios: Record<Hito, number>;
  sinTelefono: number;
  renovadosFueraDelBot: number;
  pasadosAGestionManual: number;
};

async function leerTracklink(): Promise<FilaTL[]> {
  const sb = getSupabaseAdmin();
  const cols = '"IMEI","Placa","Marca","Modelo","Serv. Hasta","Servicio Comercial","Usuario","Nombre","Apellido","Cust ID","Telefono","Correo","Fecha Ultimo Reporte"';
  let todos: FilaTL[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await sb.from("Tracklink").select(cols).range(desde, desde + 999);
    if (error) throw new Error(`Error leyendo Tracklink: ${error.message}`);
    todos = todos.concat((data ?? []) as unknown as FilaTL[]);
    if (!data || data.length < 1000) break;
  }
  return todos;
}

// La misma patente puede tener varias filas (GPS reasignado, la fila vieja
// nunca se borra): nos quedamos con la que reportó más reciente.
function deduplicarPorPatente(filas: FilaTL[]): FilaTL[] {
  const porClave = new Map<string, FilaTL>();
  for (const f of filas) {
    const placa = (f.Placa ?? "").trim().toUpperCase();
    const clave = placa || `IMEI:${f.IMEI}`;
    const actual = porClave.get(clave);
    if (!actual || (f["Fecha Ultimo Reporte"] ?? "") > (actual["Fecha Ultimo Reporte"] ?? "")) porClave.set(clave, f);
  }
  return [...porClave.values()];
}

const vence = (f: FilaTL) => (f["Serv. Hasta"] ?? "").slice(0, 10);

export async function ejecutarCampana(hoy: string, simulacion: boolean): Promise<ResumenCampana> {
  const sb = getSupabaseAdmin();
  const [filasRaw, segmentos, general, cfg] = await Promise.all([leerTracklink(), cargarSegmentos(), cargarGeneral(), cargarConfig()]);
  const excluidos = new Set(general.usuarios_excluidos);
  const segPorNombre = new Map(segmentos.map(s => [s.servicio_comercial, s]));
  const segDe = (f: FilaTL) => {
    const nombre = (f["Servicio Comercial"] ?? "").trim();
    return { nombre, ...(segPorNombre.get(nombre) ?? { linea: "TRACKLINK" as Linea, cotiza_bot: false, excluir: false }) };
  };

  const filas = deduplicarPorPatente(
    filasRaw.filter(f => /^\d{4}-\d{2}-\d{2}/.test(f["Serv. Hasta"] ?? "") && !excluidos.has(f.Usuario ?? "") && !segDe(f).excluir),
  );
  const venceActualPorImei = new Map(filas.map(f => [f.IMEI ?? "", vence(f)]));

  const resumen: ResumenCampana = {
    hoy, vehiculosEnVentana: 0, casosNuevos: 0, vehiculosNuevos: 0,
    envios: { D30: 0, D20: 0, D10: 0, D3: 0, D0: 0 },
    sinTelefono: 0, renovadosFueraDelBot: 0, pasadosAGestionManual: 0,
  };

  // ── 1+2. Casos nuevos ─────────────────────────────────────────────────────
  const enVentana = filas.filter(f => { const d = diasEntre(hoy, vence(f)); return d >= 0 && d <= VENTANA_DIAS; });
  resumen.vehiculosEnVentana = enVentana.length;

  const desdeExistentes = new Date(Date.parse(hoy) - 90 * 86_400_000).toISOString().slice(0, 10);
  const { data: existentes } = await sb.from("renov_casos").select("vehiculos")
    .eq("simulacion", simulacion).gte("fecha_vencimiento", desdeExistentes);
  const yaGestionados = new Set<string>();
  for (const c of existentes ?? []) for (const v of (c.vehiculos as Vehiculo[])) yaGestionados.add(`${v.imei}|${v.vence}`);

  const grupos = new Map<string, FilaTL[]>();
  for (const f of enVentana) {
    if (yaGestionados.has(`${f.IMEI}|${vence(f)}`)) continue;
    const clave = `${f.Usuario}|${segDe(f).linea}`;
    grupos.set(clave, [...(grupos.get(clave) ?? []), f]);
  }

  const nuevos = [...grupos.values()].map(fs => {
    fs.sort((a, b) => vence(a).localeCompare(vence(b)));
    const p = fs[0];
    const seg = segDe(p);
    const telefono = fs.map(f => normalizarTelefono(f.Telefono)).find(Boolean) ?? null;
    const empresa = esRutEmpresa(p["Cust ID"]);
    return {
      usuario: p.Usuario ?? "",
      nombre: [p.Nombre, p.Apellido].filter(Boolean).join(" ").trim() || null,
      rut: p["Cust ID"],
      telefono,
      correo: p.Correo,
      linea: seg.linea,
      segmento: seg.nombre,
      // Planes con condiciones especiales no se cotizan solos; flotas mixtas
      // (algún vehículo de un segmento sin precio) tampoco.
      cotiza_bot: fs.every(f => segDe(f).cotiza_bot),
      tipo_cliente: empresa ? "empresa" : "persona",
      vehiculos: fs.map(f => ({ imei: f.IMEI ?? "", placa: (f.Placa ?? "").trim(), marca: f.Marca ?? "", modelo: f.Modelo ?? "", vence: vence(f) })),
      cantidad_vehiculos: fs.length,
      fecha_vencimiento: vence(p),
      simulacion,
    };
  });
  if (nuevos.length) {
    const { error } = await sb.from("renov_casos").insert(nuevos);
    if (error) throw new Error(`No se pudieron crear casos: ${error.message}`);
  }
  resumen.casosNuevos = nuevos.length;
  resumen.vehiculosNuevos = nuevos.reduce((s, c) => s + c.cantidad_vehiculos, 0);

  // ── 3+4. Contactos y cierres sobre casos abiertos ─────────────────────────
  const { data: abiertosRaw, error } = await sb.from("renov_casos").select("*")
    .eq("simulacion", simulacion).not("estado", "in", `(${ESTADOS_CERRADOS.join(",")})`)
    .gte("fecha_vencimiento", desdeExistentes);
  if (error) throw new Error(error.message);

  for (const caso of (abiertosRaw ?? []) as Caso[]) {
    // Renovado por fuera del bot: todas sus patentes ya vencen bastante después.
    const actuales = caso.vehiculos.map(v => venceActualPorImei.get(v.imei));
    if (actuales.length && actuales.every(a => a && diasEntre(caso.fecha_vencimiento, a) >= 28)) {
      const nueva = actuales.sort()[0]!;
      await actualizarCaso(caso.id, {
        estado: "RENOVADO", paso: "FIN", cerrado_por: "externo", nueva_fecha_vencimiento: nueva,
        trackgts_actualizado: true, requiere_ejecutivo: false,
      });
      await registrarMensaje({ caso_id: caso.id, direccion: "nota", canal: "sistema", tipo: "evento",
        texto: `Detectado renovado en TrackGTS (nuevo vencimiento ${nueva}). Se detienen los recordatorios.` });
      resumen.renovadosFueraDelBot++;
      continue;
    }

    const dias = diasEntre(hoy, caso.fecha_vencimiento);

    // Después del día 0 sin respuesta -> gestión manual.
    if (dias < 0) {
      if (!caso.respondio && caso.estado !== "SIN_RESPUESTA") {
        await actualizarCaso(caso.id, {
          estado: "SIN_RESPUESTA", requiere_ejecutivo: true, atendido: false,
          motivo: "Sin respuesta tras el día de vencimiento — gestión manual",
        });
        resumen.pasadosAGestionManual++;
      }
      continue;
    }

    if (caso.opt_out || caso.requiere_ejecutivo) continue;
    if (["PAGO_POR_VALIDAR", "CAMBIO_VEHICULO", "REQUIERE_EJECUTIVO"].includes(caso.estado)) continue;

    // Hito más reciente alcanzado que aún no se envió (no se "rellenan" los
    // anteriores: un caso que aparece a 18 días recibe un solo mensaje).
    const alcanzados = HITOS.filter(h => dias <= h.dias);
    const pendiente = alcanzados.at(-1);
    if (!pendiente || caso.hitos_enviados.includes(pendiente.hito)) continue;

    if (!caso.telefono) {
      if (!caso.hitos_enviados.length) {
        await actualizarCaso(caso.id, {
          requiere_ejecutivo: true, atendido: false, motivo: "Sin teléfono móvil válido — contactar por correo/llamada",
          hitos_enviados: alcanzados.map(h => h.hito),
        });
        resumen.sinTelefono++;
      }
      continue;
    }

    const primerContacto = caso.hitos_enviados.length === 0;
    const texto = pendiente.hito === "D0" ? mensajeVencimiento(caso, cfg)
      : primerContacto ? mensajeInicial(caso, cfg) : mensajeRecordatorio(caso, cfg, hoy);
    const params = [nombreCorto(caso), cfg.lineas[caso.linea]?.nombre ?? caso.linea, patentes(caso), fechaLarga(caso.fecha_vencimiento), String(dias)];
    await enviarProactivo(caso, pendiente.hito, texto, params);
    await actualizarCaso(caso.id, {
      hitos_enviados: [...new Set([...caso.hitos_enviados, ...alcanzados.map(h => h.hito)])],
      estado: caso.estado === "PENDIENTE" ? "CONTACTADO" : caso.estado,
      paso: "MENU",
    });
    resumen.envios[pendiente.hito]++;
  }

  // RENOVADO por el bot: marcar cuando TrackGTS ya refleja la nueva fecha.
  const { data: porActualizar } = await sb.from("renov_casos").select("id, vehiculos, nueva_fecha_vencimiento")
    .eq("simulacion", simulacion).eq("estado", "RENOVADO").eq("trackgts_actualizado", false);
  for (const c of porActualizar ?? []) {
    const ok = (c.vehiculos as Vehiculo[]).every(v => {
      const a = venceActualPorImei.get(v.imei);
      return a && c.nueva_fecha_vencimiento && diasEntre(c.nueva_fecha_vencimiento, a) >= -5;
    });
    if (ok) await actualizarCaso(c.id, { trackgts_actualizado: true });
  }

  return resumen;
}

// Universo del mes para el dashboard: vehículos que vencen en el mes según la
// base de TrackGTS (mismas exclusiones que la campaña), por línea.
export async function universoDelMes(mes: string): Promise<Record<Linea, number>> {
  const [filasRaw, segmentos, general] = await Promise.all([leerTracklink(), cargarSegmentos(), cargarGeneral()]);
  const excluidos = new Set(general.usuarios_excluidos);
  const segPorNombre = new Map(segmentos.map(s => [s.servicio_comercial, s]));
  const res: Record<Linea, number> = { TRACKLINK: 0, AUTOBAHN: 0, TRACKCITY: 0 };
  const filas = deduplicarPorPatente(filasRaw.filter(f => !excluidos.has(f.Usuario ?? "")));
  for (const f of filas) {
    if (!vence(f).startsWith(mes)) continue;
    const seg = segPorNombre.get((f["Servicio Comercial"] ?? "").trim());
    if (seg?.excluir) continue;
    res[seg?.linea ?? "TRACKLINK"]++;
  }
  return res;
}
