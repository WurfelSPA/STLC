"use client";

import { useActionState } from "react";
import { loginAction } from "@/app/lib/actions";

export default function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, undefined);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="block text-xs text-gray-600 mb-1">Usuario</label>
        <input
          name="usuario"
          required
          autoFocus
          autoComplete="username"
          className="w-full border border-gray-300 px-3 py-2 rounded text-sm focus:outline-none focus:border-blue-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-600 mb-1">Contraseña</label>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full border border-gray-300 px-3 py-2 rounded text-sm focus:outline-none focus:border-blue-500"
        />
      </div>
      {state?.error && <p className="text-red-600 text-xs">{state.error}</p>}
      <button
        disabled={pending}
        type="submit"
        className="w-full bg-blue-800 text-white py-2 rounded text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? "Ingresando..." : "Ingresar"}
      </button>
    </form>
  );
}
