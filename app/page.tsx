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

    const campos = ["IMEI", "Placa", "Cliente/Empresa", "Usuario"];
    let encontrados: Unidad[] = [];
    let origen = "";

    for (const campo of campos) {
      const { data } = await supabase
        .from("Tracklink")
        .select("*")
        .eq(campo, buscar.trim());
      if (data && data.length > 0) {
        encontrados = data as Unidad[];
        origen = "BD: Tracklink";
        break;
      }
    }

    if (encontrados.length === 0) {
      for (const campo of campos) {
        const { data } = await supabase
          .from("MZDConnect")
          .select("*")
          .eq(campo, buscar.trim());
        if (data && data.length > 0) {
          encontrados = data as Unidad[];
          origen = "BD: MZDConnect";
          break;
        }
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
    const { error } = await supabase
      .from(tabla)
      .update({ Comentarios: comentarios })
      .eq("IMEI", seleccionada.IMEI);
    setGuardando(false);
    setMensajeGuardado(error ? "❌ Error al guardar" : "✅ Guardado");
    setTimeout(() => setMensajeGuardado(""), 3000);
  };

  return (
    <div className="min-h-screen bg-gray-100 text-sm">
      <nav className="bg-blue-900 text-white px-4 py-2 flex items-center gap-6">
  <a href="https://www.tracklink.cl/" target="_blank" rel="noopener noreferrer">
    <img src="/logo.png" alt="Tracklink" className="h-8 shrink-0 cursor-pointer" />
  </a>
  <div className="flex gap-6 font-semibold flex-1">
    <button onClick={() => router.push("/")} className="hover:text-yellow-300">Home</button>
    <button onClick={() => router.push("/renovaciones")} className="hover:text-yellow-300">Renovaciones</button>
    <button className="hover:text-yellow-300">Instalaciones</button>
    <button onClick={() => router.push("/healthchecktracklink")} className="hover:text-yellow-300">Tracklink Healthcheck</button>
    <button onClick={() => router.push("/healthcheckmazda")} className="hover:text-yellow-300">Mazda Healthcheck</button>
  </div>
  <button className="bg-gray-200 text-blue-900 text-xs px-3 py-1 rounded hover:bg-white shrink-0">API actualizar</button>
</nav>

      <div className="p-4">
        {/* BÚSQUEDA */}
        <div className="flex items-center gap-3 mb-1">
          <span className="text-blue-900 font-bold text-lg">Buscar</span>
          <input
            className="border border-gray-400 px-2 py-1 w-72 focus:outline-none focus:border-blue-600"
            value={buscar}
            onChange={e => setBuscar(e.target.value)}
            onKeyDown={e => e.key === "Enter" && buscarAsync()}
            placeholder="IMEI, Placa, Cliente o Usuario"
          />
          {buscando && <span className="text-gray-500">Consultando...</span>}
        </div>
        <p className="text-gray-500 text-xs mb-3 ml-16">Presione ENTER para continuar...</p>

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
                  <Campo label="Serie SIM" value={seleccionada["Serie SIM"]} />
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
                  <Campo label="RUT / Identificación" value={seleccionada["Cust ID"]} />
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
