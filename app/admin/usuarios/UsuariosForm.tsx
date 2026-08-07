"use client";

import { useActionState } from "react";
import { addUsuarioAction, deleteUsuarioAction } from "@/app/lib/actions";

type Usuario = { usuario: string; created_at: string };

export default function UsuariosForm({ usuarios }: { usuarios: Usuario[] }) {
  const [state, formAction, pending] = useActionState(addUsuarioAction, undefined);

  return (
    <div className="space-y-6">
      <div className="bg-white border border-gray-300 rounded p-4">
        <h2 className="font-semibold text-gray-700 mb-3">Agregar usuario</h2>
        <form action={formAction} className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Usuario</label>
            <input
              name="usuario"
              required
              placeholder="rnieto"
              className="border border-gray-300 px-2 py-1 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Contraseña</label>
            <input
              name="password"
              type="text"
              required
              placeholder="Rn2026"
              className="border border-gray-300 px-2 py-1 rounded text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            disabled={pending}
            className="bg-blue-800 text-white text-sm px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {pending ? "Guardando..." : "Agregar"}
          </button>
        </form>
        {state?.error && <p className="text-red-600 text-xs mt-2">{state.error}</p>}
        {state?.success && <p className="text-green-600 text-xs mt-2">{state.success}</p>}
      </div>

      <div className="bg-white border border-gray-300 rounded p-4">
        <h2 className="font-semibold text-gray-700 mb-3">Usuarios existentes ({usuarios.length})</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="py-1">Usuario</th>
              <th className="py-1">Creado</th>
              <th className="py-1"></th>
            </tr>
          </thead>
          <tbody>
            {usuarios.map((u) => (
              <tr key={u.usuario} className="border-b border-gray-100">
                <td className="py-1.5 font-mono">{u.usuario}</td>
                <td className="py-1.5 text-gray-500">{new Date(u.created_at).toLocaleDateString("es-CL")}</td>
                <td className="py-1.5 text-right">
                  {u.usuario !== "amelendez" && (
                    <form action={deleteUsuarioAction.bind(null, u.usuario)}>
                      <button className="text-red-600 hover:underline text-xs">Eliminar</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
