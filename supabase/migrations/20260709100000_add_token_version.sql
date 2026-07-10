-- Revocacion de sesiones por version de credencial (paso 7 plan SaaS).
-- Cada JWT lleva `tv` = token_version al firmarse; los middlewares de auth
-- comparan contra la columna y un cambio de contrasena (o desactivacion de
-- staff) incrementa la version, invalidando todos los tokens anteriores.
-- Default 0 = compatible con los tokens ya emitidos (sin claim tv).
--
-- IMPORTANTE (orden de deploy): aplicar esta migracion ANTES de desplegar el
-- codigo que la usa — los logins hacen select de token_version.

alter table public.users add column if not exists token_version integer default 0 not null;
alter table public.organization_staff add column if not exists token_version integer default 0 not null;
alter table public.admin_users add column if not exists token_version integer default 0 not null;
