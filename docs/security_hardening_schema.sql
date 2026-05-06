-- Ruralicos - Seguridad base para beta
-- RLS + indices de coste/escala.
-- Ejecutar en Supabase SQL Editor. Es idempotente.
--
-- Nota:
-- El backend usa SUPABASE_SERVICE_KEY, por lo que estas reglas no rompen la API.
-- El objetivo es que una anon key o cliente frontend no pueda leer tablas sensibles.

begin;

-- 1. Activar RLS en tablas sensibles.
alter table if exists public.alertas enable row level security;
alter table if exists public.logs enable row level security;
alter table if exists public.whatsapp_logs enable row level security;
alter table if exists public.admin_users enable row level security;
alter table if exists public.digests enable row level security;
alter table if exists public.scraper_runs enable row level security;
alter table if exists public.pipeline_runs enable row level security;
alter table if exists public.webhook_events enable row level security;

-- 2. Sin politicas abiertas por defecto.
-- Supabase deniega anon/auth si RLS esta activo y no hay policy.
-- El service role del backend sigue pudiendo operar.

-- 3. Indices para rutas calientes: pipeline, digest, MIA, feedback y clicks.
create index if not exists idx_alertas_fecha_estado
  on public.alertas(fecha, estado_ia);

create index if not exists idx_alertas_fecha_estado_duplicado
  on public.alertas(fecha, estado_ia, duplicado_de);

create index if not exists idx_alertas_fuente
  on public.alertas(fuente);

create index if not exists idx_digests_user_fecha
  on public.digests(user_id, fecha desc);

create unique index if not exists ux_alerta_feedback_user_digest_alerta
  on public.alerta_feedback(user_id, digest_id, alerta_id);

create index if not exists idx_user_interest_profile_user_tag
  on public.user_interest_profile(user_id, tag);

create index if not exists idx_user_memory_user_created
  on public.user_memory(user_id, created_at desc);

create index if not exists idx_user_conversations_user_estado_expira
  on public.user_conversations(user_id, estado, expira_at);

create index if not exists idx_alerta_clicks_user_created
  on public.alerta_clicks(user_id, created_at desc);

create index if not exists idx_exploration_log_user_procesado_created
  on public.exploration_log(user_id, procesado, created_at desc);

create index if not exists idx_pipeline_runs_stage_started
  on public.pipeline_runs(stage, started_at desc);

create index if not exists idx_scraper_runs_fuente_fecha
  on public.scraper_runs(fuente, fecha_objetivo desc);

commit;
