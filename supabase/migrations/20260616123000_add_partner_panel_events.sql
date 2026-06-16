create table if not exists public.organization_panel_events (
  id bigserial primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  staff_id bigint,
  event_type text not null,
  route text,
  target_type text,
  target_label text,
  target_href text,
  metadata_json jsonb not null default '{}'::jsonb,
  user_agent text,
  created_at timestamptz not null default now(),
  constraint organization_panel_events_type_check
    check (event_type in ('page_view', 'panel_click', 'filter_apply', 'action')),
  constraint organization_panel_events_metadata_object_check
    check (jsonb_typeof(metadata_json) = 'object')
);

create index if not exists idx_organization_panel_events_org_created
  on public.organization_panel_events (organization_id, created_at desc);

create index if not exists idx_organization_panel_events_org_type
  on public.organization_panel_events (organization_id, event_type, created_at desc);

create index if not exists idx_organization_panel_events_org_route
  on public.organization_panel_events (organization_id, route, created_at desc);

create index if not exists idx_organization_panel_events_staff
  on public.organization_panel_events (staff_id, created_at desc);

alter table public.organization_panel_events enable row level security;

grant select, insert, update, delete on table public.organization_panel_events to service_role;
grant usage, select on sequence public.organization_panel_events_id_seq to service_role;

comment on table public.organization_panel_events is
  'Eventos de uso del panel partner por personal de cooperativa: vistas, clicks y acciones no sensibles.';
