-- Cierre del schema public para los roles del API publico de Supabase (PostgREST/GraphQL).
--
-- Modelo de acceso de Ruralicos: TODO pasa por el backend Express con la
-- SERVICE_ROLE key. Ningun frontend usa la anon key (verificado en panel,
-- app y partner). Por tanto anon/authenticated no deben poder NADA en public.
--
-- Estado previo en produccion (2026-07-08): RLS habilitado en todas las tablas
-- sin policies (deny-all) y grants de tabla ya revocados a mano. Esta migracion
-- codifica ese cierre (para que un entorno fresco quede igual) y cierra los
-- huecos restantes:
--   1. USAGE sobre el schema: PUBLIC tenia '=U', que anon/authenticated heredan.
--   2. EXECUTE por defecto en funciones futuras creadas por postgres.
--   3. search_path mutable en mia_alert_reviews_touch_updated_at (advisor WARN).
--
-- NOTA: el lint "rls_enabled_no_policy" (INFO) es intencionado: RLS activo sin
-- policies = denegar todo; las policies serian codigo muerto en este modelo.
-- Reversion de emergencia: grant usage on schema public to public;

-- 1) Solo los roles del backend conservan USAGE sobre public.
--    authenticator lo mantiene porque PostgREST construye su schema cache con el;
--    no tiene grants de tabla, asi que no puede leer datos.
revoke usage on schema public from public, anon, authenticated;
grant usage on schema public to postgres, service_role, authenticator;

-- 2) Sin privilegios de objeto para los roles del API publico (idempotente;
--    en produccion ya estaba revocado a mano, en un entorno fresco es necesario).
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- 3) Objetos futuros creados por el rol postgres (migraciones): mismo cierre.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- 4) search_path fijo en la unica funcion de public que no lo tenia
--    (mismo valor que usan el resto de funciones del proyecto).
alter function public.mia_alert_reviews_touch_updated_at() set search_path = public, pg_catalog, pg_temp;
