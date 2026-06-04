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

  const btnClass = (pagina: string) =>
    paginaActiva === pagina
      ? "text-yellow-300 underline font-semibold"
      : "hover:text-yellow-300";

  const handleHome = () => {
    setReportesAbierto(false);
    if (onHome) onHome();
    else router.push("/");
  };

  return (
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
          <button
            onClick={() => setReportesAbierto(!reportesAbierto)}
            className="hover:text-yellow-300"
          >
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

      <button className="bg-gray-200 text-blue-900 text-xs px-3 py-1 rounded hover:bg-white shrink-0">
        API actualizar
      </button>
    </nav>
  );
}
