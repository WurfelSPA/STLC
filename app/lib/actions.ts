"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/app/lib/supabaseAdmin";
import { hashPassword, verifyPassword } from "@/app/lib/auth";
import { createSession, deleteSession, getSession } from "@/app/lib/session";

const ADMIN_USER = "amelendez";

export type LoginState = { error?: string } | undefined;

export async function loginAction(_state: LoginState, formData: FormData): Promise<LoginState> {
  const usuario = String(formData.get("usuario") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!usuario || !password) {
    return { error: "Ingresa usuario y contraseña." };
  }

  // El usuario "admin" (acceso a /porticos-admin) es un caso especial: su
  // contraseña vive en la variable de entorno PORTICOS_ADMIN_PASSWORD, no en
  // la tabla "usuarios" — así no hay que generar/guardar un hash para él.
  if (usuario === "admin") {
    const claveAdmin = process.env.PORTICOS_ADMIN_PASSWORD;
    if (!claveAdmin || password !== claveAdmin) {
      return { error: "Usuario o contraseña incorrectos." };
    }
    await createSession("admin");
    redirect("/");
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("usuarios")
    .select("usuario, password_hash")
    .eq("usuario", usuario)
    .maybeSingle();

  if (error || !data || !verifyPassword(password, data.password_hash)) {
    return { error: "Usuario o contraseña incorrectos." };
  }

  await createSession(data.usuario);
  redirect("/");
}

export async function logoutAction() {
  await deleteSession();
  redirect("/login");
}

export type UsuarioActionState = { error?: string; success?: string } | undefined;

export async function addUsuarioAction(_state: UsuarioActionState, formData: FormData): Promise<UsuarioActionState> {
  const session = await getSession();
  if (!session || session.usuario !== ADMIN_USER) {
    return { error: "No autorizado." };
  }

  const usuario = String(formData.get("usuario") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!/^[a-z0-9._-]{3,32}$/.test(usuario)) {
    return { error: "El usuario debe tener 3-32 caracteres (letras, números, punto, guión)." };
  }
  if (password.length < 6) {
    return { error: "La contraseña debe tener al menos 6 caracteres." };
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("usuarios")
    .insert({ usuario, password_hash: hashPassword(password) });

  if (error) {
    if (error.code === "23505") return { error: `El usuario "${usuario}" ya existe.` };
    return { error: "Error al guardar: " + error.message };
  }

  revalidatePath("/admin/usuarios");
  return { success: `Usuario "${usuario}" creado.` };
}

export async function deleteUsuarioAction(usuario: string) {
  const session = await getSession();
  if (!session || session.usuario !== ADMIN_USER) return;
  if (usuario === ADMIN_USER) return;

  const supabase = getSupabaseAdmin();
  await supabase.from("usuarios").delete().eq("usuario", usuario);
  revalidatePath("/admin/usuarios");
}
