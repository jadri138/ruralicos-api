-- Refuerza los datos de clicks para que los insights de cooperativa funcionen
-- aunque haya filas historicas sin organization_id.

alter table public.alerta_click_links
  add column if not exists organization_id bigint references public.organizations (id);

alter table public.alerta_clicks
  add column if not exists organization_id bigint references public.organizations (id);

with link_candidates as (
  select
    link.token,
    coalesce(users.organization_id, digests.organization_id, alertas.organization_id) as organization_id
  from public.alerta_click_links link
  left join public.users on users.id = link.user_id
  left join public.digests on digests.id = link.digest_id
  left join public.alertas on alertas.id = link.alerta_id
  where link.organization_id is null
)
update public.alerta_click_links link
set organization_id = link_candidates.organization_id
from link_candidates
where link.token = link_candidates.token
  and link_candidates.organization_id is not null;

with click_candidates as (
  select
    click.id,
    coalesce(link.organization_id, users.organization_id, digests.organization_id, alertas.organization_id) as organization_id
  from public.alerta_clicks click
  left join public.alerta_click_links link on link.token = click.token
  left join public.users on users.id = click.user_id
  left join public.digests on digests.id = click.digest_id
  left join public.alertas on alertas.id = click.alerta_id
  where click.organization_id is null
)
update public.alerta_clicks click
set organization_id = click_candidates.organization_id
from click_candidates
where click.id = click_candidates.id
  and click_candidates.organization_id is not null;

create index if not exists idx_alerta_clicks_org_created
  on public.alerta_clicks (organization_id, created_at desc);

create index if not exists idx_alerta_clicks_org_user_created
  on public.alerta_clicks (organization_id, user_id, created_at desc);

create index if not exists idx_alerta_clicks_user_created
  on public.alerta_clicks (user_id, created_at desc);

create index if not exists idx_alerta_click_links_org_created
  on public.alerta_click_links (organization_id, created_at desc);

grant select, insert, update, delete on table public.alerta_click_links to service_role;
grant select, insert, update, delete on table public.alerta_clicks to service_role;
