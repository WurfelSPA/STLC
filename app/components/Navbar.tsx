"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { logoutAction } from "@/app/lib/actions";

type NavbarProps = {
  paginaActiva?: "home" | "renovaciones" | "healthchecktracklink" | "healthcheckmazda" | "porticos";
  onHome?: () => void;
};

type SyncResultado = {
  success: boolean;
  rateLimited?: boolean;
  message: string;
};

type ReportePdf = { label: string; url: string; filename: string };

type ClienteReporte = {
  nombre: string;
  webApp: string;
  pdfs: ReportePdf[];
};

const REPORTES: ClienteReporte[] = [
  {
    nombre: "AGP - Pórticos",
    webApp: "https://tracklink-porticos.vercel.app/",
    pdfs: [],
  },
  {
    nombre: "Santa Marta",
    webApp: "https://wurfelspa.github.io/tracklink-santamarta/",
    pdfs: [
      { label: "Informe Ejecutivo — Excesos de Velocidad", url: "https://raw.githubusercontent.com/wurfelspa/tracklink-santamarta/main/reporte-semanal.pdf", filename: "Informe_Ejecutivo_Excesos_Velocidad_SANTAMARTA.pdf" },
    ],
  },
  {
    nombre: "Visibility",
    webApp: "https://wurfelspa.github.io/tracklink-visibility/",
    pdfs: [],
  },
  {
    nombre: "Kadel",
    webApp: "https://wurfelspa.github.io/tracklink-kadel/",
    pdfs: [
      { label: "Informe Ejecutivo — Excesos de Velocidad", url: "https://raw.githubusercontent.com/wurfelspa/tracklink-kadel/main/reporte-semanal.pdf", filename: "Informe_Ejecutivo_Excesos_Velocidad_KADEL.pdf" },
      { label: "Informe Ejecutivo — Ranking Fuera de Horario", url: "https://raw.githubusercontent.com/wurfelspa/tracklink-kadel/main/ranking-fuera-horario.pdf", filename: "Informe_Ejecutivo_Ranking_Fuera_Horario_KADEL.pdf" },
    ],
  },
  {
    nombre: "Enerfrost",
    webApp: "https://wurfelspa.github.io/tracklink-enerfrost/",
    pdfs: [
      { label: "Informe Ejecutivo — Excesos de Velocidad", url: "https://raw.githubusercontent.com/wurfelspa/tracklink-enerfrost/main/reporte-semanal.pdf", filename: "Informe_Ejecutivo_Excesos_Velocidad_ENERFROST.pdf" },
      { label: "Informe Ejecutivo — Ralentí Excesivo", url: "https://raw.githubusercontent.com/wurfelspa/tracklink-enerfrost/main/reporte-ralenti.pdf", filename: "Informe_Ejecutivo_Ralenti_Excesivo_ENERFROST.pdf" },
    ],
  },
];

export default function Navbar({ paginaActiva, onHome }: NavbarProps) {
  const router = useRouter();
  const [reportesAbierto, setReportesAbierto] = useState(false);
  const [clienteAbierto, setClienteAbierto] = useState<string | null>(null);
  const [sincState, setSincState] = useState<"idle" | "loading" | "done">("idle");
  const [msgTracklink, setMsgTracklink] = useState("");
  const [msgMZD, setMsgMZD] = useState("");
  const [usuario, setUsuario] = useState<string | null>(null);
  const reportesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (reportesRef.current && !reportesRef.current.contains(e.target as Node)) {
        setReportesAbierto(false);
        setClienteAbierto(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    fetch("/api/whoami")
      .then((res) => (res.ok ? res.json() : { usuario: null }))
      .then((data) => setUsuario(data.usuario))
      .catch(() => setUsuario(null));
  }, []);

  const cerrarReportes = () => {
    setReportesAbierto(false);
    setClienteAbierto(null);
  };

  const btnClass = (pagina: string) =>
    paginaActiva === pagina
      ? "text-yellow-300 underline font-semibold"
      : "hover:text-yellow-300";

  const handleHome = () => {
    setReportesAbierto(false);
    if (onHome) onHome();
    else router.push("/");
  };

  const handleSync = async () => {
    if (sincState === "loading") return;
    setSincState("loading");
    setMsgTracklink("Consultando estado...");
    setMsgMZD("Consultando estado...");

    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();

      setMsgTracklink(data.tracklink?.message ?? "Sin respuesta de Tracklink.");
      setMsgMZD(data.mzd?.message ?? "Sin respuesta de MZDConnect.");
      setSincState("done");
    } catch {
      setMsgTracklink("❌ Error de conexión con el servidor.");
      setMsgMZD("❌ Error de conexión con el servidor.");
      setSincState("done");
    }

    setTimeout(() => {
      setSincState("idle");
      setMsgTracklink("");
      setMsgMZD("");
    }, 8000);
  };

  const msgColor = (msg: string) => {
    if (msg.includes("✅")) return "bg-green-100 text-green-800";
    if (msg.includes("Rate limit") || msg.includes("~20")) return "bg-yellow-100 text-yellow-800";
    return "bg-red-100 text-red-800";
  };

  return (
    <div>
      <nav className="bg-blue-900 text-white px-4 py-2 flex items-center gap-6">
        <a href="https://www.tracklink.cl/" target="_blank" rel="noopener noreferrer">
          <img src="/logo.png" alt="Tracklink" className="h-8 shrink-0 cursor-pointer" />
        </a>
        <div className="flex gap-6 font-semibold flex-1 items-center">
          <button onClick={handleHome} className={btnClass("home")}>Home</button>
          <button onClick={() => { setReportesAbierto(false); router.push("/renovaciones"); }} className={btnClass("renovaciones")}>Renovaciones</button>
          <button onClick={() => { setReportesAbierto(false); router.push("/healthchecktracklink"); }} className={btnClass("healthchecktracklink")}>Tracklink Healthcheck</button>
          <button onClick={() => { setReportesAbierto(false); router.push("/healthcheckmazda"); }} className={btnClass("healthcheckmazda")}>Mazda Healthcheck</button>
          {usuario === "admin" && (
            <button onClick={() => { setReportesAbierto(false); router.push("/porticos-admin"); }} className={btnClass("porticos")}>Pórticos</button>
          )}

          {/* MENÚ REPORTES */}
          <div className="relative" ref={reportesRef}>
            <button onClick={() => setReportesAbierto(!reportesAbierto)} className="hover:text-yellow-300">
              Reportes ▾
            </button>
            {reportesAbierto && (
              <div className="absolute top-full left-0 bg-white text-blue-900 shadow-lg rounded min-w-[160px] z-50 mt-1">
                {REPORTES.map(cliente => (
                  <div
                    key={cliente.nombre}
                    className="relative"
                    onMouseEnter={() => setClienteAbierto(cliente.nombre)}
                  >
                    <button
                      onClick={() => setClienteAbierto(clienteAbierto === cliente.nombre ? null : cliente.nombre)}
                      className={`w-full flex items-center justify-between gap-4 px-4 py-2 text-xs hover:bg-blue-50 font-semibold ${clienteAbierto === cliente.nombre ? "bg-blue-50" : ""}`}
                    >
                      {cliente.nombre}
                      <span className="text-[9px] text-gray-400">▸</span>
                    </button>
                    {clienteAbierto === cliente.nombre && (
                      <div className="absolute top-0 left-full bg-white text-blue-900 shadow-lg rounded min-w-[240px] z-50">
                        <a
                          href={cliente.webApp}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block px-4 py-2 text-xs hover:bg-blue-50 font-semibold border-b border-gray-100"
                          onClick={cerrarReportes}
                        >
                          🌐 Abrir Web App
                        </a>
                        {cliente.pdfs.length === 0 && (
                          <div className="px-4 py-2 text-xs text-gray-400 italic">Sin reporte PDF disponible</div>
                        )}
                        {cliente.pdfs.map(pdf => (
                          <a
                            key={pdf.url}
                            href={pdf.url}
                            download={pdf.filename}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block px-4 py-2 text-xs hover:bg-blue-50"
                            onClick={cerrarReportes}
                          >
                            📄 {pdf.label}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* BOTÓN API */}
        <button
          onClick={handleSync}
          disabled={sincState === "loading"}
          className={`text-xs px-3 py-1 rounded shrink-0 transition-colors ${
            sincState === "loading"
              ? "bg-yellow-200 text-yellow-900 cursor-wait"
              : "bg-gray-200 text-blue-900 hover:bg-white"
          }`}
        >
          {sincState === "loading" ? "Consultando..." : "Ver estado API"}
        </button>

        {/* USUARIO / SESIÓN */}
        {usuario && (
          <div className="flex items-center gap-3 text-xs shrink-0">
            {usuario === "amelendez" && (
              <button onClick={() => router.push("/admin/usuarios")} className="hover:text-yellow-300">
                Usuarios
              </button>
            )}
            <span className="text-blue-200">👤 {usuario}</span>
            <button onClick={() => logoutAction()} className="bg-gray-200 text-blue-900 px-3 py-1 rounded hover:bg-white">
              Cerrar sesión
            </button>
          </div>
        )}
      </nav>

      {/* MENSAJES DE ESTADO */}
      {sincState === "done" && (msgTracklink || msgMZD) && (
        <div className="flex gap-2 px-4 py-1">
          {msgTracklink && (
            <div className={`text-xs px-3 py-1.5 rounded flex-1 text-center font-medium ${msgColor(msgTracklink)}`}>
              <span className="font-bold">Tracklink:</span> {msgTracklink}
            </div>
          )}
          {msgMZD && (
            <div className={`text-xs px-3 py-1.5 rounded flex-1 text-center font-medium ${msgColor(msgMZD)}`}>
              <span className="font-bold">MZDConnect:</span> {msgMZD}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
