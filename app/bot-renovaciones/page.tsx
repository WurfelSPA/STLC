"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Navbar from "../components/Navbar";
import type { Linea, Prioridad } from "@/app/lib/renovaciones/tipos";
import { ESTADOS, ESTADO_LABEL } from "@/app/lib/renovaciones/tipos";
import {
  ejecutarCampanaAction, obtenerPanelAction, reiniciarSimulacionAction,
  type CasoPanel, type Metricas, type Panel,
} from "@/app/lib/renovaciones/acciones";
import type { ResumenCampana } from "@/app/lib/renovaciones/campana";
import DetalleCaso from "./DetalleCaso";
import { BadgeEstado, BadgePrioridad, fechaCorta, pesosCL } from "./ui";

type Tab = "dashboard" | "cola" | "conversaciones" | "config";
const LINEAS: Linea[] = ["TRACKLINK", "AUTOBAHN", "TRACKCITY"];
const ORDEN_PRIORIDAD: Record<Prioridad, number> = { ALTA: 0, MEDIA: 1, BAJA: 2 };

function mesActual() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date()).slice(0, 7);
}

function sumarDias(fecha: string, dias: number) {
  return new Date(Date.parse(fecha) + dias * 86_400_000).toISOString().slice(0, 10);
}

export default function BotRenovaciones() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [mes, setMes] = useState(mesActual());
  const [panel, setPanel] = useState<Panel | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [seleccionado, setSeleccionado] = useState<string | null>(null);
  const [fechaCampana, setFechaCampana] = useState("");
  const [corriendo, setCorriendo] = useState(false);
  const [resumen, setResumen] = useState<ResumenCampana | null>(null);

  const cargar = useCallback(async () => {
    setError("");
    try {
      const p = await obtenerPanelAction(mes);
      setPanel(p);
      setFechaCampana(f => f || p.hoy);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    }
    setCargando(false);
  }, [mes]);

  useEffect(() => { setCargando(true); cargar(); }, [cargar]);

  const correrCampana = async (fecha: string) => {
    setCorriendo(true);
    setError("");
    try {
      setResumen(await ejecutarCampanaAction(fecha));
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error en la campaña");
    }
    setCorriendo(false);
  };

  const reiniciar = async () => {
    if (!confirm("¿Borrar TODOS los casos y mensajes de simulación?")) return;
    try {
      await reiniciarSimulacionAction();
      setResumen(null);
      setSeleccionado(null);
      if (panel) setFechaCampana(panel.hoy);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  };

  const cola = useMemo(() => (panel?.casos ?? [])
    .filter(c => (c.requiere_ejecutivo && !c.atendido) || c.estado === "PAGO_POR_VALIDAR")
    .sort((a, b) => ORDEN_PRIORIDAD[a.prioridad] - ORDEN_PRIORIDAD[b.prioridad] || a.fecha_vencimiento.localeCompare(b.fecha_vencimiento)),
  [panel]);
  const porActualizarTrackgts = useMemo(() => (panel?.casos ?? []).filter(c => c.estado === "RENOVADO" && !c.trackgts_actualizado), [panel]);

  return (
    <div className="min-h-screen bg-gray-100 text-sm">
      <Navbar paginaActiva="bot" />
      <div className="p-4">
        {/* Encabezado */}
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <span className="text-blue-900 font-bold text-lg">Bot de Renovaciones</span>
          {panel && (
            <>
              <span className={`text-xs px-2 py-0.5 rounded font-semibold ${panel.simulacion ? "bg-amber-100 text-amber-900 border border-amber-300" : "bg-green-600 text-white"}`}>
                {panel.simulacion ? "MODO SIMULACIÓN — no se envía nada a clientes" : "PRODUCCIÓN"}
              </span>
              <span className="text-xs text-gray-500">IA: {panel.iaActiva ? "activa" : "solo reglas"} · WhatsApp: {panel.whatsappActivo ? "conectado" : "pendiente"}</span>
            </>
          )}
          <div className="flex-1" />
          <label className="text-xs text-gray-600">Mes de vencimiento
            <input type="month" value={mes} onChange={e => setMes(e.target.value)} className="ml-1 border border-gray-300 rounded px-1 py-0.5 text-xs" />
          </label>
          <button onClick={() => { setCargando(true); cargar(); }} className="bg-blue-800 text-white text-xs px-3 py-1 rounded hover:bg-blue-700">↻ Actualizar</button>
        </div>

        {/* Campaña */}
        <div className="bg-white border border-gray-200 rounded p-3 mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-700">Campaña diaria:</span>
          {panel?.simulacion && (
            <>
              <label className="text-xs text-gray-600">simular el día
                <input type="date" value={fechaCampana} onChange={e => setFechaCampana(e.target.value)} className="ml-1 border border-gray-300 rounded px-1 py-0.5 text-xs" />
              </label>
              {[10, 7, 3].map(d => (
                <button key={d} disabled={!fechaCampana} onClick={() => setFechaCampana(sumarDias(fechaCampana, d))}
                  className="text-xs px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-50">+{d} días</button>
              ))}
            </>
          )}
          <button disabled={corriendo} onClick={() => correrCampana(fechaCampana)}
            className="text-xs px-3 py-1 rounded bg-blue-900 text-white hover:bg-blue-800 disabled:opacity-50">
            {corriendo ? "Ejecutando..." : "▶ Ejecutar campaña"}
          </button>
          {panel?.simulacion && (
            <button onClick={reiniciar} className="text-xs px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50">Reiniciar simulación</button>
          )}
          {resumen && (
            <span className="text-xs text-gray-700">
              {fechaCorta(resumen.hoy)}: {resumen.vehiculosEnVentana} vehículos vencen en 30 días · {resumen.casosNuevos} casos nuevos ({resumen.vehiculosNuevos} veh.) ·
              enviados D30 {resumen.envios.D30} / D20 {resumen.envios.D20} / D10 {resumen.envios.D10} / D3 {resumen.envios.D3} / D0 {resumen.envios.D0}
              {resumen.sinTelefono ? ` · ${resumen.sinTelefono} sin teléfono` : ""}
              {resumen.renovadosFueraDelBot ? ` · ${resumen.renovadosFueraDelBot} ya renovados en TrackGTS` : ""}
              {resumen.pasadosAGestionManual ? ` · ${resumen.pasadosAGestionManual} a gestión manual` : ""}
            </span>
          )}
        </div>

        {error && <div className="text-red-600 text-xs mb-2">{error}</div>}

        {/* Tabs */}
        <div className="flex gap-1 mb-3 border-b border-gray-300">
          {([
            ["dashboard", "Dashboard"],
            ["cola", `Cola del ejecutivo${cola.length ? ` (${cola.length})` : ""}`],
            ["conversaciones", "Conversaciones / Simulador"],
            ["config", "Precios y configuración"],
          ] as [Tab, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-t border border-b-0 ${tab === k ? "bg-white text-blue-900 border-gray-300" : "bg-gray-200 text-gray-600 border-transparent hover:bg-gray-50"}`}>
              {label}
            </button>
          ))}
        </div>

        {cargando && !panel ? <div className="text-center py-10 text-gray-500">Cargando...</div> : panel && (
          <>
            {tab === "dashboard" && <Dashboard panel={panel} />}
            {tab === "cola" && (
              <Dividido casos={cola} extra={porActualizarTrackgts} seleccionado={seleccionado} onSel={setSeleccionado} onCambio={cargar} modo="cola" />
            )}
            {tab === "conversaciones" && (
              <Dividido casos={panel.casos} seleccionado={seleccionado} onSel={setSeleccionado} onCambio={cargar} modo="todas" />
            )}
            {tab === "config" && <Config panel={panel} />}
          </>
        )}
      </div>
    </div>
  );
}

// ── Dashboard (secciones 7 y 8 del spec) ────────────────────────────────────

function Kpi({ label, valor, sub, color = "text-blue-900" }: { label: string; valor: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded p-3 text-center">
      <div className={`text-2xl font-bold ${color}`}>{valor}</div>
      <div className="text-xs text-gray-500">{label}</div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function Dashboard({ panel }: { panel: Panel }) {
  const t = panel.total;
  const embudo: [string, number][] = [
    ["Universo", t.universo], ["Gestionados por el bot", t.casos], ["Contactados", t.contactados], ["Respondieron", t.respondieron],
    ["Interesados", t.interesados], ["Pago pendiente", t.pagoPendiente], ["Renovados", t.renovados],
  ];
  const max = Math.max(1, ...embudo.map(e => e[1]));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-2">
        <Kpi label="Universo del mes" valor={t.universo} sub="vehículos que vencen" />
        <Kpi label="Contactados" valor={t.contactados} />
        <Kpi label="Respondieron" valor={t.respondieron} sub={`${t.tasaRespuesta}% respuesta`} />
        <Kpi label="Interesados" valor={t.interesados} color="text-violet-700" />
        <Kpi label="Pago pendiente" valor={t.pagoPendiente} color="text-amber-700" />
        <Kpi label="Renovados" valor={t.renovados} color="text-green-700" />
        <Kpi label="No renuevan" valor={t.noRenuevan} color="text-red-700" />
        <Kpi label="Sin respuesta" valor={t.sinRespuesta} color="text-stone-600" />
        <Kpi label="% penetración" valor={`${t.penetracion}%`} sub="renovados / universo" color="text-green-800" />
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="bg-white border border-gray-200 rounded p-3">
          <div className="font-semibold text-blue-900 mb-2">Embudo de renovación — {panel.mes}</div>
          {embudo.map(([label, n]) => (
            <div key={label} className="flex items-center gap-2 mb-1">
              <span className="w-40 text-xs text-gray-600">{label}</span>
              <div className="flex-1 bg-gray-100 rounded h-4">
                <div className="bg-blue-700 h-4 rounded" style={{ width: `${(n / max) * 100}%` }} />
              </div>
              <span className="w-10 text-right text-xs font-semibold">{n}</span>
            </div>
          ))}
        </div>

        <div className="bg-white border border-gray-200 rounded p-3">
          <div className="font-semibold text-blue-900 mb-2">Métricas del bot</div>
          <table className="w-full text-xs">
            <tbody>
              {([
                ["Conversaciones iniciadas", t.contactados],
                ["Tasa de respuesta", `${t.tasaRespuesta}%`],
                ["Renovaciones cerradas por el bot", t.cerradosPorBot],
                ["Derivadas a ejecutivo", t.derivados],
                ["Conversión bot → renovación", `${t.conversionBot}%`],
                ["Clientes sin respuesta", t.sinRespuesta],
              ] as [string, string | number][]).map(([k, v]) => (
                <tr key={k} className="border-b border-gray-100"><td className="py-1 text-gray-600">{k}</td><td className="py-1 text-right font-semibold">{v}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="font-semibold text-blue-900 mt-3 mb-1">Principales motivos de no renovación</div>
          {panel.motivosNoRenueva.length === 0 ? <div className="text-xs text-gray-400">Sin datos todavía.</div> : (
            <ul className="text-xs space-y-0.5">
              {panel.motivosNoRenueva.map(m => <li key={m.motivo} className="flex justify-between"><span>{m.motivo}</span><b>{m.cantidad}</b></li>)}
            </ul>
          )}
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded p-3">
        <div className="font-semibold text-blue-900 mb-2">Por línea</div>
        <table className="w-full text-xs border-collapse">
          <thead><tr className="bg-blue-900 text-white">
            {["Línea", "Universo", "Contactados", "Respondieron", "Interesados", "Pago pend.", "Renovados", "No renuevan", "Sin resp.", "% renovación"].map(h =>
              <th key={h} className="px-2 py-1 text-left border border-blue-700">{h}</th>)}
          </tr></thead>
          <tbody>
            {LINEAS.map(l => {
              const m: Metricas = panel.porLinea[l];
              return (
                <tr key={l} className="border-b border-gray-100">
                  <td className="px-2 py-1 font-semibold">{l}{l === "TRACKCITY" && <span className="text-[10px] text-gray-400 font-normal"> (otra plataforma — pendiente)</span>}</td>
                  {[m.universo, m.contactados, m.respondieron, m.interesados, m.pagoPendiente, m.renovados, m.noRenuevan, m.sinRespuesta].map((v, i) =>
                    <td key={i} className="px-2 py-1">{v}</td>)}
                  <td className="px-2 py-1 font-semibold text-green-800">{m.penetracion}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Lista + detalle (cola del ejecutivo / todas las conversaciones) ─────────

function Dividido({ casos, extra, seleccionado, onSel, onCambio, modo }: {
  casos: CasoPanel[]; extra?: CasoPanel[]; seleccionado: string | null; onSel: (id: string) => void; onCambio: () => void; modo: "cola" | "todas";
}) {
  const [busqueda, setBusqueda] = useState("");
  const [estado, setEstado] = useState("");
  const [linea, setLinea] = useState("");
  const filtrados = casos.filter(c => {
    if (estado && c.estado !== estado) return false;
    if (linea && c.linea !== linea) return false;
    if (busqueda) {
      const q = busqueda.toLowerCase();
      return [c.nombre, c.usuario, c.rut, c.telefono, ...c.vehiculos.map(v => v.placa)].some(v => (v ?? "").toLowerCase().includes(q));
    }
    return true;
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
      <div className="lg:col-span-2 space-y-2">
        <div className="flex flex-wrap gap-2">
          <input value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Nombre, patente, RUT, teléfono..."
            className="flex-1 min-w-[140px] border border-gray-300 rounded px-2 py-1 text-xs" />
          {modo === "todas" && (
            <select value={estado} onChange={e => setEstado(e.target.value)} className="border border-gray-300 rounded px-1 py-1 text-xs">
              <option value="">Todos los estados</option>
              {ESTADOS.map(s => <option key={s} value={s}>{ESTADO_LABEL[s]}</option>)}
            </select>
          )}
          <select value={linea} onChange={e => setLinea(e.target.value)} className="border border-gray-300 rounded px-1 py-1 text-xs">
            <option value="">Todas las líneas</option>
            {LINEAS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div className="bg-white border border-gray-200 rounded max-h-[calc(100vh-330px)] overflow-y-auto">
          {filtrados.length === 0 && (
            <div className="p-6 text-center text-xs text-gray-500">
              {modo === "cola" ? "No hay casos pendientes para el ejecutivo. 🎉" : "No hay casos. Ejecuta la campaña para crearlos."}
            </div>
          )}
          {filtrados.map(c => <FilaCaso key={c.id} c={c} activo={c.id === seleccionado} onClick={() => onSel(c.id)} />)}
          {extra && extra.length > 0 && (
            <>
              <div className="px-3 py-1.5 bg-blue-50 text-xs font-semibold text-blue-900 border-y border-blue-100">
                Renovados — falta actualizar fecha en TrackGTS ({extra.length})
              </div>
              {extra.map(c => <FilaCaso key={c.id} c={c} activo={c.id === seleccionado} onClick={() => onSel(c.id)} />)}
            </>
          )}
        </div>
      </div>
      <div className="lg:col-span-3 bg-white border border-gray-200 rounded h-[calc(100vh-290px)] min-h-[520px] overflow-hidden">
        {seleccionado
          ? <DetalleCaso key={seleccionado} casoId={seleccionado} onCambio={onCambio} />
          : <div className="h-full flex items-center justify-center text-gray-400 text-xs">Selecciona un caso para ver la conversación.</div>}
      </div>
    </div>
  );
}

function FilaCaso({ c, activo, onClick }: { c: CasoPanel; activo: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`w-full text-left px-3 py-2 border-b border-gray-100 hover:bg-blue-50 ${activo ? "bg-blue-100" : ""}`}>
      <div className="flex items-center gap-2">
        <BadgePrioridad p={c.prioridad} />
        <span className="font-semibold text-gray-800 truncate flex-1">{c.nombre || c.usuario}</span>
        <span className="text-[11px] text-gray-500">{fechaCorta(c.fecha_vencimiento)}</span>
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <BadgeEstado estado={c.estado} />
        <span className="text-[11px] text-gray-500">{c.linea}</span>
        <span className="text-[11px] text-gray-600 truncate">
          {c.cantidad_vehiculos > 1 ? `${c.cantidad_vehiculos} vehículos` : c.vehiculos[0]?.placa}
        </span>
      </div>
      {c.motivo && <div className="text-[11px] text-orange-800 truncate mt-0.5">{c.motivo}</div>}
    </button>
  );
}

// ── Configuración ───────────────────────────────────────────────────────────

function Config({ panel }: { panel: Panel }) {
  return (
    <div className="grid md:grid-cols-3 gap-3">
      {LINEAS.map(l => (
        <div key={l} className="bg-white border border-gray-200 rounded p-3">
          <div className="font-semibold text-blue-900 mb-2">{l}</div>
          {panel.precios[l]?.length ? (
            <table className="w-full text-xs">
              <tbody>{panel.precios[l].map(p => (
                <tr key={p.meses} className="border-b border-gray-100"><td className="py-1">{p.meses} meses</td><td className="py-1 text-right font-semibold">{pesosCL(p.precio)}</td></tr>
              ))}</tbody>
            </table>
          ) : <div className="text-xs text-red-600">Sin precios cargados — el bot deriva estas renovaciones a un ejecutivo.</div>}
        </div>
      ))}
      <div className="md:col-span-3 bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900 space-y-1">
        <div className="font-semibold">Pendientes de Tracklink para pasar a producción</div>
        <ul className="list-disc ml-4 space-y-0.5">
          <li>Trackcity: base de clientes (otra plataforma), precios y medios de pago.</li>
          <li>Precios para planes especiales (COORP MENSUALIZADO, SANTANDER CONSUMER, concesionarios, REFERIDO, FLOTAS) — hoy el bot los deriva a ejecutivo.</li>
          <li>Número de Call Center para problemas de App / GPS.</li>
          <li>Datos de transferencia para Autobahn (hoy solo link de pago).</li>
          <li>Cuenta WhatsApp Business (Meta): número(s), verificación de empresa y aprobación de plantillas D30/D20/D10/D3/D0.</li>
        </ul>
      </div>
    </div>
  );
}
