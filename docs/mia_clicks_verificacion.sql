-- Ruralicos - Verificacion tracking de clicks
-- Ejecutar despues de docs/mia_clicks_schema.sql.

select
  'tablas_clicks' as check_name,
  count(*) = 2 as ok,
  array_agg(table_name order by table_name) as encontradas
from information_schema.tables
where table_schema = 'public'
  and table_name in ('alerta_click_links', 'alerta_clicks');

select
  'columnas_alerta_click_links' as check_name,
  count(*) = 8 as ok,
  array_agg(column_name order by column_name) as encontradas
from information_schema.columns
where table_schema = 'public'
  and table_name = 'alerta_click_links'
  and column_name in (
    'token',
    'user_id',
    'digest_id',
    'alerta_id',
    'url_destino',
    'created_at',
    'last_clicked_at',
    'click_count'
  );

select
  'columnas_alerta_clicks' as check_name,
  count(*) = 10 as ok,
  array_agg(column_name order by column_name) as encontradas
from information_schema.columns
where table_schema = 'public'
  and table_name = 'alerta_clicks'
  and column_name in (
    'id',
    'token',
    'user_id',
    'digest_id',
    'alerta_id',
    'url_destino',
    'user_agent',
    'referer',
    'ip_hash',
    'created_at'
  );

select
  'indices_clicks' as check_name,
  count(*) >= 5 as ok,
  array_agg(indexname order by indexname) as encontrados
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'idx_alerta_click_links_user_digest',
    'idx_alerta_click_links_alerta',
    'idx_alerta_clicks_user_created',
    'idx_alerta_clicks_alerta_created',
    'idx_alerta_clicks_digest'
  );

select
  'ultimos_links_generados' as check_name,
  count(*) as total_links,
  max(created_at) as ultimo_link
from public.alerta_click_links;

select
  'ultimos_clicks' as check_name,
  count(*) as total_clicks,
  max(created_at) as ultimo_click
from public.alerta_clicks;
