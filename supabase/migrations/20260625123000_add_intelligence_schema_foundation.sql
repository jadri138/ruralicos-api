-- Base aditiva para taxonomia enriquecida y auditoria completa de candidatos.
-- No cambia el comportamiento del digest por si sola.

alter table public.alertas
  add column if not exists taxonomy_tags jsonb not null default '[]'::jsonb;

do $$
begin
  alter table public.alertas
    add constraint alertas_taxonomy_tags_array_check
    check (jsonb_typeof(taxonomy_tags) = 'array');
exception
  when duplicate_object then null;
end
$$;

create index if not exists idx_alertas_taxonomy_tags
  on public.alertas using gin (taxonomy_tags);

comment on column public.alertas.taxonomy_tags is
  'Etiquetas canonicas enriquecidas derivadas de la taxonomia Ruralicos. Mantiene tipos_alerta como interfaz compatible.';

create table if not exists public.digest_candidate_decisions (
  id bigserial primary key,
  user_id bigint not null references public.users (id) on delete cascade,
  alerta_id bigint not null references public.alertas (id) on delete cascade,
  organization_id bigint,
  fecha date not null,
  kind text not null default 'daily',
  stage text not null,
  action text not null,
  score double precision,
  risk text,
  reason text,
  digest_id bigint references public.digests (id) on delete set null,
  digest_attempt_id bigint references public.digest_attempts (id) on delete set null,
  decision_json jsonb not null default '{}'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint digest_candidate_decisions_decision_object_check
    check (jsonb_typeof(decision_json) = 'object'),
  constraint digest_candidate_decisions_metadata_object_check
    check (jsonb_typeof(metadata_json) = 'object')
);

create unique index if not exists idx_digest_candidate_decisions_unique_stage
  on public.digest_candidate_decisions
  (user_id, fecha, kind, alerta_id, stage);

create index if not exists idx_digest_candidate_decisions_user_fecha
  on public.digest_candidate_decisions (user_id, fecha desc);

create index if not exists idx_digest_candidate_decisions_alerta_fecha
  on public.digest_candidate_decisions (alerta_id, fecha desc);

create index if not exists idx_digest_candidate_decisions_action_fecha
  on public.digest_candidate_decisions (action, fecha desc);

create index if not exists idx_digest_candidate_decisions_digest
  on public.digest_candidate_decisions (digest_id)
  where digest_id is not null;

alter table public.digest_candidate_decisions enable row level security;

revoke all on table public.digest_candidate_decisions from public, anon, authenticated;
revoke all on sequence public.digest_candidate_decisions_id_seq from public, anon, authenticated;

grant select, insert, update, delete
  on table public.digest_candidate_decisions
  to service_role;

grant usage, select
  on sequence public.digest_candidate_decisions_id_seq
  to service_role;

comment on table public.digest_candidate_decisions is
  'Auditoria por usuario y alerta de todos los candidatos evaluados por el digest, incluidos review_only y rechazados.';

comment on column public.digest_candidate_decisions.stage is
  'Etapa que produjo la decision: quality_gate, user_filter, selection, final_validation u otra versionada.';

comment on column public.digest_candidate_decisions.action is
  'Accion normalizada de la etapa: include, review_only, exclude, blocked u otra compatible.';

comment on column public.digest_candidate_decisions.decision_json is
  'Payload completo y auditable de la decision tomada para el candidato.';
