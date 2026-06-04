"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@supabase/supabase-js";

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

export default function Home() {
  const router = useRouter();
  const [buscar, setBuscar] = useState("");
  const [resultados, setResultados] = useState<Unidad[]>([]);
  const [seleccionada, setSeleccionada] = useState<Unidad | null>(null);
  const [comentarios, setComentarios] = useState("");
  const [bdOrigen, setBdOrigen] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [mensajeGuardado, setMensajeGuardado] = useState("");

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

  const buscarAsync = async () => {
    if (!buscar.trim()) return;
    setBuscando(true);
    setResultados([]);
    setSeleccionada(null);
    setBdOrigen("");

    const campos = ["IMEI", "Placa", "Cliente/Empresa", "Usuario", "Cust ID", "Serie SIM"];
    let encontrados: Unidad[] = [];
    let origen = "";

    for (const campo of campos) {
      const { data } = await supabase.from("Tracklink").select("*").eq(campo, buscar.trim());
      if (data && data.length > 0) { encontrados = data as Unidad[]; origen = "BD: Tracklink"; break; }
    }

    if (encontrados.length === 0) {
      for (const campo of campos) {
        const { data } = await supabase.from("MZDConnect").select("*").eq(campo, buscar.trim());
        if (data && data.length > 0) { encontrados = data as Unidad[]; origen = "BD: MZDConnect"; break; }
      }
    }

    if (encontrados.length === 0) {
      alert("NO ENCONTRADO.");
    } else {
      setResultados(encontrados);
      setSeleccionada(encontrados[0]);
      setComentarios(encontrados[0].Comentarios || "");
      setBdOrigen(origen);
    }
    setBuscando(false);
  };

  const seleccionar = (u: Unidad) => {
    setSeleccionada(u);
    setComentarios(u.Comentarios || "");
  };

  const guardarComentario = async () => {
    if (!seleccionada) return;
    setGuardando(true);
    const tabla = bdOrigen.includes("MZD") ? "MZDConnect" : "Tracklink";
    const { error } = await supabase.from(tabla).update({ Comentarios: comentarios }).eq("IMEI", seleccionada.IMEI);
    setGuardando(false);
    setMensajeGuardado(error ? "❌ Error al guardar" : "✅ Guardado");
    setTimeout(() => setMensajeGuardado(""), 3000);
  };

  return (
    <div className="min-h-screen bg-gray-100 text-sm">
      {/* NAVBAR */}
      <nav className="bg-blue-900 text-white px-4 py-2 flex items-center gap-6">
        <a href="https://www.tracklink.cl/" target="_blank" rel="noopener noreferrer">
          <img src="/logo.png" alt="Tracklink" className="h-8 shrink-0 cursor-pointer" />
        </a>
        <div className="flex gap-6 font-semibold flex-1">
          <button onClick={() => { setBuscar(""); setSeleccionada(null); setResultados([]); setBdOrigen(""); }} className="hover:text-yellow-300">Home</button>
          <button onClick={() => router.push("/renovaciones")} className="hover:text-yellow-300">Renovaciones</button>
          <button className="hover:text-yellow-300">Instalaciones</button>
          <button onClick={() => router.push("/healthchecktracklink")} className="hover:text-yellow-300">Tracklink Healthcheck</button>
          <button onClick={() => router.push("/healthcheckmazda")} className="hover:text-yellow-300">Mazda Healthcheck</button>
        </div>
        <button className="bg-gray-200 text-blue-900 text-xs px-3 py-1 rounded hover:bg-white shrink-0">API actualizar</button>
      </nav>

      <div className="p-4 relative">
        {/* BÚSQUEDA */}
        <div className="flex items-center gap-3 mb-1">
          <span className="text-blue-900 font-bold text-lg">Buscar</span>
          <input
            className="border border-gray-400 px-2 py-1 w-72 focus:outline-none focus:border-blue-600"
            value={buscar}
            onChange={e => setBuscar(e.target.value)}
            onKeyDown={e => e.key === "Enter" && buscarAsync()}
            placeholder="IMEI, Placa, Cliente, Usuario o RUT"
          />
          {buscando && <span className="text-gray-500">Consultando...</span>}
        </div>
        <p className="text-gray-500 text-xs mb-3 ml-16">Presione ENTER para continuar...</p>

        {/* FONDO DECORATIVO */}
        {!seleccionada && (
          <div className="flex items-center justify-center mt-8 pointer-events-none select-none">
            <svg width="40%" viewBox="0 0 680 460" xmlns="http://www.w3.org/2000/svg">
              <style>{`
                .grid  { fill:none; stroke:#1e3a8a; stroke-width:0.5; opacity:0.07; }
                .ring  { fill:none; stroke:#1d4ed8; stroke-width:0.8; }
                .conn  { fill:none; stroke:#1d4ed8; stroke-width:0.6; opacity:0.10; }
                .node  { fill:#1d4ed8; }
                .pin-c { fill:#1e40af; }
                .pin-s { fill:none; stroke:#1e40af; stroke-width:1; }
                .lbl   { font-family:sans-serif; font-size:10px; fill:#1e3a8a; font-weight:500; letter-spacing:0.05em; }
                .sublbl{ font-family:sans-serif; font-size:9px; fill:#1e3a8a; opacity:0.5; }
                .beam  { fill:none; stroke:#1d4ed8; stroke-width:0.5; stroke-dasharray:3,4; opacity:0.12; }
              `}</style>
              <defs>
                <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                  <path d="M40 0 L0 0 L0 40" className="grid"/>
                </pattern>
              </defs>
              <rect width="680" height="460" fill="url(#grid)" opacity="0.6"/>
              <circle cx="100" cy="100" r="4" className="node" opacity="0.15"/>
              <circle cx="200" cy="60"  r="4" className="node" opacity="0.15"/>
              <circle cx="320" cy="90"  r="4" className="node" opacity="0.15"/>
              <circle cx="460" cy="70"  r="4" className="node" opacity="0.15"/>
              <circle cx="560" cy="110" r="4" className="node" opacity="0.15"/>
              <circle cx="620" cy="200" r="4" className="node" opacity="0.15"/>
              <circle cx="580" cy="340" r="4" className="node" opacity="0.15"/>
              <circle cx="480" cy="400" r="4" className="node" opacity="0.15"/>
              <circle cx="360" cy="380" r="4" className="node" opacity="0.15"/>
              <circle cx="200" cy="360" r="4" className="node" opacity="0.15"/>
              <circle cx="80"  cy="300" r="4" className="node" opacity="0.15"/>
              <circle cx="60"  cy="180" r="4" className="node" opacity="0.15"/>
              <circle cx="160" cy="220" r="4" className="node" opacity="0.12"/>
              <circle cx="420" cy="270" r="4" className="node" opacity="0.12"/>
              <circle cx="500" cy="180" r="4" className="node" opacity="0.12"/>
              <circle cx="260" cy="300" r="4" className="node" opacity="0.12"/>
              <g className="conn">
                <line x1="100" y1="100" x2="200" y2="60"/>
                <line x1="200" y1="60"  x2="320" y2="90"/>
                <line x1="320" y1="90"  x2="460" y2="70"/>
                <line x1="460" y1="70"  x2="560" y2="110"/>
                <line x1="560" y1="110" x2="620" y2="200"/>
                <line x1="620" y1="200" x2="580" y2="340"/>
                <line x1="580" y1="340" x2="480" y2="400"/>
                <line x1="480" y1="400" x2="360" y2="380"/>
                <line x1="360" y1="380" x2="200" y2="360"/>
                <line x1="200" y1="360" x2="80"  y2="300"/>
                <line x1="80"  y1="300" x2="60"  y2="180"/>
                <line x1="60"  y1="180" x2="100" y2="100"/>
                <line x1="160" y1="220" x2="100" y2="100"/>
                <line x1="160" y1="220" x2="200" y2="360"/>
                <line x1="160" y1="220" x2="260" y2="300"/>
                <line x1="260" y1="300" x2="200" y2="360"/>
                <line x1="260" y1="300" x2="360" y2="380"/>
                <line x1="420" y1="270" x2="500" y2="180"/>
                <line x1="420" y1="270" x2="480" y2="400"/>
                <line x1="500" y1="180" x2="560" y2="110"/>
                <line x1="500" y1="180" x2="620" y2="200"/>
                <line x1="320" y1="90"  x2="160" y2="220"/>
                <line x1="460" y1="70"  x2="420" y2="270"/>
              </g>
              <circle cx="340" cy="230" r="45"  className="ring" opacity="0.08"/>
              <circle cx="340" cy="230" r="90"  className="ring" opacity="0.06"/>
              <circle cx="340" cy="230" r="135" className="ring" opacity="0.04"/>
              <circle cx="340" cy="230" r="180" className="ring" opacity="0.03"/>
              <line x1="295" y1="230" x2="385" y2="230" stroke="#1d4ed8" strokeWidth="0.5" opacity="0.06"/>
              <line x1="340" y1="185" x2="340" y2="275" stroke="#1d4ed8" strokeWidth="0.5" opacity="0.06"/>
              <circle cx="340" cy="222" r="12" className="pin-c" opacity="0.18"/>
              <circle cx="340" cy="222" r="5"  fill="#fff" opacity="0.25"/>
              <path d="M340 234 L333 250 L340 246 L347 250 Z" className="pin-c" opacity="0.18"/>
              <circle cx="340" cy="222" r="20" className="pin-s" opacity="0.08"/>
              <circle cx="340" cy="222" r="28" className="pin-s" opacity="0.05"/>
              <g opacity="0.14">
                <circle cx="160" cy="220" r="7" className="pin-c"/>
                <path d="M160 227 L156 236 L160 234 L164 236 Z" className="pin-c"/>
                <circle cx="160" cy="220" r="13" className="pin-s" opacity="0.6"/>
              </g>
              <g opacity="0.14">
                <circle cx="500" cy="180" r="7" className="pin-c"/>
                <path d="M500 187 L496 196 L500 194 L504 196 Z" className="pin-c"/>
                <circle cx="500" cy="180" r="13" className="pin-s" opacity="0.6"/>
              </g>
              <g opacity="0.10">
                <circle cx="260" cy="300" r="6" className="pin-c"/>
                <path d="M260 306 L257 313 L260 311 L263 313 Z" className="pin-c"/>
              </g>
              <g opacity="0.10">
                <circle cx="420" cy="270" r="6" className="pin-c"/>
                <path d="M420 276 L417 283 L420 281 L423 283 Z" className="pin-c"/>
              </g>
              <g transform="translate(590,50) rotate(-30)" opacity="0.10">
                <rect x="-18" y="-4" width="36" height="8" rx="2" fill="#1d4ed8"/>
                <rect x="-30" y="-2" width="10" height="4" rx="1" fill="#1d4ed8"/>
                <rect x="20"  y="-2" width="10" height="4" rx="1" fill="#1d4ed8"/>
                <circle cx="0" cy="0" r="3" fill="#fff" opacity="0.3"/>
              </g>
              <line x1="590" y1="50" x2="340" y2="222" className="beam"/>
              <line x1="590" y1="50" x2="160" y2="220" className="beam"/>
              <line x1="590" y1="50" x2="500" y2="180" className="beam"/>
              <g transform="translate(75,290)" opacity="0.10">
                <rect x="0" y="6" width="32" height="14" rx="3" fill="#1e40af"/>
                <rect x="5" y="0" width="22" height="10" rx="2" fill="#1e40af"/>
                <circle cx="7"  cy="21" r="4" fill="#1e40af"/>
                <circle cx="25" cy="21" r="4" fill="#1e40af"/>
              </g>
              <g transform="translate(530,370)" opacity="0.10">
                <rect x="0" y="6" width="32" height="14" rx="3" fill="#1e40af"/>
                <rect x="5" y="0" width="22" height="10" rx="2" fill="#1e40af"/>
                <circle cx="7"  cy="21" r="4" fill="#1e40af"/>
                <circle cx="25" cy="21" r="4" fill="#1e40af"/>
              </g>
              <g transform="translate(595,195)" opacity="0.10">
                <path d="M0,0 Q5,-8 10,0 Q15,8 20,0" stroke="#1d4ed8" strokeWidth="1.5" fill="none"/>
                <path d="M-5,0 Q5,-16 15,0 Q25,16 25,0" stroke="#1d4ed8" strokeWidth="1" fill="none"/>
              </g>
              <text x="340" y="440" className="lbl" textAnchor="middle" opacity="0.18">SISTEMA CENTRALIZADO TRACKLINK CHILE</text>
              <text x="340" y="454" className="sublbl" textAnchor="middle" opacity="0.15">Rastreo · Conectividad · Telemetría</text>
            </svg>
          </div>
        )}

        {seleccionada && (
          <>
            {/* PANELES */}
            <div className="grid grid-cols-4 gap-3 mb-3">
              {/* DISPOSITIVO GPS */}
              <div>
                <div className="bg-white border border-blue-400 p-2">
                  <div className="text-blue-700 font-bold border-b border-blue-300 mb-2 pb-1">DISPOSITIVO GPS</div>
                  <Campo label="IMEI" value={seleccionada.IMEI} highlight />
                  <Campo label="Fabricante" value={seleccionada["Fabricante AVL"]} />
                  <Campo label="Modelo" value={seleccionada["Modelo AVL"]} highlight={seleccionada["Modelo AVL"] === "GV300W"} />
                  <Campo label="Protocolo" value={seleccionada.Protocolo} />
                  <div className="mt-2 text-blue-700 font-bold border-b border-blue-300 mb-2 pb-1">SIM</div>
                  <Campo label="Serie SIM" value={seleccionada["Serie SIM"]} highlight />
                  <Campo label="Teléfono SIM" value={seleccionada["Teléfono SIM"]} />
                </div>
              </div>

              {/* VEHÍCULO */}
              <div>
                <div className="bg-white border border-blue-400 p-2">
                  <div className="text-blue-700 font-bold border-b border-blue-300 mb-2 pb-1">VEHÍCULO</div>
                  <Campo label="Alias" value={seleccionada.Alias} highlight />
                  <Campo label="Tipo" value={seleccionada.Tipo} />
                  <Campo label="Marca" value={seleccionada.Marca} />
                  <Campo label="Clase" value={seleccionada.Tipo} />
                  <Campo label="Modelo" value={seleccionada.Modelo} />
                  <Campo label="Año" value={seleccionada["Año"]} />
                  <Campo label="Placa" value={seleccionada.Placa} highlight />
                  <Campo label="Color" value={seleccionada.Color} />
                  <Campo label="Chasis / VIN" value={seleccionada.Chasis} />
                  <Campo label="Motor serial" value={seleccionada.Motor} />
                  <Campo label="Odómetro" value={seleccionada["Odómetro"]} />
                </div>
              </div>

              {/* CLIENTE */}
              <div>
                <div className="bg-white border border-blue-400 p-2">
                  <div className="text-blue-700 font-bold border-b border-blue-300 mb-2 pb-1">CLIENTE / EMPRESA</div>
                  <Campo label="Nombre Cliente / Empresa" value={seleccionada["Cliente/Empresa"]} highlight />
                  <Campo label="Usuario" value={seleccionada.Usuario} highlight />
                  <Campo label="RUT / Identificación" value={seleccionada["Cust ID"]} highlight />
                  <Campo label="Nombres" value={seleccionada.Nombre} />
                  <Campo label="Apellidos" value={seleccionada.Apellido} />
                  <Campo label="Teléfono" value={seleccionada.Telefono} />
                  <Campo label="Correo" value={seleccionada.Correo} />
                  <Campo label="Dirección" value={seleccionada.Direccion} />
                  <div className="mt-2">
                    <label className="text-gray-500 text-xs">Comentarios:</label>
                    <textarea
                      className="w-full border border-gray-300 text-xs p-1 mt-1 resize-none focus:outline-none focus:border-blue-500"
                      rows={4}
                      value={comentarios}
                      onChange={e => setComentarios(e.target.value)}
                    />
                    <div className="flex items-center gap-2 mt-1">
                      <button
                        onClick={guardarComentario}
                        disabled={guardando}
                        className="bg-gray-200 hover:bg-gray-300 text-xs px-3 py-1 border border-gray-400"
                      >
                        {guardando ? "Guardando..." : "Actualizar"}
                      </button>
                      {mensajeGuardado && <span className="text-xs">{mensajeGuardado}</span>}
                    </div>
                  </div>
                </div>
              </div>

              {/* SERVICIO */}
              <div>
                <div className="bg-white border border-blue-400 p-2">
                  <div className="text-blue-700 font-bold border-b border-blue-300 mb-2 pb-1">SERVICIO</div>
                  <Campo label="Servicio" value={seleccionada.Servicio} />
                  <Campo label="Servicio Comercial" value={seleccionada["Servicio Comercial"]} />
                  <CampoFecha label="Desde" value={formatFecha(seleccionada["Serv. Desde"])} />
                  <div className="flex items-center mb-1 gap-1">
                    <span className="text-gray-500 text-xs w-24 shrink-0">Hasta:</span>
                    <span className="border border-gray-300 bg-gray-50 px-1 py-0.5 text-xs w-24">
                      {formatFecha(seleccionada["Serv. Hasta"])}
                    </span>
                    <div className="flex gap-1 shrink-0">
                      {servicioVencido(seleccionada["Serv. Hasta"]) && (
                        <span className="bg-red-500 text-white text-xs px-1 rounded">Vencido</span>
                      )}
                      {servicioPorVencer(seleccionada["Serv. Hasta"]) && (
                        <span className="bg-yellow-400 text-black text-xs px-1 rounded">Por vencer</span>
                      )}
                    </div>
                  </div>
                  <Campo label="Tipo instalación" value={seleccionada.TipoInstalacion} />
                </div>
              </div>
            </div>

            {/* BD ORIGEN */}
            <div className="text-blue-700 font-bold mb-1">{bdOrigen}</div>

            {/* TABLA RESULTADOS */}
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse w-full bg-white">
                <thead>
                  <tr className="bg-gray-200">
                    {["IMEI","ODÓMETRO","FABRICANTE GPS","MODELO GPS","PROTOCOLO","SIM TELÉFONO","SIM SERIE","SERVICIO","SERVICIO CORPORATIVO","SERVICIO DESDE","SERVICIO HASTA","TIPO INSTALACIÓN","ALIAS","TIPO","MARCA","MODELO","AÑO","PLACA","COLOR"].map(h => (
                      <th key={h} className="border border-gray-300 px-2 py-1 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {resultados.map((u, i) => (
                    <tr
                      key={i}
                      onClick={() => seleccionar(u)}
                      className={`cursor-pointer hover:bg-blue-50 ${seleccionada?.IMEI === u.IMEI ? "bg-blue-100" : ""} ${servicioVencido(u["Serv. Hasta"]) ? "!bg-red-100" : servicioPorVencer(u["Serv. Hasta"]) ? "!bg-yellow-100" : ""}`}
                    >
                      <td className="border border-gray-300 px-2 py-0.5">{u.IMEI}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u["Odómetro"]}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u["Fabricante AVL"]}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u["Modelo AVL"]}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u.Protocolo}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u["Teléfono SIM"]}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u["Serie SIM"]}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u.Servicio}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u["Servicio Comercial"]}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{formatFecha(u["Serv. Desde"])}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{formatFecha(u["Serv. Hasta"])}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u.TipoInstalacion}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u.Alias}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u.Tipo}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u.Marca}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u.Modelo}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u["Año"]}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u.Placa}</td>
                      <td className="border border-gray-300 px-2 py-0.5">{u.Color}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Campo({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center mb-1 gap-1">
      <span className="text-gray-500 text-xs w-24 shrink-0">{label}:</span>
      <span className={`border px-1 py-0.5 text-xs flex-1 truncate ${highlight ? "bg-yellow-50 border-gray-400 font-semibold" : "border-gray-300 bg-gray-50"}`}>
        {value || ""}
      </span>
    </div>
  );
}

function CampoFecha({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center mb-1 gap-1">
      <span className="text-gray-500 text-xs w-24 shrink-0">{label}:</span>
      <span className="border border-gray-300 bg-gray-50 px-1 py-0.5 text-xs w-24">
        {value || ""}
      </span>
    </div>
  );
}
