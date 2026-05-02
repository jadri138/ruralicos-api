-- Ruralicos - Historico operativo del pipeline IA/digest
-- Ejecutar en Supabase SQL Editor antes de usar el monitor de pipeline.

begin;

create table if not exists public.pipeline_runs (
  id bigserial primary key,
  stage text not null,
  endpoint text null,
  fecha_objetivo date not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  duration_ms integer null,
  status text not null default 'running'
    check (status in ('running', 'ok', 'warning', 'error')),
  loops integer null,
  procesadas integer not null default 0,
  errores integer not null default 0,
  error_msg text null,
  response_json jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists idx_pipeline_runs_fecha_stage
  on public.pipeline_runs(fecha_objetivo, stage, started_at desc);

create index if not exists idx_pipeline_runs_started_at
  on public.pipeline_runs(started_at desc);

commit;
