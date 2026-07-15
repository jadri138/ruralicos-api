-- Incluye el estado terminal real `aborted` en la poda de pipeline_jobs.
-- La primera version conservaba nombres legacy que no admite el constraint.

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
    and status in ('completed', 'failed', 'aborted');
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

revoke all on function private.run_operational_retention() from public;
