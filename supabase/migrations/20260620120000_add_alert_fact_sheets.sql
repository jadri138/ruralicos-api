-- Fichas evidence-first por alerta. Esta tabla es aditiva y se usa primero en
-- modo shadow: permite comparar decisiones nuevas con el digest actual sin
-- bloquear envios ni reescribir alertas historicas.

create table if not exists public.alert_fact_sheets (
  id bigserial primary key,
  alerta_id bigint not null references public.alertas (id) on delete cascade,
  organization_id bigint,
  schema_version text not null,
  builder_version text not null,
  status text not null,
  truth_score double precision,
  risk_score double precision,
  evidence_coverage double precision,
  fact_sheet jsonb not null,
  flags jsonb not null default '[]'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  source_trace jsonb not null default '{}'::jsonb,
  shadow_decision jsonb not null default '{}'::jsonb,
  enforcement_mode text not null default 'shadow',
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alert_fact_sheets_status_check
    check (status in ('ready_for_digest', 'review_only', 'blocked', 'insufficient_evidence', 'unknown')),
  constraint alert_fact_sheets_flags_array_check
    check (jsonb_typeof(flags) = 'array'),
  constraint alert_fact_sheets_reasons_array_check
    check (jsonb_typeof(reasons) = 'array'),
  constraint alert_fact_sheets_fact_sheet_object_check
    check (jsonb_typeof(fact_sheet) = 'object'),
  constraint alert_fact_sheets_shadow_decision_object_check
    check (jsonb_typeof(shadow_decision) = 'object')
);

create unique index if not exists idx_alert_fact_sheets_version
  on public.alert_fact_sheets (alerta_id, schema_version, builder_version);

create index if not exists idx_alert_fact_sheets_status_generated
  on public.alert_fact_sheets (status, generated_at desc);

create index if not exists idx_alert_fact_sheets_alerta_generated
  on public.alert_fact_sheets (alerta_id, generated_at desc);

create index if not exists idx_alert_fact_sheets_org_generated
  on public.alert_fact_sheets (organization_id, generated_at desc)
  where organization_id is not null;

alter table public.alert_fact_sheets enable row level security;

grant select, insert, update, delete on table public.alert_fact_sheets to service_role;
grant usage, select on sequence public.alert_fact_sheets_id_seq to service_role;

comment on table public.alert_fact_sheets is
  'Ficha maestra evidence-first por alerta. Nace en modo shadow para auditar hechos, evidencia y decision teorica antes de bloquear digest.';

comment on column public.alert_fact_sheets.fact_sheet is
  'Payload completo de la ficha evidence-first generada para la alerta.';

comment on column public.alert_fact_sheets.shadow_decision is
  'Decision teorica de la politica evidence-first comparada con la decision real del digest.';

comment on column public.alert_fact_sheets.enforcement_mode is
  'Modo de uso de la ficha: shadow para observar, enforce cuando la politica ya bloquea.';

