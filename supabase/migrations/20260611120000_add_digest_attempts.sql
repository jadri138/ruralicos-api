create table if not exists public.digest_attempts (
  id bigserial primary key,
  user_id bigint not null,
  organization_id bigint,
  fecha date not null,
  kind text not null default 'daily',
  status text not null default 'unknown',
  total_alertas_dia integer not null default 0,
  total_alertas_ventana integer not null default 0,
  tras_quality_gate integer not null default 0,
  tras_filtro_usuario integer not null default 0,
  tras_scoring integer not null default 0,
  alertas_finales integer not null default 0,
  motivo_no_envio text,
  digest_id bigint,
  error_msg text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_digest_attempts_user_fecha_kind
  on public.digest_attempts (user_id, fecha, kind);

create index if not exists idx_digest_attempts_fecha_status
  on public.digest_attempts (fecha desc, status);

create index if not exists idx_digest_attempts_user_created
  on public.digest_attempts (user_id, created_at desc);

create index if not exists idx_digest_attempts_digest_id
  on public.digest_attempts (digest_id)
  where digest_id is not null;

alter table public.digest_attempts enable row level security;

grant select, insert, update, delete on table public.digest_attempts to service_role;
grant usage, select on sequence public.digest_attempts_id_seq to service_role;

comment on table public.digest_attempts is
  'Auditoria diaria de preparacion/envio de digests: explica por que un usuario recibio o no recibio mensaje.';

comment on column public.digest_attempts.kind is
  'Tipo de intento: daily, rescue u otros flujos futuros.';

comment on column public.digest_attempts.status is
  'Resultado del intento: generated, rescued, no_send, skipped_existing, failed, sent.';

comment on column public.digest_attempts.motivo_no_envio is
  'Motivo principal cuando no se genera o no se envia digest.';

comment on column public.digest_attempts.metadata_json is
  'Detalle adicional no critico para depurar filtros, plan, rescate y errores.';
