-- Ruralicos - Coincidencias nominales en listados oficiales
-- Ejecutar en Supabase SQL Editor antes de enviar avisos individuales
-- por FEGA u otras fuentes donde aparezcan personas/beneficiarios.

begin;

create table if not exists public.official_list_matches (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  alerta_id bigint null references public.alertas(id) on delete set null,
  fuente text not null,
  contexto text not null default '',
  listado_titulo text null,
  persona_detectada text not null,
  archivo text null,
  linea text not null,
  line_hash text not null,
  url_fuente text not null,
  metadata jsonb not null default '{}'::jsonb,
  enviado boolean not null default false,
  enviado_at timestamptz null,
  created_at timestamptz not null default now()
);

alter table public.official_list_matches
  add column if not exists alerta_id bigint null references public.alertas(id) on delete set null,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create unique index if not exists ux_official_list_matches_unique
  on public.official_list_matches(user_id, fuente, contexto, persona_detectada, line_hash);

create index if not exists idx_official_list_matches_alerta
  on public.official_list_matches(alerta_id);

create index if not exists idx_official_list_matches_user
  on public.official_list_matches(user_id, created_at desc);

create index if not exists idx_official_list_matches_fuente
  on public.official_list_matches(fuente, contexto, created_at desc);

create index if not exists idx_official_list_matches_enviado
  on public.official_list_matches(enviado, created_at desc);

commit;
