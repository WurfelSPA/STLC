-- ─────────────────────────────────────────────────────────────────────────────
-- Bot de Renovaciones (Tracklink / Trackcity / Autobahn)
-- Spec: "Flujo Funcional Bot Ren" (Francisca López, Tracklink, oct-2026).
--
-- Todas las tablas con RLS activado y SIN policies: solo se accede
-- server-side con service_role (app/lib/renovaciones/*). Contienen PII.
-- ─────────────────────────────────────────────────────────────────────────────

-- Precios por línea y plazo. El bot NUNCA cotiza fuera de esta tabla.
create table if not exists public.renov_precios (
  linea      text    not null,               -- TRACKLINK | AUTOBAHN | TRACKCITY
  meses      int     not null check (meses in (12, 24, 36, 48)),
  precio     int     not null check (precio > 0),
  vigente    boolean not null default true,
  actualizado_en timestamptz not null default now(),
  primary key (linea, meses)
);

-- "Servicio Comercial" de TrackGTS -> línea del bot. cotiza_bot=false: el
-- bot no entrega precio (plan con condiciones especiales) y deriva a ejecutivo.
create table if not exists public.renov_segmentos (
  servicio_comercial text primary key,       -- '' = sin servicio comercial (Tracklink directo)
  linea      text    not null,
  cotiza_bot boolean not null default false,
  excluir    boolean not null default false, -- cuentas demo/prueba
  nota       text
);

-- Configuración editable por línea (medios de pago, call center, etc.).
create table if not exists public.renov_config (
  clave text primary key,
  valor jsonb not null
);

-- Un caso = un cliente (Usuario TrackGTS) + línea + ciclo de vencimiento.
-- Flotas: todos los vehículos del cliente que vencen en la ventana van
-- consolidados en el mismo caso (decisión Tracklink 2026-10-03).
create table if not exists public.renov_casos (
  id                 uuid primary key default gen_random_uuid(),
  usuario            text not null,
  nombre             text,
  rut                text,
  telefono           text,                   -- normalizado 569XXXXXXXX (sin +)
  correo             text,
  linea              text not null,
  segmento           text not null default '',
  cotiza_bot         boolean not null default false,
  tipo_cliente       text not null default 'persona' check (tipo_cliente in ('persona','empresa')),
  vehiculos          jsonb not null default '[]',   -- [{imei, placa, marca, modelo, vence}]
  cantidad_vehiculos int  not null default 1,
  fecha_vencimiento  date not null,          -- el más próximo de la flota
  estado             text not null default 'PENDIENTE',
  paso               text not null default 'MENU',  -- paso de la conversación
  contexto           jsonb not null default '{}',
  motivo             text,
  requiere_ejecutivo boolean not null default false,
  atendido           boolean not null default false, -- ejecutivo ya tomó el caso
  plazo_meses        int,
  monto              int,
  nueva_fecha_vencimiento date,
  trackgts_actualizado boolean not null default false,
  hitos_enviados     text[] not null default '{}',  -- D30, D20, D10, D3, D0
  respondio          boolean not null default false,
  opt_out            boolean not null default false,
  cerrado_por        text,                   -- bot | ejecutivo | externo
  simulacion         boolean not null default true,
  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now(),
  ultima_interaccion timestamptz
);
create index if not exists renov_casos_venc_idx   on public.renov_casos (fecha_vencimiento);
create index if not exists renov_casos_estado_idx on public.renov_casos (estado);
create index if not exists renov_casos_tel_idx    on public.renov_casos (telefono);

-- Registro de toda la interacción (requisito 1 del spec).
create table if not exists public.renov_mensajes (
  id        bigserial primary key,
  caso_id   uuid not null references public.renov_casos(id) on delete cascade,
  direccion text not null check (direccion in ('out','in','nota')),
  canal     text not null default 'simulador',   -- whatsapp | simulador | sistema | panel
  tipo      text,                                -- D30, D20, D10, D3, D0, respuesta, ...
  texto     text not null,
  meta      jsonb not null default '{}',
  creado_en timestamptz not null default now()
);
create index if not exists renov_mensajes_caso_idx on public.renov_mensajes (caso_id, creado_en);

alter table public.renov_precios   enable row level security;
alter table public.renov_segmentos enable row level security;
alter table public.renov_config    enable row level security;
alter table public.renov_casos     enable row level security;
alter table public.renov_mensajes  enable row level security;

-- ── Datos iniciales (plantilla sección 9 del spec) ──────────────────────────
insert into public.renov_precios (linea, meses, precio) values
  ('TRACKLINK', 12, 174082), ('TRACKLINK', 24, 278531),
  ('TRACKLINK', 36, 376040), ('TRACKLINK', 48, 466609),
  ('AUTOBAHN',  12, 133280), ('AUTOBAHN',  24, 219167),
  ('AUTOBAHN',  36, 305054), ('AUTOBAHN',  48, 340941),
  ('TRACKCITY', 12,  89000), ('TRACKCITY', 24, 164650),   -- informados por Tracklink 2026-10-08
  ('TRACKCITY', 36, 240300), ('TRACKCITY', 48, 315950)
on conflict (linea, meses) do nothing;

insert into public.renov_segmentos (servicio_comercial, linea, cotiza_bot, excluir, nota) values
  ('',                   'TRACKLINK', true,  false, 'Cliente Tracklink directo'),
  ('AUTOBAHN NUEVOS',    'AUTOBAHN',  true,  false, null),
  ('MIGRACION AUTOBAHN', 'AUTOBAHN',  true,  false, null),
  ('COORP MENSUALIZADO', 'TRACKLINK', false, false, 'Plan mensualizado: precio a confirmar con Tracklink'),
  ('SANTANDER CONSUMER', 'TRACKLINK', false, false, 'Convenio Santander: precio a confirmar'),
  ('G. MORALES-CONTADO', 'TRACKLINK', false, false, 'Convenio concesionario: precio a confirmar'),
  ('CANTAGALLO-CONTADO', 'TRACKLINK', false, false, 'Convenio concesionario: precio a confirmar'),
  ('REFERIDO',           'TRACKLINK', false, false, 'Precio a confirmar'),
  ('FLOTAS',             'TRACKLINK', false, false, 'Flotas: cotización ejecutivo'),
  ('zzz Demo-Test',      'TRACKLINK', false, true,  'Cuenta de prueba'),
  ('Pruebat',            'TRACKLINK', false, true,  'Cuenta de prueba')
on conflict (servicio_comercial) do nothing;

insert into public.renov_config (clave, valor) values
  ('linea:TRACKLINK', '{
     "nombre": "Tracklink",
     "link_pago": "https://www.webpay.cl/portalpagodirecto/pages/institucion.jsf?idEstablecimiento=107837496",
     "transferencia": "TRACK LINK CHILE SPA\nBanco Santander\nCuenta Corriente: 86992604\nRUT: 77.379.375-1\nMail: ventas@tracklink.cl"
   }'),
  ('linea:AUTOBAHN', '{
     "nombre": "Autobahn",
     "link_pago": "https://www.webpay.cl/form-pay/186673",
     "transferencia": "Autobahn S.A.\nRUT: 89.694.900-4\nBanco Scotiabank\nCuenta Corriente: 6044271\nMail: veronica.melendez@tracklink.cl"
   }'),
  ('linea:TRACKCITY', '{
     "nombre": "Trackcity",
     "link_pago": "https://www.webpay.cl/portalpagodirecto/pages/institucion.jsf?idEstablecimiento=107837496",
     "transferencia": null
   }'),
  ('general', '{
     "call_center": "+56 2 2583 0707 (24/7)",
     "horario_envio": "09:00-20:00",
     "usuarios_excluidos": ["bodega","emiliano","INSTALACIONES","mautobahn","PERDIDOS","REVISION","RECICLADAS","sparejam","sparejam-MDB"]
   }')
on conflict (clave) do nothing;
