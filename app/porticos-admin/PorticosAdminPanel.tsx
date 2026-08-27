"use client";

import { useActionState, useState, useTransition } from "react";
import {
  buscarVehiculoTracklinkAction,
  agregarVehiculoPorticosAction,
  eliminarVehiculoPorticosAction,
  asignarVehiculoAction,
  agregarUsuarioPorticosAction,
  actualizarPasswordUsuarioAction,
  eliminarUsuarioPorticosAction,
  type BuscarVehiculoResultado,
} from "@/app/lib/porticosAdminActions";

type Vehiculo = {
  id: string;
  patente: string;
  imei: string | null;
  unit_id: number;
  empresa: string;
  es_prueba_interna: boolean;
  orden: number;
  cliente_usuario: string | null;
  origen: string;
};

type Cliente = { usuario: string; empresa: string; es_admin: boolean; created_at: string };

export default function PorticosAdminPanel({ vehiculos, clientes }: { vehiculos: Vehiculo[]; clientes: Cliente[] }) {
  return (
    <div className="space-y-8">
      <VehiculosSeccion vehiculos={vehiculos} clientes={clientes} />
      <UsuariosSeccion clientes={clientes} vehiculos={vehiculos} />
    </div>
  );
}

function VehiculosSeccion({ vehiculos, clientes }: { vehiculos: Vehiculo[]; clientes: Cliente[] }) {
  const [origen, setOrigen] = useState<"tracklink" | "terceros">("tracklink");
  const [query, setQuery] = useState("");
  const [resultados, setResultados] = useState<BuscarVehiculoResultado[]>([]);
  const [seleccion, setSeleccion] = useState<BuscarVehiculoResultado | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [state, formAction, pending] = useActionState(agregarVehiculoPorticosAction, undefined);
  const [, startTransition] = useTransition();

  async function buscar(q: string) {
    setQuery(q);
    setSeleccion(null);
    if (q.trim().length < 2) { setResultados([]); return; }
    setBuscando(true);
    const r = await buscarVehiculoTracklinkAction(q);
    setResultados(r);
    setBuscando(false);
  }

  return (
    <div className="bg-white border border-gray-300 rounded p-4">
      <h2 className="font-semibold text-gray-700 mb-3">Vehículos del portal de pórticos</h2>

      <div className="flex gap-6 mb-3 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={origen === "tracklink"} onChange={() => setOrigen("tracklink")} />
          Vehículo existente en Tracklink
        </label>
        <label className="flex items-center gap-1.5 text-gray-400 cursor-not-allowed" title="Próximamente">
          <input type="radio" disabled checked={origen === "terceros"} onChange={() => setOrigen("terceros")} />
          GPS de un tercero (próximamente)
        </label>
      </div>

      {origen === "tracklink" ? (
        <form action={formAction} className="mb-4">
          <input type="hidden" name="origen" value="tracklink" />
          <input type="hidden" name="patente" value={seleccion?.placa || ""} />
          <input type="hidden" name="imei" value={seleccion?.imei || ""} />
          <input type="hidden" name="unitId" value={seleccion?.unitId ?? ""} />
          <div className="mb-2">
            <label className="block text-xs text-gray-500 mb-1">Buscar por patente, alias o cliente/empresa (ya sincronizado, sin login a TrackGTS)</label>
            <input
              value={query}
              onChange={(e) => buscar(e.target.value)}
              placeholder="ej: VVJG-14 o KCERDA"
              className="border border-gray-300 px-2 py-1 rounded text-sm w-80 focus:outline-none focus:border-blue-500"
            />
            {buscando && <span className="text-xs text-gray-400 ml-2">buscando...</span>}
          </div>

          {resultados.length > 0 && !seleccion && (
            <div className="border border-gray-200 rounded mb-2 max-h-48 overflow-y-auto">
              {resultados.map((r) => (
                <button
                  type="button"
                  key={r.imei}
                  onClick={() => setSeleccion(r)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 border-b border-gray-100 flex justify-between"
                >
                  <span className="font-mono">{r.placa || "(sin placa)"}</span>
                  <span className="text-gray-500">{r.alias} — {r.clienteEmpresa}</span>
                </button>
              ))}
            </div>
          )}

          {seleccion && (
            <div className="flex flex-wrap items-end gap-3 bg-blue-50 border border-blue-200 rounded p-2 mb-2">
              <div className="text-xs">
                Seleccionado: <span className="font-mono font-semibold">{seleccion.placa}</span> — {seleccion.alias}
                <button type="button" onClick={() => setSeleccion(null)} className="ml-2 text-red-600 hover:underline">quitar</button>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Nombre para mostrar (alias/cliente)</label>
                <input
                  name="empresa"
                  defaultValue={seleccion.clienteEmpresa || seleccion.alias}
                  className="border border-gray-300 px-2 py-1 rounded text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <button disabled={pending} className="bg-blue-800 text-white text-sm px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50">
                {pending ? "Agregando..." : "Agregar a pórticos"}
              </button>
            </div>
          )}
        </form>
      ) : (
        <div className="text-xs text-gray-400 italic mb-4">
          Registrar vehículos con GPS de un proveedor distinto a Tracklink todavía no está implementado.
        </div>
      )}

      {state?.error && <p className="text-red-600 text-xs mb-3">{state.error}</p>}
      {state?.success && <p className="text-green-600 text-xs mb-3">{state.success}</p>}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-200">
            <th className="py-1">Patente</th>
            <th className="py-1">Alias</th>
            <th className="py-1">Unit ID</th>
            <th className="py-1">Cliente asignado</th>
            <th className="py-1"></th>
          </tr>
        </thead>
        <tbody>
          {vehiculos.map((v) => (
            <tr key={v.id} className="border-b border-gray-100">
              <td className="py-1.5 font-mono">{v.patente}</td>
              <td className="py-1.5">{v.empresa}</td>
              <td className="py-1.5 font-mono text-gray-500">{v.unit_id}</td>
              <td className="py-1.5">
                <select
                  defaultValue={v.cliente_usuario || ""}
                  onChange={(e) => startTransition(() => asignarVehiculoAction(v.id, e.target.value || null))}
                  className="border border-gray-300 rounded text-xs px-1.5 py-1"
                >
                  <option value="">— sin asignar (solo admins) —</option>
                  {clientes.filter((c) => !c.es_admin).map((c) => (
                    <option key={c.usuario} value={c.usuario}>{c.usuario} ({c.empresa})</option>
                  ))}
                </select>
              </td>
              <td className="py-1.5 text-right">
                <button
                  onClick={() => startTransition(() => eliminarVehiculoPorticosAction(v.id))}
                  className="text-red-600 hover:underline text-xs"
                >
                  Eliminar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsuariosSeccion({ clientes, vehiculos }: { clientes: Cliente[]; vehiculos: Vehiculo[] }) {
  const [state, formAction, pending] = useActionState(agregarUsuarioPorticosAction, undefined);
  const [stateClave, formActionClave, pendingClave] = useActionState(actualizarPasswordUsuarioAction, undefined);
  const [, startTransition] = useTransition();
  const sinAsignar = vehiculos.filter((v) => !v.cliente_usuario);

  return (
    <div className="bg-white border border-gray-300 rounded p-4">
      <h2 className="font-semibold text-gray-700 mb-3">Usuarios del portal de pórticos</h2>

      <form action={formAction} className="flex flex-wrap items-end gap-3 mb-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Usuario (ej: KCERDA)</label>
          <input name="usuario" required placeholder="KCERDA" className="border border-gray-300 px-2 py-1 rounded text-sm focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Nombre para mostrar</label>
          <input name="empresa" required placeholder="Karina Cerda" className="border border-gray-300 px-2 py-1 rounded text-sm focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Contraseña</label>
          <input name="password" type="text" required defaultValue="1234" placeholder="clave inicial, ej: 1234" className="border border-gray-300 px-2 py-1 rounded text-sm w-56 focus:outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Asignar vehículo</label>
          <select name="vehiculoId" className="border border-gray-300 rounded text-xs px-1.5 py-1.5">
            <option value="">— ninguno por ahora —</option>
            {sinAsignar.map((v) => (
              <option key={v.id} value={v.id}>{v.patente} ({v.empresa})</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" name="esAdmin" /> Ve todas las unidades
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" name="verificar" /> Verificar contra TrackGTS
        </label>
        <button disabled={pending} className="bg-blue-800 text-white text-sm px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50">
          {pending ? "Guardando..." : "Agregar"}
        </button>
      </form>
      <p className="text-xs text-gray-400 mb-3">
        Clave inicial sugerida: 1234 (el cliente debería cambiarla). "Verificar contra TrackGTS" hace UNA sola llamada
        al confirmar (no en cada login del cliente) — solo tiene sentido si ya pusiste la clave real del cliente en vez
        de la inicial.
      </p>
      {state?.error && <p className="text-red-600 text-xs mb-3">{state.error}</p>}
      {state?.success && (
        <p className="text-green-600 text-xs mb-3">
          {state.success}
          {state.avisoVerificacion ? ` (${state.avisoVerificacion})` : ""}
        </p>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-200">
            <th className="py-1">Usuario</th>
            <th className="py-1">Nombre</th>
            <th className="py-1">Alcance</th>
            <th className="py-1">Vehículos</th>
            <th className="py-1"></th>
          </tr>
        </thead>
        <tbody>
          {clientes.map((c) => (
            <tr key={c.usuario} className="border-b border-gray-100">
              <td className="py-1.5 font-mono">{c.usuario}</td>
              <td className="py-1.5">{c.empresa}</td>
              <td className="py-1.5">{c.es_admin ? "Todas las unidades" : "Solo asignados"}</td>
              <td className="py-1.5 font-mono text-xs text-gray-500">
                {c.es_admin ? "—" : vehiculos.filter((v) => v.cliente_usuario === c.usuario).map((v) => v.patente).join(", ") || "ninguno"}
              </td>
              <td className="py-1.5 text-right">
                <button
                  onClick={() => startTransition(() => eliminarUsuarioPorticosAction(c.usuario))}
                  className="text-red-600 hover:underline text-xs"
                >
                  Eliminar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 pt-3 border-t border-gray-200">
        <h3 className="font-semibold text-gray-600 text-xs mb-2">Cambiar contraseña de un usuario existente</h3>
        <form action={formActionClave} className="flex flex-wrap items-end gap-3">
          <select name="usuario" required className="border border-gray-300 rounded text-xs px-1.5 py-1.5">
            <option value="">— elegir usuario —</option>
            {clientes.map((c) => (
              <option key={c.usuario} value={c.usuario}>{c.usuario} ({c.empresa})</option>
            ))}
          </select>
          <input name="password" type="text" required placeholder="nueva contraseña" className="border border-gray-300 px-2 py-1 rounded text-sm w-56 focus:outline-none focus:border-blue-500" />
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" name="verificar" /> Verificar contra TrackGTS
          </label>
          <button disabled={pendingClave} className="bg-blue-800 text-white text-sm px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50">
            {pendingClave ? "Guardando..." : "Actualizar"}
          </button>
        </form>
        {stateClave?.error && <p className="text-red-600 text-xs mt-2">{stateClave.error}</p>}
        {stateClave?.success && (
          <p className="text-green-600 text-xs mt-2">
            {stateClave.success}{stateClave.avisoVerificacion ? ` (${stateClave.avisoVerificacion})` : ""}
          </p>
        )}
      </div>
    </div>
  );
}
