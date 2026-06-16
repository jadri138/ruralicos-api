-- Endurece el contrato que usa el panel partner para altas/bajas de socios.
-- La baja marca organization_members.status = 'inactive' antes de desasignar
-- users.organization_id; por eso la constraint debe aceptar ese estado.

do $$
declare
  constraint_record record;
begin
  if to_regclass('public.organization_members') is null then
    raise notice 'public.organization_members no existe; se omite migracion partner panel members';
    return;
  end if;

  execute 'alter table public.organization_members add column if not exists status text not null default ''active''';
  execute 'update public.organization_members set status = ''active'' where status is null';

  if exists (
    select 1
    from public.organization_members
    where status not in ('active', 'inactive', 'pending')
    limit 1
  ) then
    raise exception 'organization_members.status contiene valores fuera de active/inactive/pending';
  end if;

  for constraint_record in
    select conname
    from pg_constraint
    where conrelid = 'public.organization_members'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.organization_members drop constraint %I', constraint_record.conname);
  end loop;
  execute 'alter table public.organization_members alter column status set default ''active''';
  execute 'alter table public.organization_members alter column status set not null';
  execute 'alter table public.organization_members add constraint organization_members_status_check check (status in (''active'', ''inactive'', ''pending''))';

  if exists (
    select 1
    from public.organization_members
    group by organization_id, user_id
    having count(*) > 1
    limit 1
  ) then
    raise exception 'organization_members tiene duplicados organization_id/user_id; revisalos antes de crear el indice unico';
  end if;

  execute 'create unique index if not exists idx_organization_members_org_user on public.organization_members (organization_id, user_id)';
  execute 'create index if not exists idx_organization_members_org_status on public.organization_members (organization_id, status)';
  execute 'create index if not exists idx_organization_members_org_role on public.organization_members (organization_id, role)';

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_members'
      and column_name = 'zone_id'
  ) then
    execute 'create index if not exists idx_organization_members_org_zone on public.organization_members (organization_id, zone_id)';
  end if;

  execute 'grant select, insert, update, delete on table public.organization_members to service_role';
  execute 'comment on constraint organization_members_status_check on public.organization_members is ''Estado del socio dentro de una cooperativa: active | inactive | pending.''';
end $$;
