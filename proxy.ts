import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/app/lib/sessionToken";

// Rutas de página que no requieren sesión. Las rutas /api/* quedan fuera
// del matcher (no pasan por acá) porque cada una maneja su propia
// autorización (ej. /api/clientes/santamarta con su Bearer key,
// /api/sync con CRON_SECRET para el cron de Vercel).
const PUBLIC_PATHS = ["/login"];

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.includes(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Excluye /api/*, assets internos de Next y cualquier archivo estático
  // servido desde /public (logo.png, favicon.ico, icon.png, *.svg, etc.)
  // — si no, esos archivos también quedan atrás del login y se rompen en
  // páginas públicas como /login (el logo salía roto: la petición a
  // /logo.png se redirigía a /login por falta de sesión).
  matcher: ["/((?!api|_next/static|_next/image|.*\\.(?:png|jpg|jpeg|svg|ico|webp|gif)$).*)"],
};
