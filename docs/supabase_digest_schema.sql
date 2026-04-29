-- Ruralicos - Esquema mínimo recomendado para modo DIGEST por usuario
-- Ejecutar en Supabase SQL Editor.

begin;

-- 1) Tabla de digests diarios por usuario
create table if not exists public.digests (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  fecha date not null,
  mensaje text not null,
  alerta_ids jsonb not null default '[]'::jsonb,
  enviado boolean not null default false,
  enviado_at timestamptz null,
  error_msg text null,
  created_at timestamptz not null default now()
);

-- 1.1) Idempotencia: un digest por usuario y día
create unique index if not exists ux_digests_user_fecha
  on public.digests(user_id, fecha);

-- 1.2) Índice para envío de pendientes diarios
create index if not exists idx_digests_fecha_enviado
  on public.digests(fecha, enviado);

-- 2) Campos usados por el pipeline IA en alertas
alter table public.alertas
  add column if not exists estado_ia text default 'pendiente_clasificar',
  add column if not exists resumen_borrador text,
  add column if not exists resumen_final text,
  add column if not exists duplicado_de bigint references public.alertas(id) on delete set null,
  add column if not exists fuente text,
  add column if not exists provincias jsonb,
  add column if not exists sectores jsonb,
  add column if not exists subsectores jsonb,
  add column if not exists tipos_alerta jsonb;

create index if not exists idx_alertas_fecha_estado
  on public.alertas(fecha, estado_ia);

create index if not exists idx_alertas_duplicado_de
  on public.alertas(duplicado_de)
  where duplicado_de is not null;

-- 3) Guardrail suave para suscripciones
alter table public.users
  alter column subscription set default 'corral';

alter table public.users
  add column if not exists preferencias_extra text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_subscription_check'
  ) then
    alter table public.users
      add constraint users_subscription_check
      check (subscription in ('free', 'corral', 'agricultor', 'cooperativa'));
  end if;
end $$;

commit;

