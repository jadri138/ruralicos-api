-- Auditoria de llamadas a la IA (OpenAI Responses API).
-- Cada llamada registra tarea, modelo, tokens, latencia y resultado para poder
-- responder "cuanto cuesta cada fase del pipeline" y detectar degradaciones.
-- La escritura desde la API es best effort: si la tabla no existe, el codigo
-- sigue funcionando (ver src/platform/ia/llamarIA.js).

create table if not exists public.ia_runs (
  id bigint generated always as identity primary key,
  task text not null default 'generic',
  model text not null,
  status text not null check (status in ('ok', 'error')),
  http_status integer,
  attempts integer not null default 1,
  duration_ms integer not null default 0,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  error_msg text,
  created_at timestamptz not null default now()
);

comment on table public.ia_runs is
  'Auditoria de llamadas a la IA: coste en tokens, latencia, reintentos y errores por tarea. Escrita best-effort desde llamarIA().';

create index if not exists idx_ia_runs_created_at on public.ia_runs (created_at desc);
create index if not exists idx_ia_runs_task_created on public.ia_runs (task, created_at desc);

alter table public.ia_runs enable row level security;
