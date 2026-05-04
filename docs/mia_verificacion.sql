-- Ruralicos - Verificacion Fase 1 MIA
-- Ejecutar despues de docs/mia_schema.sql.

select
  'extension_vector' as check_name,
  exists (
    select 1 from pg_extension where extname = 'vector'
  ) as ok;

select
  'columnas_alertas' as check_name,
  count(*) = 2 as ok,
  array_agg(column_name order by column_name) as encontradas
from information_schema.columns
where table_schema = 'public'
  and table_name = 'alertas'
  and column_name in ('embedding', 'embedding_generated_at');

select
  'columnas_users' as check_name,
  count(*) = 5 as ok,
  array_agg(column_name order by column_name) as encontradas
from information_schema.columns
where table_schema = 'public'
  and table_name = 'users'
  and column_name in (
    'perfil_embedding',
    'perfil_version',
    'contexto_narrativo',
    'ultima_interaccion_at',
    'perfil_actualizado_at'
  );

select
  'tablas_mia' as check_name,
  count(*) = 3 as ok,
  array_agg(table_name order by table_name) as encontradas
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'user_memory',
    'exploration_log',
    'user_conversations'
  );

select
  'funcion_buscar_alertas_similares' as check_name,
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'buscar_alertas_similares'
  ) as ok;

select
  'indices_mia' as check_name,
  count(*) >= 8 as ok,
  array_agg(indexname order by indexname) as encontrados
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'idx_alertas_embedding',
    'idx_alertas_embedding_pendiente',
    'idx_user_memory_user_id',
    'idx_user_memory_tipo',
    'idx_user_memory_created_at',
    'idx_user_memory_user_pending_embedding',
    'idx_exploration_log_user_created',
    'idx_exploration_log_resultado',
    'idx_user_conversations_user_estado',
    'idx_user_conversations_expira'
  );

select
  'alerta_feedback_permite_neutro' as check_name,
  exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'alerta_feedback'
      and c.conname = 'alerta_feedback_valor_check'
      and pg_get_constraintdef(c.oid) like '%0%'
  ) as ok;
