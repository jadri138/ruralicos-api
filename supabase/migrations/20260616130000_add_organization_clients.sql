create table if not exists public.organization_clients (
  id bigserial primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  zone_id bigint references public.organization_zones (id) on delete set null,
  created_by_staff_id bigint,
  display_name text not null,
  first_name text,
  last_name text,
  phone text,
  phone_normalized text,
  email text,
  status text not null default 'active',
  client_type text not null default 'socio',
  profile_json jsonb not null default '{}'::jsonb,
  preferences_json jsonb not null default '{}'::jsonb,
  notes text,
  last_digest_at timestamptz,
  last_interaction_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_clients_status_check
    check (status in ('active', 'inactive', 'prospect')),
  constraint organization_clients_client_type_check
    check (client_type in ('socio', 'cliente', 'prospecto')),
  constraint organization_clients_profile_object_check
    check (jsonb_typeof(profile_json) = 'object'),
  constraint organization_clients_preferences_object_check
    check (jsonb_typeof(preferences_json) = 'object'),
  constraint organization_clients_contact_check
    check (
      nullif(trim(coalesce(phone, '')), '') is not null
      or nullif(trim(coalesce(email, '')), '') is not null
    )
);

create unique index if not exists idx_organization_clients_org_phone
  on public.organization_clients (organization_id, phone_normalized)
  where phone_normalized is not null;

create unique index if not exists idx_organization_clients_org_email
  on public.organization_clients (organization_id, lower(email))
  where email is not null;

create index if not exists idx_organization_clients_org_status
  on public.organization_clients (organization_id, status, created_at desc);

create index if not exists idx_organization_clients_org_zone
  on public.organization_clients (organization_id, zone_id);

create index if not exists idx_organization_clients_org_type
  on public.organization_clients (organization_id, client_type);

alter table public.digests
  add column if not exists organization_client_id bigint references public.organization_clients (id) on delete set null;

alter table public.alerta_click_links
  add column if not exists organization_client_id bigint references public.organization_clients (id) on delete set null;

alter table public.alerta_clicks
  add column if not exists organization_client_id bigint references public.organization_clients (id) on delete set null;

create index if not exists idx_digests_org_client_created
  on public.digests (organization_client_id, created_at desc)
  where organization_client_id is not null;

create index if not exists idx_alerta_click_links_org_client_created
  on public.alerta_click_links (organization_client_id, created_at desc)
  where organization_client_id is not null;

create index if not exists idx_alerta_clicks_org_client_created
  on public.alerta_clicks (organization_client_id, created_at desc)
  where organization_client_id is not null;

alter table public.organization_clients enable row level security;

grant select, insert, update, delete on table public.organization_clients to service_role;
grant usage, select on sequence public.organization_clients_id_seq to service_role;

comment on table public.organization_clients is
  'Clientes/socios propios de una cooperativa. Separado de users (usuarios directos Ruralicos) y organization_staff (empleados del panel).';

comment on column public.organization_clients.preferences_json is
  'Preferencias de recepcion: canales, frecuencia, temas, provincias, cultivos, ganado, lonjas futuras.';

comment on column public.organization_clients.profile_json is
  'Perfil operativo del cliente: municipio, provincia, actividad, cultivos, ganado, explotacion y otros datos editables por la cooperativa.';

comment on column public.digests.organization_client_id is
  'Cliente propio de cooperativa receptor del digest. Nullable para mantener compatibilidad con users.';

comment on column public.alerta_click_links.organization_client_id is
  'Cliente propio de cooperativa asociado al enlace de tracking cuando el receptor no es un user de Ruralicos.';

comment on column public.alerta_clicks.organization_client_id is
  'Cliente propio de cooperativa que hizo click cuando el receptor no es un user de Ruralicos.';
