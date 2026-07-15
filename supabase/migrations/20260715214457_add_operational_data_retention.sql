-- Retencion de datos operativos.
--
-- Se preservan siempre:
--   * digests y digest_items;
--   * alertas listas para consulta/aprendizaje;
--   * alertas enviadas o referenciadas por digests, feedback o memoria de MIA.
--
-- Los historiales reconstruibles conservan una ventana suficiente para
-- diagnostico sin crecer indefinidamente.

create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.protected_alert_ids_for_retention()
returns table (id bigint)
language sql
stable
set search_path = pg_catalog
as $function$
  with digest_json_alerts as (
    select distinct item.value::bigint as alerta_id
    from public.digests d
    cross join lateral jsonb_array_elements_text(
      case
        when jsonb_typeof(d.alerta_ids) = 'array' then d.alerta_ids
        else '[]'::jsonb
      end
    ) as item(value)
    where item.value ~ '^[0-9]+$'
  )
  select a.id
  from public.alertas a
  where a.estado_ia = 'listo'
     or coalesce(a.whatsapp_enviado, false)
     or coalesce(a.whatsapp_enviado_free, false)
     or exists (
       select 1 from public.digest_items di where di.alerta_id = a.id
     )
     or exists (
       select 1 from digest_json_alerts dj where dj.alerta_id = a.id
     )
     or exists (
       select 1 from public.alerta_feedback af where af.alerta_id = a.id
     )
     or exists (
       select 1 from public.alerta_click_links acl where acl.alerta_id = a.id
     )
     or exists (
       select 1 from public.user_memory um where um.alerta_id = a.id
     )
     or exists (
       select 1 from public.exploration_log el where el.alerta_id = a.id
     )
     or exists (
       select 1 from public.official_list_matches olm where olm.alerta_id = a.id
     );
$function$;

create or replace function private.run_operational_retention()
returns jsonb
language plpgsql
set search_path = pg_catalog
set lock_timeout = '5s'
set statement_timeout = '5min'
as $function$
declare
  deleted_candidate_decisions bigint := 0;
  deleted_alerts bigint := 0;
  deleted_raw_documents bigint := 0;
  deleted_scraper_runs bigint := 0;
  deleted_digest_attempts bigint := 0;
  deleted_pipeline_runs bigint := 0;
  deleted_pipeline_jobs bigint := 0;
  deleted_ia_runs bigint := 0;
  deleted_whatsapp_logs bigint := 0;
  deleted_webhook_events bigint := 0;
  deleted_logs bigint := 0;
  deleted_outbox bigint := 0;
  deleted_verification_codes bigint := 0;
  deleted_cron_runs bigint := 0;
begin
  delete from public.digest_candidate_decisions
  where created_at < now() - interval '14 days';
  get diagnostics deleted_candidate_decisions = row_count;

  delete from public.alertas a
  where a.created_at < now() - interval '30 days'
    and not exists (
      select 1
      from private.protected_alert_ids_for_retention() protected
      where protected.id = a.id
    );
  get diagnostics deleted_alerts = row_count;

  -- Al borrar una alerta no protegida su documento queda desligado por FK.
  -- Los documentos asociados a alertas protegidas se conservan sin caducidad.
  delete from public.raw_documents
  where created_at < now() - interval '14 days'
    and inserted_alerta_id is null;
  get diagnostics deleted_raw_documents = row_count;

  delete from public.scraper_runs
  where started_at < now() - interval '14 days';
  get diagnostics deleted_scraper_runs = row_count;

  delete from public.digest_attempts
  where created_at < now() - interval '30 days';
  get diagnostics deleted_digest_attempts = row_count;

  delete from public.pipeline_runs
  where started_at < now() - interval '30 days';
  get diagnostics deleted_pipeline_runs = row_count;

  delete from public.pipeline_jobs
  where created_at < now() - interval '30 days'
    and status in ('completed', 'error', 'failed', 'cancelled');
  get diagnostics deleted_pipeline_jobs = row_count;

  delete from public.ia_runs
  where created_at < now() - interval '30 days';
  get diagnostics deleted_ia_runs = row_count;

  delete from public.whatsapp_logs
  where created_at < now() - interval '90 days';
  get diagnostics deleted_whatsapp_logs = row_count;

  delete from public.webhook_events
  where created_at < now() - interval '30 days';
  get diagnostics deleted_webhook_events = row_count;

  delete from public.logs
  where created_at < now() - interval '30 days';
  get diagnostics deleted_logs = row_count;

  delete from public.mia_outbox
  where status = 'sent'
    and coalesce(sent_at, updated_at, created_at) < now() - interval '30 days';
  get diagnostics deleted_outbox = row_count;

  delete from public.verification_codes
  where expires_at < now() - interval '7 days';
  get diagnostics deleted_verification_codes = row_count;

  delete from cron.job_run_details
  where end_time < now() - interval '30 days';
  get diagnostics deleted_cron_runs = row_count;

  return jsonb_build_object(
    'digest_candidate_decisions', deleted_candidate_decisions,
    'alertas', deleted_alerts,
    'raw_documents', deleted_raw_documents,
    'scraper_runs', deleted_scraper_runs,
    'digest_attempts', deleted_digest_attempts,
    'pipeline_runs', deleted_pipeline_runs,
    'pipeline_jobs', deleted_pipeline_jobs,
    'ia_runs', deleted_ia_runs,
    'whatsapp_logs', deleted_whatsapp_logs,
    'webhook_events', deleted_webhook_events,
    'logs', deleted_logs,
    'mia_outbox', deleted_outbox,
    'verification_codes', deleted_verification_codes,
    'cron_job_run_details', deleted_cron_runs
  );
end;
$function$;

revoke all on function private.protected_alert_ids_for_retention() from public;
revoke all on function private.run_operational_retention() from public;

do $block$
declare
  existing_job_id bigint;
begin
  select jobid
  into existing_job_id
  from cron.job
  where jobname = 'ruralicos-operational-retention';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
end;
$block$;

select cron.schedule(
  'ruralicos-operational-retention',
  '25 3 * * *',
  $cron$select private.run_operational_retention();$cron$
);

comment on function private.run_operational_retention() is
  'Poda datos operativos reconstruibles; preserva digests y alertas utiles para MIA.';
