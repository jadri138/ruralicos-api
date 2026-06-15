-- Personal de cooperativa que accede al panel partner (distinto de los socios `users`
-- y del admin de Ruralicos). Cada fila es una credencial de login asociada a una
-- organizacion. El rol controla que puede hacer dentro de SU cooperativa.

create table if not exists public.organization_staff (
  id bigserial primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  email text not null,
  name text,
  password_hash text not null,
  member_role text not null default 'admin',
  status text not null default 'active',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_staff_role_check
    check (member_role in ('owner', 'admin', 'agent', 'viewer')),
  constraint organization_staff_status_check
    check (status in ('active', 'disabled'))
);

-- Email unico de forma global (case-insensitive): es la identidad de login.
create unique index if not exists idx_organization_staff_email_lower
  on public.organization_staff (lower(email));

create index if not exists idx_organization_staff_org
  on public.organization_staff (organization_id, status);

alter table public.organization_staff enable row level security;

grant select, insert, update, delete on table public.organization_staff to service_role;
grant usage, select on sequence public.organization_staff_id_seq to service_role;

comment on table public.organization_staff is
  'Credenciales de acceso al panel partner por organizacion. No confundir con users (socios) ni admin_users.';

comment on column public.organization_staff.member_role is
  'Rol dentro de su cooperativa: owner | admin | agent | viewer.';

comment on column public.organization_staff.status is
  'active o disabled. disabled bloquea el login sin borrar la cuenta.';
