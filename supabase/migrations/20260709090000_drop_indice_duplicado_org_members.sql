-- Limpieza del indice duplicado senalado por el advisor duplicate_index:
-- en organization_members conviven dos indices IDENTICOS sobre
-- (organization_id, status):
--   - idx_organization_members_org         (nacio con la tabla, nombre enganoso)
--   - idx_organization_members_org_status  (creado en 20260616120000, nombre correcto)
-- Se conserva idx_organization_members_org_status (es el que las migraciones
-- posteriores nombran) y se elimina el redundante. Idempotente.

drop index if exists public.idx_organization_members_org;
