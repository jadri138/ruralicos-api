-- Zonas geograficas que cada cooperativa crea para agrupar a sus socios.
-- Pertenecen a una organizacion (no se comparten entre cooperativas). Un socio
-- puede estar en una zona (organization_members.zone_id) o en ninguna.

create table if not exists public.organization_zones (
  id bigserial primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  name text not null,
  color text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Nombre de zona unico por cooperativa (case-insensitive).
create unique index if not exists idx_organization_zones_org_name
  on public.organization_zones (organization_id, lower(name));

create index if not exists idx_organization_zones_org
  on public.organization_zones (organization_id);

alter table public.organization_zones enable row level security;

grant select, insert, update, delete on table public.organization_zones to service_role;
grant usage, select on sequence public.organization_zones_id_seq to service_role;

-- Asignacion de cada socio a una zona (opcional). Al borrar la zona, el socio
-- queda sin zona (no se borra el socio): on delete set null.
alter table public.organization_members
  add column if not exists zone_id bigint references public.organization_zones (id) on delete set null;

create index if not exists idx_organization_members_zone
  on public.organization_members (zone_id);

comment on table public.organization_zones is
  'Zonas geograficas por cooperativa para agrupar socios. No confundir con users (socios) ni con planes.';

comment on column public.organization_zones.name is
  'Nombre de la zona, unico por cooperativa (case-insensitive).';

comment on column public.organization_members.zone_id is
  'Zona (organization_zones) a la que pertenece el socio dentro de su cooperativa. NULL = sin zona.';
