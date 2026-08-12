-- Sustituye exclusivamente la persistencia shadow de decision-v2.
-- La historia shadow anterior se elimina por autorizacion expresa. Ninguna
-- tabla productiva se modifica o borra.

drop table if exists public.shadow_digest_items;
drop table if exists public.shadow_candidate_decisions;
drop table if exists public.shadow_digest_runs;

create table public.shadow_v2_alert_classifications (
  id bigint generated always as identity primary key,
  workflow_run_key uuid not null,
  workflow_date date not null,
  alert_id bigint not null references public.alertas (id) on delete cascade,
  official_snapshot jsonb not null,
  prefilter_result jsonb not null,
  ai1_called boolean not null default false,
  classification jsonb,
  model text,
  engine_version text not null,
  contract_version text not null,
  prompt_version text not null,
  prompt_text text,
  raw_response text,
  normalized_response jsonb,
  usage_json jsonb not null default '{}'::jsonb,
  duration_ms integer not null default 0,
  status text not null,
  error_code text,
  error_message text,
  stop_reason text,
  stop_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint shadow_v2_alert_classifications_run_alert_key
    unique (workflow_run_key, alert_id),
  constraint shadow_v2_alert_classifications_status_check
    check (status in ('FILTERED', 'SUCCESS', 'ERROR')),
  constraint shadow_v2_alert_classifications_model_check
    check (
      (ai1_called = false and model is null)
      or (ai1_called = true and model = 'gpt-5-nano')
    ),
  constraint shadow_v2_alert_classifications_snapshot_object_check
    check (jsonb_typeof(official_snapshot) = 'object'),
  constraint shadow_v2_alert_classifications_prefilter_object_check
    check (jsonb_typeof(prefilter_result) = 'object'),
  constraint shadow_v2_alert_classifications_usage_object_check
    check (jsonb_typeof(usage_json) = 'object'),
  constraint shadow_v2_alert_classifications_stop_details_object_check
    check (jsonb_typeof(stop_details) = 'object'),
  constraint shadow_v2_alert_classifications_duration_check
    check (duration_ms >= 0)
);

create table public.shadow_v2_digest_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_key uuid not null,
  workflow_date date not null,
  user_id bigint not null references public.users (id) on delete cascade,
  profile_snapshot jsonb not null,
  candidate_alert_ids jsonb not null default '[]'::jsonb,
  candidate_cards jsonb not null default '[]'::jsonb,
  limits_snapshot jsonb not null,
  candidate_overflow_count integer not null default 0,
  already_sent_alert_ids jsonb not null default '[]'::jsonb,
  model text,
  engine_version text not null,
  contract_version text not null,
  prompt_version text not null,
  prompt_text text,
  raw_response text,
  normalized_response jsonb,
  usage_json jsonb not null default '{}'::jsonb,
  duration_ms integer not null default 0,
  digest_preview text not null default '',
  status text not null,
  error_code text,
  error_message text,
  stop_reason text,
  stop_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint shadow_v2_digest_runs_run_user_key
    unique (workflow_run_key, user_id),
  constraint shadow_v2_digest_runs_status_check
    check (status in ('NO_CANDIDATES', 'GENERATED', 'EMPTY', 'ERROR')),
  constraint shadow_v2_digest_runs_model_check
    check (
      (status = 'NO_CANDIDATES' and model is null)
      or (status <> 'NO_CANDIDATES' and model = 'gpt-5.6-luna')
    ),
  constraint shadow_v2_digest_runs_profile_object_check
    check (jsonb_typeof(profile_snapshot) = 'object'),
  constraint shadow_v2_digest_runs_candidate_ids_array_check
    check (jsonb_typeof(candidate_alert_ids) = 'array'),
  constraint shadow_v2_digest_runs_candidate_cards_array_check
    check (jsonb_typeof(candidate_cards) = 'array'),
  constraint shadow_v2_digest_runs_limits_object_check
    check (jsonb_typeof(limits_snapshot) = 'object'),
  constraint shadow_v2_digest_runs_sent_ids_array_check
    check (jsonb_typeof(already_sent_alert_ids) = 'array'),
  constraint shadow_v2_digest_runs_usage_object_check
    check (jsonb_typeof(usage_json) = 'object'),
  constraint shadow_v2_digest_runs_stop_details_object_check
    check (jsonb_typeof(stop_details) = 'object'),
  constraint shadow_v2_digest_runs_overflow_check
    check (candidate_overflow_count >= 0),
  constraint shadow_v2_digest_runs_duration_check
    check (duration_ms >= 0)
);

create table public.shadow_v2_digest_items (
  id bigint generated always as identity primary key,
  shadow_digest_run_id uuid not null
    references public.shadow_v2_digest_runs (id) on delete cascade,
  workflow_run_key uuid not null,
  workflow_date date not null,
  user_id bigint not null references public.users (id) on delete cascade,
  alert_id bigint not null references public.alertas (id) on delete cascade,
  final_position integer not null,
  classification_snapshot jsonb not null,
  personal_reason text not null,
  title_used text not null,
  summary_used text not null,
  action_used text not null,
  deadline_used date,
  rendered_block text not null,
  created_at timestamptz not null default now(),
  constraint shadow_v2_digest_items_run_alert_key
    unique (shadow_digest_run_id, alert_id),
  constraint shadow_v2_digest_items_run_position_key
    unique (shadow_digest_run_id, final_position),
  constraint shadow_v2_digest_items_position_check
    check (final_position between 1 and 5),
  constraint shadow_v2_digest_items_classification_object_check
    check (jsonb_typeof(classification_snapshot) = 'object')
);

create index shadow_v2_alert_classifications_date_status_idx
  on public.shadow_v2_alert_classifications (workflow_date desc, status, alert_id);
create index shadow_v2_alert_classifications_alert_idx
  on public.shadow_v2_alert_classifications (alert_id, workflow_date desc);
create index shadow_v2_digest_runs_date_status_idx
  on public.shadow_v2_digest_runs (workflow_date desc, status, user_id);
create index shadow_v2_digest_runs_user_idx
  on public.shadow_v2_digest_runs (user_id, workflow_date desc);
create index shadow_v2_digest_items_join_idx
  on public.shadow_v2_digest_items (user_id, workflow_date desc, alert_id);
create index shadow_v2_digest_items_alert_idx
  on public.shadow_v2_digest_items (alert_id, workflow_date desc);

alter table public.shadow_v2_alert_classifications enable row level security;
alter table public.shadow_v2_digest_runs enable row level security;
alter table public.shadow_v2_digest_items enable row level security;

revoke all on table public.shadow_v2_alert_classifications from public, anon, authenticated, service_role;
revoke all on table public.shadow_v2_digest_runs from public, anon, authenticated, service_role;
revoke all on table public.shadow_v2_digest_items from public, anon, authenticated, service_role;
revoke all on sequence public.shadow_v2_alert_classifications_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.shadow_v2_digest_items_id_seq from public, anon, authenticated, service_role;

grant select, insert, update on table public.shadow_v2_alert_classifications to service_role;
grant select, insert, update, delete on table public.shadow_v2_digest_runs to service_role;
grant select, insert on table public.shadow_v2_digest_items to service_role;
grant usage, select on sequence public.shadow_v2_alert_classifications_id_seq to service_role;
grant usage, select on sequence public.shadow_v2_digest_items_id_seq to service_role;

comment on table public.shadow_v2_alert_classifications is
  'Clasificacion global shadow-v2 por alerta y ejecucion; no modifica la alerta productiva.';
comment on table public.shadow_v2_digest_runs is
  'Decision personal y preview shadow-v2 por usuario y ejecucion; nunca es enviable.';
comment on table public.shadow_v2_digest_items is
  'Elementos seleccionados por IA 2 en shadow-v2; no son digest_items productivos.';
