-- Auditoria de acciones del panel admin de Ruralicos (quien hizo que sobre que
-- recurso). Escrita best-effort desde registrarAdminAuditLog(); leida por
-- GET /admin/audit-log. Hasta ahora la tabla no existia en produccion y el
-- codigo lo toleraba; con el baseline B1 pasa a ser obligatoria.

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_user_id bigint,
  actor_username text,
  organization_id bigint references public.organizations(id),
  action text not null,
  resource_type text not null,
  resource_id text,
  metadata_json jsonb default '{}'::jsonb not null,
  ip_hash text,
  user_agent text,
  created_at timestamp with time zone default now() not null
);

comment on table public.admin_audit_log is
  'Auditoria de acciones del panel admin: actor, accion, recurso y metadatos. Escrita best-effort desde registrarAdminAuditLog().';

create index if not exists idx_admin_audit_log_created on public.admin_audit_log (created_at desc);
create index if not exists idx_admin_audit_log_org_created on public.admin_audit_log (organization_id, created_at desc);
create index if not exists idx_admin_audit_log_action_created on public.admin_audit_log (action, created_at desc);

alter table public.admin_audit_log enable row level security;
