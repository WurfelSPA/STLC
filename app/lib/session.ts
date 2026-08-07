import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, SESSION_DURATION_SECONDS, createSessionToken, verifySessionToken, type SessionPayload } from "@/app/lib/sessionToken";

export async function createSession(usuario: string) {
  const token = createSessionToken(usuario);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}

export async function deleteSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}
