"use client";

import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import Navbar from "../components/Navbar";

const supabase = createClient(
  "https://lomkolhgmkvshucqjuhf.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvbWtvbGhnbWt2c2h1Y3FqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MDUyNTUsImV4cCI6MjA5MDI4MTI1NX0.I_13jMA2DAa6Jzff4VBQitezdR2kfrXSVacaBn0QZbo"
);

const USUARIOS_EXCLUIDOS = ["bodega", "emiliano", "INSTALACIONES", "mautobahn", "PERDIDOS", "REVISION", "RECICLADAS", "sparejam", "sparejam-MDB"];
const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const ANIOS = [2030,2029,2028,2027,2026,2025,2024];

const TIPOS_SERVICIO = [
  "TRACKLINK",
  "MIGRACION AUTOBAHN",
  "AUTOBAHN NUEVOS",
  "COORP MENSUALIZADO",
  "SANTANDER CONSUMER",
  "G. MORALES-CONTADO",
  "CANTAGALLO-CONTADO",
  "REFERIDO",
];

const COLORES_SERVICIO: Record<string, string> = {
  "TRACKLINK":           "bg-blue-100 text-blue-800 border-blue-300",
  "MIGRACION AUTOBAHN":  "bg-red-100 text-red-800 border-red-300",
  "AUTOBAHN NUEVOS":     "bg-orange-100 text-orange-800 border-orange-300",
  "COORP MENSUALIZADO":  "bg-green-100 text-green-800 border-green-300",
  "SANTANDER CONSUMER":  "bg-pink-100 text-pink-800 border-pink-300",
  "G. MORALES-CONTADO":  "bg-teal-100 text-teal-800 border-teal-300",
  "CANTAGALLO-CONTADO":  "bg-slate-100 text-slate-800 border-slate-300",
  "REFERIDO":            "bg-yellow-100 text-yellow-800 border-yellow-300",
};

const COLORES_ACTIVO: Record<string, string> = {
  "TRACKLINK":           "bg-blue-600 text-white border-blue-700",
  "MIGRACION AUTOBAHN":  "bg-red-600 text-white border-red-700",
  "AUTOBAHN NUEVOS":     "bg-orange-500 text-white border-orange-600",
  "COORP MENSUALIZADO":  "bg-green-600 text-white border-green-700",
  "SANTANDER CONSUMER":  "bg-pink-600 text-white border-pink-700",
  "G. MORALES-CONTADO":  "bg-teal-600 text-white border-teal-700",
  "CANTAGALLO-CONTADO":  "bg-slate-600 text-white border-slate-700",
  "REFERIDO":            "bg-yellow-500 text-white border-yellow-600",
};

type Registro = {
  Nombre: string;
  Apellido: string;
  "Cust ID": string;
  Direccion: string;
  Correo: string;
  Telefono: string;
  "Cliente/Empresa": string;
  Usuario: string;
  Alias: string;
  Placa: string;
  "Año": string;
  "Serv. Desde": string;
  "Serv. Hasta": string;
  "Servicio Comercial": string;
  "Modelo AVL": string;
  Comentarios: string;
};

type OrdenKey = "Usuario" | "Serv. Hasta" | "Nombre";

const parseFecha = (f: string): Date | null => {
  if (!f) return null;
  const s = f.split("T")[0].trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s);
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
    const [d, m, y] = s.split("-");
    return new Date(`${y}-${m}-${d}`);
  }
  return null;
};

const getTipo = (r: Registro) => {
  const sc = (r["Servicio Comercial"] ?? "").trim();
  return sc === "" ? "TRACKLINK" : sc;
};

export default function Renovaciones() {
  const router = useRouter();
  const [datos, setDatos] = useState<Registro[]>([]);
  const [cargando, setCargando] = useState(true);
  const [filtroUsuario, setFiltroUsuario] = useState("");
  const [filtrosTipo, setFiltrosTipo] = useState<string[]>([]);
  const [filtroAnio, setFiltroAnio] = useState(new Date().getFullYear().toString());
  const [filtroMes, setFiltroMes] = useState(MESES[new Date().getMonth()]);
  const [filtroBusqueda, setFiltroBusqueda] = useState("");
  const [filtroNombre, setFiltroNombre] = useState("");
  const [filtroApellido, setFiltroApellido] = useState("");
  const [orden, setOrden] = useState<OrdenKey>("Serv. Hasta");
  const [soloVencidos, setSoloVencidos] = useState(false);
  const [soloPorVencer, setSoloPorVencer] = useState(false);

  useEffect(() => { cargarDatos(); }, []);

  const cargarDatos = async () => {
    setCargando(true);
    let todos: Registro[] = [];
    let desde = 0;
    while (true) {
      const { data } = await supabase.from("Tracklink").select("*").range(desde, desde + 999);
      if (!data || data.length === 0) break;
      todos = [...todos, ...data as Registro[]];
      if (data.length < 1000) break;
      desde += 1000;
    }
    setDatos(todos.filter(r => !USUARIOS_EXCLUIDOS.includes(r.Usuario) && !!r["Serv. Hasta"]));
    setCargando(false);
  };

  const formatFecha = (f: string) => {
    const d = parseFecha(f);
    return d ? d.toISOString().split("T")[0] : "";
  };

  const vencido = (hasta: string) => {
    const d = parseFecha(hasta);
    if (!d) return false;
    return d < new Date(new Date().toISOString().split("T")[0]);
  };

  const porVencer = (hasta: string) => {
    const d = parseFecha(hasta);
    if (!d) return false;
    const hoy = new Date(new Date().toISOString().split("T")[0]);
    const diff = (d.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 60;
  };

  const toggleTipo = (tipo: string) => {
    setFiltrosTipo(prev =>
      prev.includes(tipo) ? prev.filter(t => t !== tipo) : [...prev, tipo]
    );
  };

  const usuariosUnicos = Array.from(new Set(datos.map(r => r.Usuario))).sort();

  const datosFiltrados = datos
    .filter(r => {
      if (filtroUsuario && r.Usuario !== filtroUsuario) return false;
      if (filtrosTipo.length > 0 && !filtrosTipo.includes(getTipo(r))) return false;
      const fecha = parseFecha(r["Serv. Hasta"]);
      if (!fecha) return false;
      if (filtroAnio && fecha.getFullYear().toString() !== filtroAnio) return false;
      if (filtroMes && fecha.getMonth() !== MESES.indexOf(filtroMes)) return false;
      if (soloVencidos && !vencido(r["Serv. Hasta"])) return false;
      if (soloPorVencer && !porVencer(r["Serv. Hasta"])) return false;
      if (filtroNombre && !(r.Nombre || "").toLowerCase().includes(filtroNombre.toLowerCase())) return false;
      if (filtroApellido && !(r.Apellido || "").toLowerCase().includes(filtroApellido.toLowerCase())) return false;
      if (filtroBusqueda) {
        const q = filtroBusqueda.toLowerCase();
        return [r.Nombre, r.Apellido, r["Cust ID"], r["Cliente/Empresa"], r.Alias, r.Placa, r.Correo, r.Telefono]
          .some(v => (v || "").toLowerCase().includes(q));
      }
      return true;
    })
    .sort((a, b) => {
      const va = a[orden] || "";
      const vb = b[orden] || "";
      return va < vb ? -1 : va > vb ? 1 : 0;
    });

  const totalVencidos = datos.filter(r => vencido(r["Serv. Hasta"])).length;
  const totalPorVencer = datos.filter(r => porVencer(r["Serv. Hasta"])).length;

  const rowColor = (r: Registro) => {
    if (vencido(r["Serv. Hasta"])) return "bg-red-50";
    if (porVencer(r["Serv. Hasta"])) return "bg-yellow-50";
    return "";
  };

  const limpiarFiltros = () => {
    setFiltroUsuario("");
    setFiltrosTipo([]);
    setFiltroAnio(new Date().getFullYear().toString());
    setFiltroMes(MESES[new Date().getMonth()]);
    setFiltroBusqueda("");
    setFiltroNombre("");
    setFiltroApellido("");
    setSoloVencidos(false);
    setSoloPorVencer(false);
  };

  return (
    <div className="min-h-screen bg-gray-100 text-sm">
      <Navbar paginaActiva="renovaciones" />
      <div className="p-4">
        {/* ESTADÍSTICAS */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <div className="bg-white border border-gray-200 rounded p-3 text-center">
            <div className="text-2xl font-bold text-blue-900">{cargando ? "..." : datos.length}</div>
            <div className="text-xs text-gray-500">Total registros</div>
          </div>
          <div className="bg-red-50 border border-red-200 rounded p-3 text-center cursor-pointer" onClick={() => { setSoloVencidos(!soloVencidos); setSoloPorVencer(false); }}>
            <div className="text-2xl font-bold text-red-700">{cargando ? "..." : totalVencidos}</div>
            <div className="text-xs text-red-600">Vencidos {soloVencidos && "✓"}</div>
          </div>
          <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-center cursor-pointer" onClick={() => { setSoloPorVencer(!soloPorVencer); setSoloVencidos(false); }}>
            <div className="text-2xl font-bold text-yellow-700">{cargando ? "..." : totalPorVencer}</div>
            <div className="text-xs text-yellow-600">Por vencer (60 días) {soloPorVencer && "✓"}</div>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded p-3 text-center">
            <div className="text-2xl font-bold text-blue-700">{cargando ? "..." : datosFiltrados.length}</div>
            <div className="text-xs text-blue-600">Mostrando</div>
          </div>
        </div>

        {/* FILTROS */}
        <div className="bg-white border border-gray-200 rounded p-3 mb-3 flex flex-wrap gap-3 items-end">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Búsqueda libre</label>
            <input
              className="border border-gray-300 px-2 py-1 text-xs w-48 focus:outline-none focus:border-blue-500"
              placeholder="RUT, placa, correo..."
              value={filtroBusqueda}
              onChange={e => setFiltroBusqueda(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Nombre</label>
            <input
              className="border border-gray-300 px-2 py-1 text-xs w-32 focus:outline-none focus:border-blue-500"
              placeholder="Nombre..."
              value={filtroNombre}
              onChange={e => setFiltroNombre(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Apellido</label>
            <input
              className="border border-gray-300 px-2 py-1 text-xs w-32 focus:outline-none focus:border-blue-500"
              placeholder="Apellido..."
              value={filtroApellido}
              onChange={e => setFiltroApellido(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Usuario</label>
            <select
              className="border border-gray-300 px-2 py-1 text-xs w-40 focus:outline-none focus:border-blue-500"
              value={filtroUsuario}
              onChange={e => setFiltroUsuario(e.target.value)}
            >
              <option value="">Todos</option>
              {usuariosUnicos.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Año de vencimiento</label>
            <select
              className="border border-gray-300 px-2 py-1 text-xs w-28 focus:outline-none focus:border-blue-500"
              value={filtroAnio}
              onChange={e => setFiltroAnio(e.target.value)}
            >
              <option value="">Todos</option>
              {ANIOS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Mes de vencimiento</label>
            <select
              className="border border-gray-300 px-2 py-1 text-xs w-36 focus:outline-none focus:border-blue-500"
              value={filtroMes}
              onChange={e => setFiltroMes(e.target.value)}
            >
              <option value="">Todos</option>
              {MESES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Ordenar por</label>
            <select
              className="border border-gray-300 px-2 py-1 text-xs w-36 focus:outline-none focus:border-blue-500"
              value={orden}
              onChange={e => setOrden(e.target.value as OrdenKey)}
            >
              <option value="Serv. Hasta">Fecha vencimiento</option>
              <option value="Usuario">Usuario</option>
              <option value="Nombre">Nombre</option>
            </select>
          </div>
          <button
            onClick={limpiarFiltros}
            className="bg-gray-200 hover:bg-gray-300 text-xs px-3 py-1 border border-gray-300 rounded"
          >
            ✕ Limpiar filtros
          </button>
          <button
            onClick={cargarDatos}
            className="bg-blue-800 text-white text-xs px-3 py-1 rounded hover:bg-blue-700"
          >
            ↻ Actualizar
          </button>
        </div>

        {/* BOTONES TIPO SERVICIO */}
        <div className="bg-white border border-gray-200 rounded p-3 mb-3 flex flex-wrap gap-2 items-center">
          <span className="text-xs text-gray-500 mr-1">Tipo de servicio:</span>
          <button
            onClick={() => setFiltrosTipo([])}
            className={`text-xs px-3 py-1 rounded border font-medium transition-colors ${
              filtrosTipo.length === 0
                ? "bg-gray-700 text-white border-gray-800"
                : "bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-200"
            }`}
          >
            TODOS
          </button>
          {TIPOS_SERVICIO.map(tipo => {
            const activo = filtrosTipo.includes(tipo);
            return (
              <button
                key={tipo}
                onClick={() => toggleTipo(tipo)}
                className={`text-xs px-3 py-1 rounded border font-medium transition-colors ${
                  activo
                    ? COLORES_ACTIVO[tipo] || "bg-gray-600 text-white border-gray-700"
                    : (COLORES_SERVICIO[tipo] || "bg-gray-100 text-gray-800 border-gray-300") + " hover:opacity-80"
                }`}
              >
                {tipo}
              </button>
            );
          })}
        </div>

        {/* LEYENDA COLORES FILA */}
        <div className="flex gap-3 mb-2 flex-wrap">
          <span className="text-xs flex items-center gap-1"><span className="w-3 h-3 bg-red-200 inline-block rounded"></span> Vencido</span>
          <span className="text-xs flex items-center gap-1"><span className="w-3 h-3 bg-yellow-200 inline-block rounded"></span> Por vencer (≤60 días)</span>
        </div>

        {/* TABLA */}
        {cargando ? (
          <div className="text-center py-10 text-gray-500">Cargando renovaciones...</div>
        ) : (
          <div className="overflow-auto max-h-[calc(100vh-360px)] border border-gray-300 rounded">
            <table className="text-xs border-collapse bg-white min-w-full">
              <thead className="sticky top-0 z-10 bg-blue-900 text-white">
                <tr>
                  {["NOMBRE","APELLIDO","RUT","DIRECCIÓN","CORREO","TELÉFONO","CLIENTE/EMPRESA","USUARIO","ALIAS","PLACA","AÑO","SERV. DESDE","SERV. HASTA","TIPO SERVICIO","MODELO GPS"].map(h => (
                    <th key={h} className="border border-blue-700 px-2 py-1 whitespace-nowrap text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {datosFiltrados.length === 0 ? (
                  <tr><td colSpan={15} className="text-center py-8 text-gray-500">No hay registros con los filtros aplicados.</td></tr>
                ) : (
                  datosFiltrados.map((r, i) => {
                    const tipo = getTipo(r);
                    const colorServicio = COLORES_SERVICIO[tipo] || "bg-gray-100 text-gray-800 border-gray-300";
                    return (
                      <tr key={i} className={`hover:bg-blue-50 ${rowColor(r)}`}>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r.Nombre}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r.Apellido}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r["Cust ID"]}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r.Direccion}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r.Correo}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r.Telefono}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r["Cliente/Empresa"]}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r.Usuario}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r.Alias}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r.Placa}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r["Año"]}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{formatFecha(r["Serv. Desde"])}</td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap font-semibold">
                          <span className="flex items-center gap-1">
                            {formatFecha(r["Serv. Hasta"])}
                            {vencido(r["Serv. Hasta"]) && <span className="bg-red-500 text-white text-xs px-1 rounded">Vencido</span>}
                            {porVencer(r["Serv. Hasta"]) && !vencido(r["Serv. Hasta"]) && <span className="bg-yellow-400 text-black text-xs px-1 rounded">Por vencer</span>}
                          </span>
                        </td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">
                          <span className={`px-2 py-0.5 rounded text-xs ${colorServicio}`}>{tipo}</span>
                        </td>
                        <td className="border border-gray-200 px-2 py-0.5 whitespace-nowrap">{r["Modelo AVL"]}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
