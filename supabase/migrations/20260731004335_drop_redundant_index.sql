-- Evita mantener dos B-tree idénticos en cada escritura.
--
-- La PK de user_interest_profile ya indexa (user_id, tag).
-- IF EXISTS mantiene la migración segura si un entorno ya lo eliminó.

drop index if exists public.idx_user_interest_profile_user_tag;
