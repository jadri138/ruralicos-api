-- Quick wins de integridad y rendimiento (auditoria 2026-07-08).
--
-- 1) Indices para las 10 FKs sin indice que las cubra (computadas contra
--    pg_constraint/pg_index, no contra el advisor cacheado). Sin ellos, cada
--    delete/update del padre escanea la tabla hija, y los joins por FK no
--    tienen camino indexado.
-- 2) users.email unico (case-insensitive, parcial): phone ya era unico pero
--    el email permitia cuentas duplicadas. Verificado: 0 duplicados previos.
-- 3) CHECK en users.subscription con el catalogo de config/planes.js:
--    un typo en un update de plan ya no puede dejar un plan inexistente.
--    Verificado: solo existen 'cooperativa', 'corral' y 'free' en produccion.

create index if not exists idx_alerta_click_links_digest_id on public.alerta_click_links (digest_id);
create index if not exists idx_alerta_feedback_digest_id on public.alerta_feedback (digest_id);
create index if not exists idx_alertas_duplicado_de on public.alertas (duplicado_de);
create index if not exists idx_digest_candidate_decisions_attempt_id on public.digest_candidate_decisions (digest_attempt_id);
create index if not exists idx_mia_outbox_decision_id on public.mia_outbox (decision_id);
create index if not exists idx_mia_outbox_inbound_id on public.mia_outbox (inbound_id);
create index if not exists idx_organization_clients_zone_id on public.organization_clients (zone_id);
create index if not exists idx_organization_members_admin_user_id on public.organization_members (admin_user_id);
create index if not exists idx_organization_members_user_id on public.organization_members (user_id);
create index if not exists idx_raw_documents_inserted_alerta_id on public.raw_documents (inserted_alerta_id);

create unique index if not exists uq_users_email_lower
  on public.users (lower(email))
  where email is not null and email <> '';

do $mig$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'users_subscription_check' and conrelid = 'public.users'::regclass
  ) then
    alter table public.users add constraint users_subscription_check
      check (subscription is null or subscription in ('free', 'corral', 'agricultor', 'cooperativa'));
  end if;
end $mig$;
