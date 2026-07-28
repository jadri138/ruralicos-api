create table if not exists public.mia_recommendation_health_snapshots (
  id bigint generated always as identity primary key,
  fecha date not null unique,
  status text not null check (status in ('healthy', 'warning', 'critical')),
  score integer not null check (score between 0 and 100),
  period_days integer not null default 14 check (period_days between 1 and 90),
  metrics_json jsonb not null default '{}'::jsonb,
  flags_json jsonb not null default '[]'::jsonb,
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_mia_recommendation_health_evaluated
  on public.mia_recommendation_health_snapshots (evaluated_at desc);

alter table public.mia_recommendation_health_snapshots enable row level security;

drop trigger if exists trg_mia_recommendation_health_updated_at
  on public.mia_recommendation_health_snapshots;
create trigger trg_mia_recommendation_health_updated_at
  before update on public.mia_recommendation_health_snapshots
  for each row execute function public.touch_updated_at();

grant select, insert, update, delete
  on table public.mia_recommendation_health_snapshots
  to service_role;

grant usage, select
  on sequence public.mia_recommendation_health_snapshots_id_seq
  to service_role;

comment on table public.mia_recommendation_health_snapshots is
  'Medición diaria agregada de utilidad, trazabilidad, repeticiones y seguridad territorial de las recomendaciones MIA.';
