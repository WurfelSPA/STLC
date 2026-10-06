"use client";

import { useEffect, useRef, useState } from "react";
import type { Mensaje } from "@/app/lib/renovaciones/tipos";
import { ESTADO_LABEL } from "@/app/lib/renovaciones/tipos";
import {
  cambiarEstadoAction, marcarAtendidoAction, marcarTrackgtsAction, obtenerConversacionAction,
  simularMensajeAction, validarPagoAction, type CasoPanel,
} from "@/app/lib/renovaciones/acciones";
import { BadgeEstado, BadgePrioridad, fechaCorta, pesosCL } from "./ui";
import TrackyAnimado from "../components/TrackyAnimado";

type Conversacion = { caso: CasoPanel; mensajes: Mensaje[] };

const RESPUESTAS_RAPIDAS = ["1", "2", "3", "4", "Sí", "No", "24 meses", "¿Cuánto cuesta?", "Mi GPS no funciona", "Vendí el auto", "MENÚ"];

// Conversación de un caso (vista tipo WhatsApp) + acciones del ejecutivo.
// En simulación, la caja de texto escribe COMO EL CLIENTE.
export default function DetalleCaso({ casoId, onCambio }: { casoId: string; onCambio: () => void }) {
  const [conv, setConv] = useState<Conversacion | null>(null);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");
  const [plazo, setPlazo] = useState(12);
  const [nota, setNota] = useState("");
  const finRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let vigente = true;
    setConv(null);
    obtenerConversacionAction(casoId).then(c => { if (vigente) { setConv(c); if (c?.caso.plazo_meses) setPlazo(c.caso.plazo_meses); } });
    return () => { vigente = false; };
  }, [casoId]);

  useEffect(() => { finRef.current?.scrollIntoView({ behavior: "smooth" }); }, [conv?.mensajes.length]);

  const ejecutar = async (fn: () => Promise<Conversacion | null>) => {
    setEnviando(true);
    setError("");
    try {
      const c = await fn();
      if (c) setConv(c);
      onCambio();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
    setEnviando(false);
  };

  const enviar = (t: string, adjunto = false) => {
    if (!t.trim() && !adjunto) return;
    setTexto("");
    ejecutar(() => simularMensajeAction(casoId, t, adjunto));
  };

  if (!conv) return <div className="p-6 text-gray-500">Cargando conversación...</div>;
  const { caso, mensajes } = conv;

  return (
    <div className="flex flex-col h-full">
      {/* Cabecera del caso */}
      <div className="p-3 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-blue-900 text-base">{caso.nombre || caso.usuario}</span>
          <BadgeEstado estado={caso.estado} />
          <BadgePrioridad p={caso.prioridad} />
          <span className="text-xs px-2 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-800">{caso.linea}</span>
          {caso.segmento && <span className="text-xs text-gray-500">{caso.segmento}</span>}
          {caso.opt_out && <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-white">No contactar</span>}
        </div>
        <div className="text-xs text-gray-600 mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5">
          <span>📱 {caso.telefono ? `+${caso.telefono}` : <em className="text-red-600">sin móvil válido</em>}</span>
          <span>✉️ {caso.correo || "—"}</span>
          <span>RUT: {caso.rut || "—"} · {caso.tipo_cliente}</span>
          <span>Vence: <b>{fechaCorta(caso.fecha_vencimiento)}</b> · Contactos: {caso.hitos_enviados.join(", ") || "—"}</span>
        </div>
        <div className="text-xs mt-1 flex flex-wrap gap-1">
          {caso.vehiculos.map(v => (
            <span key={v.imei} className="bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">
              🚗 {v.placa || "(sin patente)"} · {v.marca} {v.modelo} · {fechaCorta(v.vence)}
            </span>
          ))}
        </div>
        {!!caso.contexto?.comentario_origen && (
          <div className="text-xs mt-1 text-blue-900 bg-blue-50 border border-blue-200 rounded px-2 py-1">Nota de la planilla: {String(caso.contexto.comentario_origen)}</div>
        )}
        {caso.motivo && <div className="text-xs mt-1 text-orange-800 bg-orange-50 border border-orange-200 rounded px-2 py-1">Motivo: {caso.motivo}</div>}
      </div>

      {/* Mensajes */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-[#ece5dd]">
        {mensajes.length === 0 && (
          <div className="flex justify-center pt-2"><TrackyAnimado alto={150} estado={enviando ? "hablando" : "normal"} /></div>
        )}
        {mensajes.length === 0 &&<div className="text-center text-xs text-gray-500 py-6">{caso.piloto
          ? "Sin mensajes todavía. Envía un aviso desde la pestaña Piloto, o escríbele \"hola\" al número del bot desde este teléfono."
          : "Sin mensajes todavía. Ejecuta la campaña para enviar el primer contacto."}</div>}
        {mensajes.map(m => m.direccion === "nota" ? (
          <div key={m.id} className="text-center">
            <span className="inline-block text-[11px] bg-yellow-50 border border-yellow-200 text-yellow-900 rounded px-2 py-0.5">
              {m.texto} · {new Date(m.creado_en).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" })}
            </span>
          </div>
        ) : (
          <div key={m.id} className={`flex ${m.direccion === "in" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-1.5 shadow-sm whitespace-pre-wrap text-[13px] ${m.direccion === "in" ? "bg-[#dcf8c6]" : "bg-white"}`}>
              {m.tipo && m.direccion === "out" && /^D\d+$/.test(m.tipo) && (
                <div className="text-[10px] font-semibold text-blue-700 mb-0.5">Contacto automático {m.tipo}</div>
              )}
              {!!m.meta?.adjunto && <div className="text-[11px] text-gray-600 mb-0.5">📎 {String(m.meta.adjunto)}</div>}
              {m.texto}
              {!!m.meta?.error && <div className="text-[11px] text-red-700 bg-red-50 rounded px-1 mt-1">❌ No llegó: {String(m.meta.error)}</div>}
              {!!m.meta?.no_enviado && <div className="text-[11px] text-amber-800 bg-amber-50 rounded px-1 mt-1">No enviado por WhatsApp: {String(m.meta.no_enviado)}</div>}
              <div className="text-[10px] text-gray-400 text-right mt-0.5">
                {m.canal === "whatsapp" ? "WhatsApp · " : ""}{new Date(m.creado_en).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          </div>
        ))}
        {enviando && mensajes.length > 0 && (
          <div className="flex items-end gap-2">
            <TrackyAnimado alto={56} estado="hablando" />
            <span className="text-[11px] text-gray-600 bg-white rounded-lg px-2 py-1 shadow-sm">Tracky está escribiendo…</span>
          </div>
        )}
        <div ref={finRef} />
      </div>

      {/* Simulador: escribir como el cliente */}
      {caso.simulacion && (
        <div className="border-t border-gray-200 bg-white p-2">
          <div className="text-[11px] text-gray-500 mb-1">Simulador — escribe como si fueras el cliente:</div>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {RESPUESTAS_RAPIDAS.map(r => (
              <button key={r} disabled={enviando} onClick={() => enviar(r)}
                className="text-xs px-2 py-0.5 rounded-full border border-green-300 bg-green-50 hover:bg-green-100 disabled:opacity-50">{r}</button>
            ))}
            <button disabled={enviando} onClick={() => enviar("", true)}
              className="text-xs px-2 py-0.5 rounded-full border border-gray-300 bg-gray-50 hover:bg-gray-100 disabled:opacity-50">📎 Enviar comprobante</button>
          </div>
          <div className="flex gap-2">
            <input value={texto} onChange={e => setTexto(e.target.value)} onKeyDown={e => e.key === "Enter" && enviar(texto)}
              placeholder="Mensaje del cliente..." disabled={enviando}
              className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-green-600" />
            <button onClick={() => enviar(texto)} disabled={enviando}
              className="bg-green-600 text-white text-xs px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">{enviando ? "..." : "Enviar"}</button>
          </div>
        </div>
      )}

      {/* Acciones del ejecutivo */}
      <div className="border-t border-gray-200 bg-gray-50 p-2 space-y-2">
        {error && <div className="text-xs text-red-600">{error}</div>}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-700">Ejecutivo:</span>
          {caso.estado !== "RENOVADO" && (
            <>
              <select value={plazo} onChange={e => setPlazo(Number(e.target.value))} className="text-xs border border-gray-300 rounded px-1 py-0.5">
                {[12, 24, 36, 48].map(m => <option key={m} value={m}>{m} meses</option>)}
              </select>
              <button disabled={enviando} onClick={() => ejecutar(() => validarPagoAction(casoId, plazo))}
                className="text-xs px-2 py-1 rounded bg-green-700 text-white hover:bg-green-800 disabled:opacity-50">✅ Validar pago y confirmar</button>
            </>
          )}
          {caso.estado === "RENOVADO" && !caso.trackgts_actualizado && (
            <button disabled={enviando} onClick={() => ejecutar(() => marcarTrackgtsAction(casoId))}
              className="text-xs px-2 py-1 rounded bg-blue-700 text-white hover:bg-blue-800 disabled:opacity-50">
              Ya actualicé TrackGTS ({caso.nueva_fecha_vencimiento ? fechaCorta(caso.nueva_fecha_vencimiento) : "—"})
            </button>
          )}
          {caso.estado === "RENOVADO" && (
            <span className="text-xs text-green-800">Renovado {caso.plazo_meses} meses{caso.monto ? ` · ${pesosCL(caso.monto)}` : ""} · {caso.cerrado_por === "externo" ? "detectado en TrackGTS" : caso.trackgts_actualizado ? "TrackGTS ✔" : "TrackGTS pendiente"}</span>
          )}
        </div>
        {caso.estado !== "RENOVADO" && (
          <div className="flex flex-wrap items-center gap-2">
            <input value={nota} onChange={e => setNota(e.target.value)} placeholder="Nota / motivo (opcional)"
              className="flex-1 min-w-[160px] text-xs border border-gray-300 rounded px-2 py-1" />
            {caso.requiere_ejecutivo && !caso.atendido && (
              <button disabled={enviando} onClick={() => { ejecutar(() => marcarAtendidoAction(casoId, nota)); setNota(""); }}
                className="text-xs px-2 py-1 rounded bg-gray-700 text-white hover:bg-gray-800 disabled:opacity-50">Marcar atendido</button>
            )}
            <button disabled={enviando} onClick={() => { ejecutar(() => cambiarEstadoAction(casoId, "NO_RENUEVA", nota)); setNota(""); }}
              className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 bg-white hover:bg-red-50 disabled:opacity-50">Cerrar: no renueva</button>
          </div>
        )}
        <div className="text-[10px] text-gray-400">Estado: {ESTADO_LABEL[caso.estado]} · Paso del bot: {caso.paso}</div>
      </div>
    </div>
  );
}
