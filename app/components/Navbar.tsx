"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type NavbarProps = {
  paginaActiva?: "home" | "renovaciones" | "healthchecktracklink" | "healthcheckmazda";
  onHome?: () => void;
};

type SyncResultado = {
  success: boolean;
  rateLimited?: boolean;
  message: string;
};

export default function Navbar({ paginaActiva, onHome }: NavbarProps) {
  const router = useRouter();
  const [reportesAbierto, setReportesAbierto] = useState(false);
  const [sincState, setSincState] = useState<"idle" | "loading" | "done">("idle");
  const [msgTracklink, setMsgTracklink] = useState("");
  const [msgMZD, setMsgMZD] = useState("");

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
    setMsgTracklink("Sincronizando Tracklink...");
    setMsgMZD("Sincronizando MZDConnect...");

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

          {/* MENÚ REPORTES */}
          <div className="relative">
            <button onClick={() => setReportesAbierto(!reportesAbierto)} className="hover:text-yellow-300">
              Reportes ▾
            </button>
            {reportesAbierto && (
              <div className="absolute top-full left-0 bg-white text-blue-900 shadow-lg rounded min-w-[160px] z-50 mt-1">
                <a
                  href="https://wurfelspa.github.io/tracklink-santamarta/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-4 py-2 text-xs hover:bg-blue-50 font-semibold"
                  onClick={() => setReportesAbierto(false)}
                >
                  Santa Marta
                </a>
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
          {sincState === "loading" ? "Sincronizando..." : "API actualizar"}
        </button>
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
