-- Ruralicos - Historico operativo de scrapers
-- Ejecutar en Supabase SQL Editor antes de usar el monitor de Operaciones.

begin;

create table if not exists public.scraper_runs (
  id bigserial primary key,
  fuente text not null,
  endpoint text not null,
  fecha_objetivo date not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  duration_ms integer null,
  status text not null default 'running'
    check (status in ('running', 'ok', 'warning', 'error')),
  http_status integer null,
  nuevas integer not null default 0,
  duplicadas integer not null default 0,
  errores integer not null default 0,
  relevantes integer null,
  mensaje text null,
  error_msg text null,
  response_json jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists idx_scraper_runs_fecha_fuente
  on public.scraper_runs(fecha_objetivo, fuente, started_at desc);

create index if not exists idx_scraper_runs_started_at
  on public.scraper_runs(started_at desc);

commit;
