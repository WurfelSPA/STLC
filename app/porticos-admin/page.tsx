import { redirect } from "next/navigation";
import { getSession } from "@/app/lib/session";
import { getSupabaseAdmin } from "@/app/lib/supabaseAdmin";
import Navbar from "@/app/components/Navbar";
import PorticosAdminPanel from "./PorticosAdminPanel";

export default async function PorticosAdminPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.usuario !== "admin") redirect("/");

  const supabase = getSupabaseAdmin();
  const [{ data: vehiculos }, { data: clientes }] = await Promise.all([
    supabase
      .from("porticos_vehiculos")
      .select("id, patente, imei, unit_id, empresa, es_prueba_interna, orden, cliente_usuario, origen")
      .order("orden", { ascending: true }),
    supabase
      .from("porticos_clientes")
      .select("usuario, empresa, es_admin, created_at")
      .order("created_at", { ascending: true }),
  ]);

  return (
    <div className="min-h-screen bg-gray-100 text-sm">
      <Navbar paginaActiva="porticos" />
      <div className="p-6 max-w-5xl mx-auto">
        <h1 className="text-lg font-bold text-blue-900 mb-1">Pórticos — administración</h1>
        <p className="text-xs text-gray-500 mb-4">
          Gestiona los vehículos y usuarios del portal de clientes de pórticos (
          <a href="https://tracklink-porticos.vercel.app/" target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">
            tracklink-porticos.vercel.app
          </a>
          ). Solo visible para el usuario admin.
        </p>
        <PorticosAdminPanel vehiculos={vehiculos || []} clientes={clientes || []} />
      </div>
    </div>
  );
}
