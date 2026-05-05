-- Ruralicos - Tracking de clicks en alertas
-- Ejecutar en Supabase SQL Editor. Es idempotente.

begin;

create table if not exists public.alerta_click_links (
  token text primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  digest_id bigint not null references public.digests(id) on delete cascade,
  alerta_id bigint not null references public.alertas(id) on delete cascade,
  url_destino text not null,
  created_at timestamptz not null default now(),
  last_clicked_at timestamptz,
  click_count integer not null default 0,
  unique (user_id, digest_id, alerta_id)
);

create table if not exists public.alerta_clicks (
  id bigserial primary key,
  token text references public.alerta_click_links(token) on delete set null,
  user_id bigint not null references public.users(id) on delete cascade,
  digest_id bigint references public.digests(id) on delete set null,
  alerta_id bigint not null references public.alertas(id) on delete cascade,
  url_destino text not null,
  user_agent text,
  referer text,
  ip_hash text,
  created_at timestamptz not null default now()
);

alter table public.alerta_click_links enable row level security;
alter table public.alerta_clicks enable row level security;

create index if not exists idx_alerta_click_links_user_digest
  on public.alerta_click_links(user_id, digest_id);

create index if not exists idx_alerta_click_links_alerta
  on public.alerta_click_links(alerta_id);

create index if not exists idx_alerta_clicks_user_created
  on public.alerta_clicks(user_id, created_at desc);

create index if not exists idx_alerta_clicks_alerta_created
  on public.alerta_clicks(alerta_id, created_at desc);

create index if not exists idx_alerta_clicks_digest
  on public.alerta_clicks(digest_id);

commit;
