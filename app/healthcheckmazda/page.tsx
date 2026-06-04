"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";

const supabase = createClient(
  "https://lomkolhgmkvshucqjuhf.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvbWtvbGhnbWt2c2h1Y3FqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MDUyNTUsImV4cCI6MjA5MDI4MTI1NX0.I_13jMA2DAa6Jzff4VBQitezdR2kfrXSVacaBn0QZbo"
);

type Unidad = {
  IMEI: string;
  "Unit ID": number;
  "Fecha Ultimo Reporte": string;
  "Antigüedad (minutos)": number;
  Mensaje: string;
  EstadoGPS: string;
  "EstadoIgnición": string;
  EstadoMotor: string;
  Velocidad: string;
  "Odómetro": string;
  VBatExterna: string;
  "%BatExterna": number;
  "Fabricante AVL": string;
  "Modelo AVL": string;
  "Modelo AVL Ref": string;
  Protocolo: string;
  "Teléfono SIM": string;
  "Serie SIM": string;
  GPRS: number;
  Servicio: string;
  "Servicio Comercial": string;
  "Serv. Desde": string;
  "Serv. Hasta": string;
  TipoInstalacion: string;
  Alias: string;
  Tipo: string;
  Marca: string;
  Modelo: string;
  "Año": string;
  Placa: string;
  Color: string;
  Chasis: string;
  Motor: string;
  "Cliente/Empresa": string;
  "Cust ID": string;
  Nombre: string;
  Apellido: string;
  Direccion: string;
  Pais: string;
  Correo: string;
  Usuario: string;
  Telefono: string;
  ClienteAdicional1: string;
  ClienteAdicional2: string;
  ClienteAdicional3: string;
  ClienteAdicional4: string;
  Comentarios: string;
};

const COLUMNAS: { key: keyof Unidad; label: string }[] = [
  { key: "IMEI", label: "IMEI" },
  { key: "Alias", label: "ALIAS" },
  { key: "Placa", label: "PLACA" },
  { key: "Cliente/Empresa", label: "CLIENTE/EMPRESA" },
  { key: "Usuario", label: "USUARIO" },
  { key: "Fabricante AVL", label: "FABRICANTE GPS" },
  { key: "Modelo AVL", label: "MODELO GPS" },
  { key: "Protocolo", label: "PROTOCOLO" },
  { key: "Teléfono SIM", label: "SIM TELÉFONO" },
  { key: "Serie SIM", label: "SIM SERIE" },
  { key: "Servicio", label: "SERVICIO" },
  { key: "Servicio Comercial", label: "SERV. COMERCIAL" },
  { key: "Serv. Desde", label: "SERV. DESDE" },
  { key: "Serv. Hasta", label: "SERV. HASTA" },
  { key: "TipoInstalacion", label: "TIPO INST." },
  { key: "Tipo", label: "TIPO VEH." },
  { key: "Marca", label: "MARCA" },
  { key: "Modelo", label: "MODELO" },
  { key: "Año", label: "AÑO" },
  { key: "Color", label: "COLOR" },
  { key: "Fecha Ultimo Reporte", label: "ÚLTIMO REPORTE" },
  { key: "Antigüedad (minutos)", label: "ANTIGÜEDAD (min)" },
  { key: "EstadoGPS", label: "ESTADO GPS" },
  { key: "EstadoIgnición", label: "IGNICIÓN" },
  { key: "Velocidad", label: "VELOCIDAD" },
  { key: "Odómetro", label: "ODÓMETRO" },
  { key: "VBatExterna", label: "BAT. EXTERNA" },
];

export default function HealthCheckMazda() {
  const router = useRouter();
  const [datos, setDatos] = useState<Unidad[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [filtros, setFiltros] = useState<Record<string, string>>({});
  const [dropdownAbierto, setDropdownAbierto] = useState<string | null>(null);
  const [busquedaDropdown, setBusquedaDropdown] = useState<Record<string, string>>({});
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cargarDatos();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownAbierto(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const cargarDatos = async () => {
    setCargando(true);
    setError("");
    let todos: Unidad[] = [];
    let desde = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error: err } = await supabase
        .from("MZDConnect")
        .select("*")
        .range(desde, desde + pageSize - 1);
      if (err) { setError("Error al cargar datos: " + err.message); break; }
      if (!data || data.length === 0) break;
      todos = [...todos, ...data as Unidad[]];
      if (data.length < pageSize) break;
      desde += pageSize;
    }
    setDatos(todos);
    setCargando(false);
  };

  const formatFecha = (fecha: string) => {
    if (!fecha) return "";
    return fecha.split("T")[0];
  };

  const servicioVencido = (hasta: string) => {
    if (!hasta) return false;
    return new Date(hasta.split("T")[0]) < new Date(new Date().toISOString().split("T")[0]);
  };

  const servicioPorVencer = (hasta: string) => {
    if (!hasta) return false;
    const hoy = new Date(new Date().toISOString().split("T")[0]);
    const fechaHasta = new Date(hasta.split("T")[0]);
    const diff = (fechaHasta.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 60;
  };

  const datosFiltrados = datos.filter(u =>
    Object.entries(filtros).every(([col, val]) => {
      if (!val) return true;
      const celda = String(u[col as keyof Unidad] ?? "").toLowerCase();
      return celda.includes(val.toLowerCase());
    })
  );

  const valoresUnicos = (col: string) => {
    const busq = (busquedaDropdown[col] || "").toLowerCase();
    const valores = Array.from(new Set(datos.map(u => String(u[col as keyof Unidad] ?? "")))).sort();
    return busq ? valores.filter(v => v.toLowerCase().includes(busq)) : valores;
  };

  const toggleFiltroValor = (col: string, valor: string) => {
    setFiltros(prev => {
      const actual = prev[col] || "";
      if (actual === valor) {
        const { [col]: _, ...resto } = prev;
        return resto;
      }
      return { ...prev, [col]: valor };
    });
  };

  const limpiarFiltro = (col: string) => {
    setFiltros(prev => {
      const { [col]: _, ...resto } = prev;
      return resto;
    });
    setBusquedaDropdown(prev => ({ ...prev, [col]: "" }));
  };

  const limpiarTodosFiltros = () => {
    setFiltros({});
    setBusquedaDropdown({});
  };

  const filtrosActivos = Object.keys(filtros).filter(k => filtros[k]);

  return (
    <div className="min-h-screen bg-gray-100 text-sm">
     <nav className="bg-blue-900 text-white px-4 py-2 flex items-center gap-6">
  <a href="https://www.tracklink.cl/" target="_blank" rel="noopener noreferrer">
    <img src="/logo.png" alt="Tracklink" className="h-8 shrink-0 cursor-pointer" />
  </a>
  <div className="flex gap-6 font-semibold flex-1">
    <button onClick={() => router.push("/")} className="hover:text-yellow-300">Home</button>
    <button onClick={() => router.push("/")} className="hover:text-yellow-300">Renovaciones</button>
    <button onClick={() => router.push("/")} className="hover:text-yellow-300">Instalaciones</button>
    <button onClick={() => router.push("/healthchecktracklink")} className="hover:text-yellow-300">Tracklink Healthcheck</button>
    <button className="text-yellow-300 underline">Mazda Healthcheck</button>
  </div>
</nav>
        
</nav>
<div className="px-4 pt-2">
  <a href="https://mconnect.trackgts.com/Admin/login.html" target="_blank" rel="noopener noreferrer"
     className="bg-blue-700 text-white text-xs px-3 py-1 rounded hover:bg-blue-600 inline-block">
    🔗 Abrir Portal MZDConnect
  </a>
</div>
      <div className="p-4">
        {/* ENCABEZADO */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <span className="text-blue-900 font-bold text-lg">HealthCheck Mazda — MZDConnect</span>
            {cargando && <span className="text-gray-500 text-xs">Cargando datos...</span>}
            {!cargando && !error && (
              <span className="text-gray-500 text-xs">{datosFiltrados.length} de {datos.length} registros</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {filtrosActivos.length > 0 && (
              <div className="flex flex-wrap gap-1 items-center">
                {filtrosActivos.map(col => {
                  const colDef = COLUMNAS.find(c => c.key === col);
                  return (
                    <span key={col} className="bg-blue-100 border border-blue-300 text-blue-800 text-xs px-2 py-0.5 rounded flex items-center gap-1">
                      <strong>{colDef?.label || col}:</strong> {filtros[col]}
                      <button onClick={() => limpiarFiltro(col)} className="ml-1 text-blue-600 hover:text-red-600 font-bold">×</button>
                    </span>
                  );
                })}
                <button onClick={limpiarTodosFiltros} className="text-xs text-red-600 hover:underline ml-1">Limpiar todo</button>
              </div>
            )}
            <button onClick={cargarDatos} className="bg-blue-800 text-white text-xs px-3 py-1 rounded hover:bg-blue-700">
              ↻ Actualizar
            </button>
          </div>
        </div>

        {error && <div className="text-red-600 text-xs mb-2">{error}</div>}

        {/* TABLA */}
        <div className="overflow-auto max-h-[calc(100vh-140px)] border border-gray-300 rounded" ref={dropdownRef}>
          <table className="text-xs border-collapse bg-white min-w-full">
            <thead className="sticky top-0 z-10">
              <tr className="bg-blue-900 text-white">
                {COLUMNAS.map(col => {
                  const tieneFiltr = !!filtros[col.key];
                  const estaAbierto = dropdownAbierto === col.key;
                  return (
                    <th key={col.key} className="border border-blue-700 px-2 py-1 whitespace-nowrap text-left relative">
                      <div className="flex items-center gap-1">
                        <span className="flex-1">{col.label}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDropdownAbierto(estaAbierto ? null : col.key as string);
                            setBusquedaDropdown(prev => ({ ...prev, [col.key]: "" }));
                          }}
                          className={`text-xs px-1 rounded border ${tieneFiltr ? "bg-yellow-400 text-blue-900 border-yellow-500 font-bold" : "bg-blue-800 text-white border-blue-600 hover:bg-blue-700"}`}
                          title="Filtrar"
                        >
                          ▼
                        </button>
                      </div>
                      {estaAbierto && (
                        <div className="absolute top-full left-0 z-50 bg-white border border-gray-300 shadow-lg min-w-[200px] max-h-[300px] flex flex-col" style={{ marginTop: "2px" }}>
                          <div className="p-2 border-b border-gray-200 bg-gray-50">
                            <input
                              autoFocus
                              className="w-full border border-gray-300 px-2 py-1 text-xs text-gray-800 focus:outline-none focus:border-blue-500"
                              placeholder="Buscar..."
                              value={busquedaDropdown[col.key] || ""}
                              onChange={e => setBusquedaDropdown(prev => ({ ...prev, [col.key as string]: e.target.value }))}
                              onClick={e => e.stopPropagation()}
                            />
                          </div>
                          <div className="overflow-y-auto flex-1">
                            {tieneFiltr && (
                              <div
                                className="px-3 py-1.5 hover:bg-blue-50 cursor-pointer text-red-600 font-medium border-b border-gray-100"
                                onClick={() => { limpiarFiltro(col.key as string); setDropdownAbierto(null); }}
                              >
                                ✕ Limpiar filtro
                              </div>
                            )}
                            {valoresUnicos(col.key as string).slice(0, 200).map(valor => (
                              <div
                                key={valor}
                                onClick={() => { toggleFiltroValor(col.key as string, valor); setDropdownAbierto(null); }}
                                className={`px-3 py-1.5 cursor-pointer hover:bg-blue-50 text-gray-800 flex items-center gap-2 ${filtros[col.key] === valor ? "bg-blue-100 font-semibold" : ""}`}
                              >
                                <span className={`w-3 h-3 border rounded-sm flex-shrink-0 flex items-center justify-center text-xs ${filtros[col.key] === valor ? "bg-blue-600 border-blue-600 text-white" : "border-gray-400"}`}>
                                  {filtros[col.key] === valor ? "✓" : ""}
                                </span>
                                <span className="truncate">{valor || "(vacío)"}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {cargando ? (
                <tr>
                  <td colSpan={COLUMNAS.length} className="text-center py-8 text-gray-500">
                    Cargando datos de MZDConnect...
                  </td>
                </tr>
              ) : datosFiltrados.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNAS.length} className="text-center py-8 text-gray-500">
                    No hay registros que coincidan con los filtros aplicados.
                  </td>
                </tr>
              ) : (
                datosFiltrados.map((u, i) => {
                  const vencido = servicioVencido(u["Serv. Hasta"]);
                  const porVencer = servicioPorVencer(u["Serv. Hasta"]);
                  return (
                    <tr
                      key={i}
                      className={`hover:bg-blue-50 ${vencido ? "bg-red-50" : porVencer ? "bg-yellow-50" : i % 2 === 0 ? "bg-white" : "bg-gray-50"}`}
                    >
                      {COLUMNAS.map(col => {
                        const val = u[col.key];
                        const esHasta = col.key === "Serv. Hasta";
                        const esFecha = col.key === "Serv. Desde" || col.key === "Serv. Hasta" || col.key === "Fecha Ultimo Reporte";
                        let className = "border border-gray-200 px-2 py-0.5 whitespace-nowrap";
                        if (esHasta) {
                          if (vencido) className += " text-red-700 font-semibold";
                          else if (porVencer) className += " text-yellow-700 font-semibold";
                        }
                        return (
                          <td key={col.key} className={className}>
                            {esHasta ? (
                              <span className="flex items-center gap-1">
                                {formatFecha(String(val ?? ""))}
                                {vencido && <span className="bg-red-500 text-white text-xs px-1 rounded ml-1">Vencido</span>}
                                {porVencer && !vencido && <span className="bg-yellow-400 text-black text-xs px-1 rounded ml-1">Por vencer</span>}
                              </span>
                            ) : esFecha ? (
                              formatFecha(String(val ?? ""))
                            ) : (
                              String(val ?? "")
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
