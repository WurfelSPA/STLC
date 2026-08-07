// Firma/verificación de la cookie de sesión. Sin 'server-only' y sin
// dependencias de next/headers a propósito: este módulo lo importa tanto
// proxy.ts (raíz, NextRequest/NextResponse) como app/lib/session.ts
// (Server Actions/Route Handlers, cookies() de next/headers).
import { createHmac, timingSafeEqual } from "crypto";

export const SESSION_COOKIE_NAME = "tl_session";
export const SESSION_DURATION_SECONDS = 24 * 60 * 60; // 1 día

export type SessionPayload = {
  usuario: string;
  exp: number; // epoch ms
};

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("Falta la variable de entorno AUTH_SECRET");
  }
  return secret;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(data: string): string {
  return base64url(createHmac("sha256", getSecret()).update(data).digest());
}

export function createSessionToken(usuario: string): string {
  const payload: SessionPayload = {
    usuario,
    exp: Date.now() + SESSION_DURATION_SECONDS * 1000,
  };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  // Cualquier error (incluyendo AUTH_SECRET no configurado) se trata como
  // "sin sesión válida" — falla cerrado (redirige a /login) en vez de
  // tirar abajo el sitio completo con un 500 en cada request.
  try {
    if (!token) return null;
    const [payloadB64, signature] = token.split(".");
    if (!payloadB64 || !signature) return null;

    const expected = sign(payloadB64);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(base64urlToBuffer(payloadB64).toString("utf8")) as SessionPayload;
    if (!payload.usuario || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
