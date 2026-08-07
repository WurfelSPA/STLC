import { redirect } from "next/navigation";
import { getSession } from "@/app/lib/session";
import { getSupabaseAdmin } from "@/app/lib/supabaseAdmin";
import Navbar from "@/app/components/Navbar";
import UsuariosForm from "./UsuariosForm";

export default async function UsuariosPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.usuario !== "amelendez") redirect("/");

  const supabase = getSupabaseAdmin();
  const { data: usuarios } = await supabase
    .from("usuarios")
    .select("usuario, created_at")
    .order("created_at", { ascending: true });

  return (
    <div className="min-h-screen bg-gray-100 text-sm">
      <Navbar />
      <div className="p-6 max-w-2xl mx-auto">
        <h1 className="text-lg font-bold text-blue-900 mb-4">Usuarios del portal</h1>
        <UsuariosForm usuarios={usuarios || []} />
      </div>
    </div>
  );
}
