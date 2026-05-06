-- Ruralicos - Verificacion seguridad beta
-- Ejecutar despues de docs/security_hardening_schema.sql.

select
  'rls_tablas_sensibles' as check_name,
  count(*) = 8 as ok,
  array_agg(relname order by relname) as encontradas
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'alertas',
    'logs',
    'whatsapp_logs',
    'admin_users',
    'digests',
    'scraper_runs',
    'pipeline_runs',
    'webhook_events'
  )
  and c.relrowsecurity = true;

select
  'indices_seguridad_coste' as check_name,
  count(*) >= 12 as ok,
  array_agg(indexname order by indexname) as encontrados
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'idx_alertas_fecha_estado',
    'idx_alertas_fecha_estado_duplicado',
    'idx_alertas_fuente',
    'idx_digests_user_fecha',
    'ux_alerta_feedback_user_digest_alerta',
    'idx_user_interest_profile_user_tag',
    'idx_user_memory_user_created',
    'idx_user_conversations_user_estado_expira',
    'idx_alerta_clicks_user_created',
    'idx_exploration_log_user_procesado_created',
    'idx_pipeline_runs_stage_started',
    'idx_scraper_runs_fuente_fecha'
  );

select
  'politicas_publicas_peligrosas' as check_name,
  count(*) = 0 as ok,
  array_agg(tablename || ':' || policyname order by tablename, policyname) as encontradas
from pg_policies
where schemaname = 'public'
  and tablename in (
    'alertas',
    'logs',
    'whatsapp_logs',
    'admin_users',
    'digests',
    'scraper_runs',
    'pipeline_runs',
    'webhook_events'
  )
  and (
    roles::text like '%anon%'
    or roles::text like '%public%'
    or qual = 'true'
    or with_check = 'true'
  );
