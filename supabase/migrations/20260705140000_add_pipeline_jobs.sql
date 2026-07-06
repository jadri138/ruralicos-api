-- C1: runner de pipeline con checkpoints.
-- Un job por (kind, fecha, shadow) con el estado de cada fase en stages_json.
-- Los ticks de /tareas/pipeline-tick reclaman el job (claimed_by + heartbeat_at)
-- y avanzan fases dentro de su presupuesto de tiempo; el siguiente tick reanuda
-- desde el checkpoint. shadow=true = ejecucion en sombra (no envia WhatsApp,
-- no escribe scraper_runs; sus pipeline_runs van con stage 'shadow:*').

create table if not exists public.pipeline_jobs (
  id bigint generated always as identity primary key,
  kind text default 'daily' not null,
  fecha date not null,
  shadow boolean default false not null,
  status text default 'pending' not null,
  current_stage text,
  stages_json jsonb default '{}'::jsonb not null,
  options_json jsonb default '{}'::jsonb not null,
  claimed_by text,
  heartbeat_at timestamp with time zone,
  ticks integer default 0 not null,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  error_msg text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint pipeline_jobs_status_check
    check (status in ('pending', 'running', 'completed', 'failed', 'aborted')),
  constraint pipeline_jobs_stages_object_check check (jsonb_typeof(stages_json) = 'object'),
  constraint pipeline_jobs_options_object_check check (jsonb_typeof(options_json) = 'object')
);

create unique index if not exists uq_pipeline_jobs_kind_fecha_shadow
  on public.pipeline_jobs (kind, fecha, shadow);

create index if not exists idx_pipeline_jobs_status_fecha
  on public.pipeline_jobs (status, fecha desc);

alter table public.pipeline_jobs enable row level security;

comment on table public.pipeline_jobs is
  'Estado con checkpoints del runner de pipeline (C1): un job por kind+fecha+shadow, reclamado por ticks con heartbeat. stages_json guarda el checkpoint de cada fase.';
comment on column public.pipeline_jobs.stages_json is
  'Checkpoint por fase: status, attempts, loops, totales y resumen de la ultima respuesta.';
comment on column public.pipeline_jobs.claimed_by is
  'Tick que tiene el claim ahora mismo; null si nadie. Con heartbeat_at rancio otro tick puede robar el claim.';
comment on column public.pipeline_jobs.shadow is
  'true = ejecucion en sombra: valida la orquestacion sin enviar WhatsApp ni escribir scraper_runs.';
