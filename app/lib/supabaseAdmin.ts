import "server-only";
import { createClient } from "@supabase/supabase-js";

// Cliente con la service_role key — solo para uso server-side (Server
// Actions / Route Handlers). Nunca importar desde un componente "use client".
// La tabla "usuarios" tiene RLS activado sin policies, así que la anon key
// (expuesta en el resto de la app) no puede leerla ni escribirla.
export function getSupabaseAdmin() {
  const url = "https://lomkolhgmkvshucqjuhf.supabase.co";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error("Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
