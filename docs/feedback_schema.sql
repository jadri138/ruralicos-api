-- Ruralicos - Feedback de alertas por usuario
-- Ejecutar en Supabase SQL Editor antes de activar el webhook de UltraMsg.

begin;

create table if not exists public.alerta_feedback (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  digest_id bigint null references public.digests(id) on delete cascade,
  alerta_id bigint not null references public.alertas(id) on delete cascade,
  item_numero integer null,
  valor smallint not null check (valor in (-1, 1)),
  canal text not null default 'whatsapp',
  raw_text text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- La API usa SUPABASE_SERVICE_ROLE_KEY desde backend, que ignora RLS.
-- Activamos RLS para impedir acceso directo desde clientes anon/auth.
alter table public.alerta_feedback enable row level security;

create unique index if not exists ux_alerta_feedback_user_digest_alerta
  on public.alerta_feedback(user_id, digest_id, alerta_id);

create index if not exists idx_alerta_feedback_user_created
  on public.alerta_feedback(user_id, created_at desc);

create index if not exists idx_alerta_feedback_alerta
  on public.alerta_feedback(alerta_id);

create table if not exists public.user_interest_profile (
  user_id bigint not null references public.users(id) on delete cascade,
  tag text not null,
  score integer not null default 0,
  positivos integer not null default 0,
  negativos integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, tag)
);

alter table public.user_interest_profile enable row level security;

create index if not exists idx_user_interest_profile_user_score
  on public.user_interest_profile(user_id, score desc);

create table if not exists public.webhook_events (
  id bigserial primary key,
  source text not null,
  path text null,
  method text null,
  content_type text null,
  query_json jsonb null,
  body_json jsonb null,
  processed boolean not null default false,
  result_json jsonb null,
  error_msg text null,
  created_at timestamptz not null default now()
);

alter table public.webhook_events enable row level security;

create index if not exists idx_webhook_events_created
  on public.webhook_events(created_at desc);

create index if not exists idx_webhook_events_source_created
  on public.webhook_events(source, created_at desc);

create or replace function public.set_alerta_feedback_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_alerta_feedback_updated_at on public.alerta_feedback;
create trigger trg_alerta_feedback_updated_at
before update on public.alerta_feedback
for each row execute function public.set_alerta_feedback_updated_at();

commit;
