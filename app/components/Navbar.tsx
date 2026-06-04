"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type NavbarProps = {
  paginaActiva?: "home" | "renovaciones" | "healthchecktracklink" | "healthcheckmazda";
  onHome?: () => void;
};

export default function Navbar({ paginaActiva, onHome }: NavbarProps) {
  const router = useRouter();
  const [reportesAbierto, setReportesAbierto] = useState(false);
  const [sincState, setSincState] = useState<"idle" | "loading" | "ok" | "warning" | "error">("idle");
  const [sincMsg, setSincMsg] = useState("");

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
    setSincMsg("Conectando con la API...");

    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();

      if (res.status === 429 || data.rateLimited) {
        setSincState("warning");
        setSincMsg(data.message);
      } else if (data.success) {
        setSincState("ok");
        setSincMsg(data.message);
      } else {
        setSincState("error");
        setSincMsg(data.message || "Error desconocido.");
      }
    } catch {
      setSincState("error");
      setSincMsg("No se pudo conectar con el servidor.");
    }

    setTimeout(() => { setSincState("idle"); setSincMsg(""); }, 6000);
  };

  const btnSincColor = {
    idle:    "bg-gray-200 text-blue-900 hover:bg-white",
    loading: "bg-yellow-200 text-yellow-900 cursor-wait",
    ok:      "bg-green-200 text-green-900",
    warning: "bg-yellow-300 text-yellow-900",
    error:   "bg-red-200 text-red-900",
  }[sincState];

  const btnSincLabel = {
    idle:    "API actualizar",
    loading: "Sincronizando...",
    ok:      "✅ Actualizado",
    warning: "⚠️ Rate limit",
    error:   "❌ Error",
  }[sincState];

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
          className={`text-xs px-3 py-1 rounded shrink-0 transition-colors ${btnSincColor}`}
        >
          {btnSincLabel}
        </button>
      </nav>

      {/* MENSAJE DE ESTADO */}
      {sincMsg && sincState !== "idle" && sincState !== "loading" && (
        <div className={`text-xs px-4 py-2 text-center font-medium ${
          sincState === "ok"      ? "bg-green-100 text-green-800" :
          sincState === "warning" ? "bg-yellow-100 text-yellow-800" :
                                    "bg-red-100 text-red-800"
        }`}>
          {sincMsg}
        </div>
      )}
    </div>
  );
}
