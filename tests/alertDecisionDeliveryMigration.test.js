const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260801211224_alert_decision_delivery_contracts.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

for (const column of [
  'decision_state',
  'contract_version',
  'policy_version',
  'judge_version',
  'prompt_version',
  'reason_codes',
  'input_hash',
  'llm_model',
  'llm_usage',
  'llm_cost',
  'llm_calls',
  'cache_hit',
  'fallback_reason',
  'decided_at',
  'hold_status',
  'hold_attempts',
  'hold_next_at',
  'hold_last_at',
  'hold_claim_token',
  'hold_claimed_at',
  'hold_resolution_json',
]) {
  assert(sql.includes(`add column if not exists ${column}`), `Falta columna de decisión ${column}`);
}
assert.match(sql, /digest_candidate_decisions_llm_audit_check/i);
assert.match(sql, /idx_digest_candidate_decisions_input_hash[\s\S]+llm_model[\s\S]+personal_relevance_judge/i);
assert.match(sql, /idx_digest_candidate_decisions_judge_daily_usage/i);
assert.match(sql, /digest_candidate_decisions_hold_lifecycle_check/i);
assert.match(sql, /hold_status in \('PENDING', 'FAILED'\) and hold_next_at is not null/i);
assert.match(sql, /hold_status = 'PROCESSING'[\s\S]+hold_claim_token is not null[\s\S]+hold_claimed_at is not null/i);
assert.match(
  sql,
  /idx_digest_candidate_decisions_hold_retry[\s\S]+user_id, hold_next_at, id[\s\S]+hold_status in \('PENDING', 'FAILED'\)/i
);
assert.match(sql, /create table if not exists public\.alert_decision_llm_daily_budget/i);
assert.match(sql, /create or replace function public\.reserve_alert_decision_llm_call/i);
assert.match(sql, /reserved_calls < call_limit/i);
assert.match(sql, /grant execute on function public\.reserve_alert_decision_llm_call[\s\S]+to service_role/i);

for (const column of [
  'idempotency_key',
  'provider_message_id',
  'message_version',
  'delivery_status',
  'accepted_at',
  'sent_to_whatsapp_at',
  'delivered_at',
  'read_at',
  'failed_at',
]) {
  assert(sql.includes(`add column if not exists ${column}`), `Falta campo de entrega ${column}`);
}

assert.match(sql, /create table if not exists public\.whatsapp_delivery_events/i);
assert.match(sql, /unique \(event_hash\)/i);
assert.match(sql, /alter table public\.whatsapp_delivery_events enable row level security/i);
assert.match(sql, /revoke all on table public\.whatsapp_delivery_events from public, anon, authenticated/i);
assert.match(sql, /grant select, insert, update, delete[\s\S]+to service_role/i);
assert.match(sql, /where delivery_status in \('PROVIDER_ACCEPTED', 'SENT_TO_WHATSAPP'\)/i);

const digestBackfill = sql.slice(
  sql.indexOf('update public.digests'),
  sql.indexOf('update public.mia_outbox')
);
assert.match(digestBackfill, /set delivery_status = 'PROVIDER_ACCEPTED'/i);
assert.match(digestBackfill, /and enviado is true/i);
assert.doesNotMatch(digestBackfill, /APPROVED/i, 'No se deben aprobar digests históricos sin evidencia');

const outboxBackfill = sql.slice(
  sql.indexOf('update public.mia_outbox'),
  sql.indexOf('update public.whatsapp_logs')
);
assert.match(outboxBackfill, /provider_message_id is not null or status = 'sent'/i);
assert.match(outboxBackfill, /status in \('queued', 'failed'\)/i);
assert.match(outboxBackfill, /delivery_updated_at = coalesce/i);
assert.doesNotMatch(outboxBackfill, /status = 'sending'/i, 'Un sending histórico debe seguir ambiguo');
assert.doesNotMatch(outboxBackfill, /else 'QUEUED'/i, 'No se deben reactivar estados legacy desconocidos');

assert.match(sql, /create unique index if not exists uq_mia_outbox_provider_message_id[\s\S]+where provider_message_id is not null/i);
assert.match(sql, /drop index if exists public\.uq_mia_outbox_digest/i);
const digestOutboxUnique = sql.match(
  /create unique index uq_mia_outbox_digest[\s\S]+?where[\s\S]+?;/i
)?.[0] || '';
assert.match(digestOutboxUnique, /channel,\s*to_phone,\s*digest_id/i);
assert.match(digestOutboxUnique, /digest_id is not null/i);
assert.match(digestOutboxUnique, /metadata_json->>'source'\s*=\s*'digest_diario'/i);
assert.doesNotMatch(digestOutboxUnique, /learning_question/i);
assert.match(
  sql,
  /create unique index if not exists uq_mia_outbox_learning_question_digest[\s\S]+?user_id, digest_id[\s\S]+?metadata_json->>'intent'\s*=\s*'learning_question'/i
);
assert.match(sql, /update public\.mia_outbox as outbox[\s\S]+?set digest_id = digest\.id[\s\S]+?from public\.digests as digest/i);
assert.match(
  sql,
  /create index if not exists idx_digest_candidate_decisions_judge_daily_usage\s+on public\.digest_candidate_decisions \(created_at desc\)/i
);
for (const index of [
  'idx_mia_outbox_digest_id',
  'idx_whatsapp_logs_digest_id',
  'idx_whatsapp_logs_user_id',
  'idx_whatsapp_delivery_events_user',
]) {
  assert(sql.includes(`create index if not exists ${index}`), `Falta índice de FK ${index}`);
}

for (const column of [
  'memory_key',
  'scope_type',
  'scope_value',
  'polarity',
  'source',
  'strength',
  'confidence',
  'expires_at',
  'correction_of',
  'duplicate_count',
  'last_seen_at',
  'decision_version',
  'inbound_id',
]) {
  assert(sql.includes(`add column if not exists ${column}`), `Falta campo de memoria ${column}`);
}

assert.match(sql, /alter column score type double precision/i);
assert.match(sql, /comment on table public\.mia_structured_memory[\s\S]+solo para lectura/i);
assert.match(sql, /create or replace function private\.protected_alert_ids_for_retention\(\)/i);
assert.match(sql, /from public\.digest_candidate_decisions dcd[\s\S]+interval '180 days'/i);
assert.match(sql, /create or replace function private\.run_operational_retention\(\)/i);
assert.match(sql, /digest_candidate_decisions[\s\S]+interval '180 days'/i);
assert.match(sql, /digest_attempts[\s\S]+interval '180 days'/i);
assert.match(sql, /whatsapp_logs[\s\S]+interval '90 days'/i);
assert.match(sql, /delete from public\.whatsapp_delivery_events[\s\S]+interval '180 days'/i);
assert.match(sql, /delivery_status in \('DELIVERED', 'READ', 'FAILED', 'UNDELIVERED'\)/i);
assert.match(sql, /'whatsapp_delivery_events', deleted_delivery_events/i);

console.log('OK: migración única de decisión, entrega, memoria y recuperación');
