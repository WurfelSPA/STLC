# Graph Report - STLC  (2026-08-27)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 177 nodes · 228 edges · 17 communities (12 shown, 5 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Navbar.tsx
- actions.ts
- compilerOptions
- package.json
- devDependencies
- session.ts
- renovaciones/page.tsx
- include
- sync-historial-santamarta.js
- sync/route.ts
- santamarta/route.ts
- layout.tsx
- eslint.config.mjs
- next.config.ts
- next-env.d.ts
- postcss.config.mjs
- vercel.json

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 16 edges
2. `getSession()` - 9 edges
3. `Navbar()` - 7 edges
4. `getSupabaseAdmin()` - 7 edges
5. `verifySessionToken()` - 7 edges
6. `include` - 7 edges
7. `addUsuarioAction()` - 6 edges
8. `loginAction()` - 6 edges
9. `createSessionToken()` - 5 edges
10. `sign()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `proxy()` --calls--> `verifySessionToken()`  [EXTRACTED]
  proxy.ts → app/lib/sessionToken.ts
- `UsuariosForm()` --indirect_call--> `addUsuarioAction()`  [INFERRED]
  app/admin/usuarios/UsuariosForm.tsx → app/lib/actions.ts
- `GET()` --calls--> `getSession()`  [EXTRACTED]
  app/api/whoami/route.ts → app/lib/session.ts
- `loginAction()` --calls--> `createSession()`  [EXTRACTED]
  app/lib/actions.ts → app/lib/session.ts
- `LoginForm()` --indirect_call--> `loginAction()`  [INFERRED]
  app/login/LoginForm.tsx → app/lib/actions.ts

## Import Cycles
- None detected.

## Communities (17 total, 5 thin omitted)

### Community 0 - "Navbar.tsx"
Cohesion: 0.09
Nodes (16): ClienteReporte, Navbar(), NavbarProps, ReportePdf, REPORTES, SyncResultado, COLUMNAS, supabase (+8 more)

### Community 1 - "actions.ts"
Cohesion: 0.18
Nodes (14): UsuariosPage(), Usuario, UsuariosForm(), GET(), addUsuarioAction(), deleteUsuarioAction(), loginAction(), LoginState (+6 more)

### Community 2 - "compilerOptions"
Cohesion: 0.11
Nodes (19): dom, dom.iterable, esnext, compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules (+11 more)

### Community 3 - "package.json"
Cohesion: 0.11
Nodes (17): next, dependencies, next, react, react-dom, @supabase/supabase-js, name, private (+9 more)

### Community 4 - "devDependencies"
Cohesion: 0.12
Nodes (17): eslint, eslint-config-next, devDependencies, eslint, eslint-config-next, tailwindcss, @tailwindcss/postcss, @types/node (+9 more)

### Community 5 - "session.ts"
Cohesion: 0.25
Nodes (13): createSession(), base64url(), base64urlToBuffer(), createSessionToken(), getSecret(), SESSION_COOKIE_NAME, SESSION_DURATION_SECONDS, SessionPayload (+5 more)

### Community 6 - "renovaciones/page.tsx"
Cohesion: 0.18
Nodes (12): ANIOS, COLORES_ACTIVO, COLORES_SERVICIO, getTipo(), MESES, OrdenKey, parseFecha(), Registro (+4 more)

### Community 7 - "include"
Cohesion: 0.20
Nodes (9): **/*.mts, .next/dev/types/**/*.ts, next-env.d.ts, .next/types/**/*.ts, node_modules, **/*.ts, **/*.tsx, exclude (+1 more)

### Community 8 - "sync-historial-santamarta.js"
Cohesion: 0.29
Nodes (9): { createClient }, fmtTL(), guardarCheckpoint(), loginYConsultarTravel(), main(), obtenerCheckpoint(), puppeteer, supabase (+1 more)

### Community 9 - "sync/route.ts"
Cohesion: 0.47
Nodes (5): GET(), POST(), sincronizar(), supabase, SyncResult

### Community 10 - "santamarta/route.ts"
Cohesion: 0.50
Nodes (4): GET(), IMEIS_SANTAMARTA, obtenerHistorial(), supabase

### Community 11 - "layout.tsx"
Cohesion: 0.40
Nodes (3): geistMono, geistSans, metadata

## Knowledge Gaps
- **85 isolated node(s):** `ClienteReporte`, `NavbarProps`, `ReportePdf`, `SyncResultado`, `Unidad` (+80 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Navbar()` connect `Navbar.tsx` to `actions.ts`, `renovaciones/page.tsx`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `devDependencies` to `package.json`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `compilerOptions` connect `compilerOptions` to `include`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `ClienteReporte`, `NavbarProps`, `ReportePdf` to the rest of the system?**
  _85 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Navbar.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.09333333333333334 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._