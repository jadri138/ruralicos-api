-- Persistencia completamente aislada para decision-v2 en modo sombra.
-- Estas tablas no son colas ni borradores enviables y no tienen ninguna
-- relacion con digests, digest_items, tracking, outbox o WhatsApp.

create table public.shadow_digest_runs (
  shadow_run_id uuid primary key default gen_random_uuid(),
  workflow_run_key uuid not null,
  workflow_date date not null,
  user_id bigint not null references public.users (id) on delete cascade,
  organization_id bigint references public.organizations (id) on delete set null,
  status text not null,
  engine_version text not null,
  contract_version text not null,
  prompt_version text not null,
  render_version text not null,
  model text not null,
  max_included integer not null,
  profile_snapshot jsonb not null default '{}'::jsonb,
  candidates_snapshot jsonb not null default '[]'::jsonb,
  objective_filter_summary jsonb not null default '{}'::jsonb,
  policy_snapshot jsonb not null default '{}'::jsonb,
  system_prompt text,
  prompt_text text,
  retry_prompt_text text,
  llm_input jsonb,
  llm_raw_response text,
  llm_raw_responses jsonb not null default '[]'::jsonb,
  llm_normalized_response jsonb,
  llm_attempts integer not null default 0,
  usage_json jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  error_details jsonb not null default '{}'::jsonb,
  mensaje_preview text,
  counts_json jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shadow_digest_runs_status_check
    check (status in ('GENERATED', 'EMPTY', 'ERROR')),
  constraint shadow_digest_runs_max_included_check
    check (max_included > 0),
  constraint shadow_digest_runs_llm_attempts_check
    check (llm_attempts between 0 and 2),
  constraint shadow_digest_runs_profile_object_check
    check (jsonb_typeof(profile_snapshot) = 'object'),
  constraint shadow_digest_runs_candidates_array_check
    check (jsonb_typeof(candidates_snapshot) = 'array'),
  constraint shadow_digest_runs_policy_object_check
    check (jsonb_typeof(policy_snapshot) = 'object'),
  constraint shadow_digest_runs_raw_responses_array_check
    check (jsonb_typeof(llm_raw_responses) = 'array'),
  constraint shadow_digest_runs_usage_object_check
    check (jsonb_typeof(usage_json) = 'object'),
  constraint shadow_digest_runs_counts_object_check
    check (jsonb_typeof(counts_json) = 'object'),
  constraint shadow_digest_runs_workflow_user_key
    unique (workflow_run_key, user_id)
);

create table public.shadow_candidate_decisions (
  id bigint generated always as identity primary key,
  shadow_run_id uuid not null
    references public.shadow_digest_runs (shadow_run_id) on delete cascade,
  workflow_date date not null,
  user_id bigint not null references public.users (id) on delete cascade,
  organization_id bigint references public.organizations (id) on delete set null,
  alert_id bigint not null references public.alertas (id) on delete cascade,
  input_position integer not null,
  decision_position integer,
  decision_source text not null,
  alert_snapshot jsonb not null,
  objective_filters jsonb not null default '[]'::jsonb,
  decision text,
  priority integer,
  reason text,
  evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint shadow_candidate_decisions_source_check
    check (decision_source in ('objective_filter', 'llm', 'technical_error')),
  constraint shadow_candidate_decisions_decision_check
    check (decision is null or decision in ('include', 'exclude')),
  constraint shadow_candidate_decisions_priority_check
    check (
      (decision = 'include' and priority is not null and priority > 0)
      or (decision is distinct from 'include' and priority is null)
    ),
  constraint shadow_candidate_decisions_snapshot_object_check
    check (jsonb_typeof(alert_snapshot) = 'object'),
  constraint shadow_candidate_decisions_filters_array_check
    check (jsonb_typeof(objective_filters) = 'array'),
  constraint shadow_candidate_decisions_evidence_array_check
    check (jsonb_typeof(evidence) = 'array'),
  constraint shadow_candidate_decisions_run_alert_key
    unique (shadow_run_id, alert_id)
);

create table public.shadow_digest_items (
  id bigint generated always as identity primary key,
  shadow_run_id uuid not null
    references public.shadow_digest_runs (shadow_run_id) on delete cascade,
  workflow_date date not null,
  user_id bigint not null references public.users (id) on delete cascade,
  organization_id bigint references public.organizations (id) on delete set null,
  alert_id bigint not null references public.alertas (id) on delete cascade,
  final_position integer not null,
  alert_snapshot jsonb not null,
  decision_snapshot jsonb not null,
  rendered_block text not null,
  created_at timestamptz not null default now(),
  constraint shadow_digest_items_position_check check (final_position > 0),
  constraint shadow_digest_items_alert_snapshot_object_check
    check (jsonb_typeof(alert_snapshot) = 'object'),
  constraint shadow_digest_items_decision_snapshot_object_check
    check (jsonb_typeof(decision_snapshot) = 'object'),
  constraint shadow_digest_items_run_alert_key
    unique (shadow_run_id, alert_id),
  constraint shadow_digest_items_run_position_key
    unique (shadow_run_id, final_position)
);

create index shadow_digest_runs_user_date_idx
  on public.shadow_digest_runs (user_id, workflow_date desc, created_at desc);
create index shadow_digest_runs_date_status_idx
  on public.shadow_digest_runs (workflow_date desc, status, created_at desc);
create index shadow_digest_runs_organization_idx
  on public.shadow_digest_runs (organization_id)
  where organization_id is not null;
create index shadow_candidate_decisions_join_idx
  on public.shadow_candidate_decisions (user_id, workflow_date desc, alert_id);
create index shadow_candidate_decisions_alert_idx
  on public.shadow_candidate_decisions (alert_id, workflow_date desc);
create index shadow_candidate_decisions_organization_idx
  on public.shadow_candidate_decisions (organization_id)
  where organization_id is not null;
create index shadow_digest_items_join_idx
  on public.shadow_digest_items (user_id, workflow_date desc, alert_id);
create index shadow_digest_items_alert_idx
  on public.shadow_digest_items (alert_id, workflow_date desc);
create index shadow_digest_items_organization_idx
  on public.shadow_digest_items (organization_id)
  where organization_id is not null;

alter table public.shadow_digest_runs enable row level security;
alter table public.shadow_candidate_decisions enable row level security;
alter table public.shadow_digest_items enable row level security;

revoke all on table public.shadow_digest_runs from public, anon, authenticated;
revoke all on table public.shadow_candidate_decisions from public, anon, authenticated;
revoke all on table public.shadow_digest_items from public, anon, authenticated;
revoke all on sequence public.shadow_candidate_decisions_id_seq from public, anon, authenticated;
revoke all on sequence public.shadow_digest_items_id_seq from public, anon, authenticated;
revoke all on table public.shadow_digest_runs from service_role;
revoke all on table public.shadow_candidate_decisions from service_role;
revoke all on table public.shadow_digest_items from service_role;
revoke all on sequence public.shadow_candidate_decisions_id_seq from service_role;
revoke all on sequence public.shadow_digest_items_id_seq from service_role;

grant select, insert, update
  on table public.shadow_digest_runs
  to service_role;
grant select, insert
  on table public.shadow_candidate_decisions
  to service_role;
grant select, insert
  on table public.shadow_digest_items
  to service_role;
grant usage, select
  on sequence public.shadow_candidate_decisions_id_seq
  to service_role;
grant usage, select
  on sequence public.shadow_digest_items_id_seq
  to service_role;

comment on table public.shadow_digest_runs is
  'Una ejecucion decision-v2 y su mensaje simulado por usuario; nunca es enviable.';
comment on table public.shadow_candidate_decisions is
  'Una fila auditable por alerta examinada por decision-v2, incluidos filtros objetivos y errores tecnicos.';
comment on table public.shadow_digest_items is
  'Items incluidos por decision-v2 en su orden final, con el bloque exacto renderizado en mensaje_preview.';
