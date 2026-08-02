-- Contratos canónicos para decisión, entrega, memoria atómica y recuperación.
--
-- Migración principalmente aditiva, compatible y forward-only. También
-- estrecha un índice legacy y convierte un score entero a decimal sin borrar
-- datos. Los estados nuevos quedan separados de `status` y `enviado`.

-- ---------------------------------------------------------------------------
-- Decisión usuario-alerta y embudo diario
-- ---------------------------------------------------------------------------

alter table public.digest_candidate_decisions
  add column if not exists decision_state text,
  add column if not exists contract_version text,
  add column if not exists policy_version text,
  add column if not exists judge_version text,
  add column if not exists prompt_version text,
  add column if not exists reason_codes text[] not null default '{}'::text[],
  add column if not exists input_hash text,
  add column if not exists llm_model text,
  add column if not exists llm_usage jsonb,
  add column if not exists llm_cost jsonb,
  add column if not exists llm_calls integer not null default 0,
  add column if not exists cache_hit boolean not null default false,
  add column if not exists fallback_reason text,
  add column if not exists decided_at timestamptz,
  add column if not exists hold_status text,
  add column if not exists hold_attempts integer not null default 0,
  add column if not exists hold_next_at timestamptz,
  add column if not exists hold_last_at timestamptz,
  add column if not exists hold_claim_token text,
  add column if not exists hold_claimed_at timestamptz,
  add column if not exists hold_resolution_json jsonb not null default '{}'::jsonb;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'digest_candidate_decisions_state_check'
      and conrelid = 'public.digest_candidate_decisions'::regclass
  ) then
    alter table public.digest_candidate_decisions
      add constraint digest_candidate_decisions_state_check
      check (
        decision_state is null or decision_state in (
          'SEND_NOW',
          'ADD_TO_DIGEST',
          'HOLD_FOR_EVIDENCE',
          'DROP',
          'BLOCKED'
        )
      ) not valid;
  end if;
end
$migration$;

alter table public.digest_candidate_decisions
  validate constraint digest_candidate_decisions_state_check;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'digest_candidate_decisions_llm_audit_check'
      and conrelid = 'public.digest_candidate_decisions'::regclass
  ) then
    alter table public.digest_candidate_decisions
      add constraint digest_candidate_decisions_llm_audit_check
      check (
        llm_calls >= 0
        and (llm_usage is null or jsonb_typeof(llm_usage) = 'object')
        and (llm_cost is null or jsonb_typeof(llm_cost) = 'object')
      ) not valid;
  end if;
end
$migration$;

alter table public.digest_candidate_decisions
  validate constraint digest_candidate_decisions_llm_audit_check;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'digest_candidate_decisions_hold_lifecycle_check'
      and conrelid = 'public.digest_candidate_decisions'::regclass
  ) then
    alter table public.digest_candidate_decisions
      add constraint digest_candidate_decisions_hold_lifecycle_check
      check (
        hold_attempts >= 0
        and jsonb_typeof(hold_resolution_json) = 'object'
        and (
          hold_status is null or hold_status in (
            'PENDING', 'PROCESSING', 'FAILED', 'RESOLVED', 'EXHAUSTED', 'EXPIRED'
          )
        )
        and (
          hold_status is null
          or (hold_status in ('PENDING', 'FAILED') and hold_next_at is not null)
          or (
            hold_status = 'PROCESSING'
            and hold_claim_token is not null
            and hold_claimed_at is not null
          )
          or (hold_status in ('RESOLVED', 'EXHAUSTED', 'EXPIRED') and hold_next_at is null)
        )
      ) not valid;
  end if;
end
$migration$;

alter table public.digest_candidate_decisions
  validate constraint digest_candidate_decisions_hold_lifecycle_check;

create index if not exists idx_digest_candidate_decisions_state_fecha
  on public.digest_candidate_decisions (decision_state, fecha desc)
  where decision_state is not null;

create index if not exists idx_digest_candidate_decisions_input_hash
  on public.digest_candidate_decisions (
    input_hash,
    contract_version,
    policy_version,
    judge_version,
    prompt_version,
    llm_model,
    decided_at desc
  )
  where input_hash is not null and stage = 'personal_relevance_judge';

create index if not exists idx_digest_candidate_decisions_judge_daily_usage
  on public.digest_candidate_decisions (created_at desc)
  where stage = 'personal_relevance_judge';

create index if not exists idx_digest_candidate_decisions_hold_retry
  on public.digest_candidate_decisions (user_id, hold_next_at, id)
  where stage = 'personal_relevance_judge'
    and hold_status in ('PENDING', 'FAILED');

alter table public.digest_attempts
  add column if not exists delivery_status text,
  add column if not exists judge_evaluated_count integer not null default 0,
  add column if not exists approved_count integer not null default 0,
  add column if not exists queued_count integer not null default 0,
  add column if not exists delivered_count integer not null default 0;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'digest_attempts_delivery_status_check'
      and conrelid = 'public.digest_attempts'::regclass
  ) then
    alter table public.digest_attempts
      add constraint digest_attempts_delivery_status_check
      check (
        delivery_status is null or delivery_status in (
          'DRAFT', 'APPROVED', 'QUEUED', 'PROVIDER_ACCEPTED',
          'SENT_TO_WHATSAPP', 'DELIVERED', 'READ', 'FAILED', 'UNDELIVERED'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'digest_attempts_delivery_counts_check'
      and conrelid = 'public.digest_attempts'::regclass
  ) then
    alter table public.digest_attempts
      add constraint digest_attempts_delivery_counts_check
      check (
        judge_evaluated_count >= 0
        and approved_count >= 0
        and queued_count >= 0
        and delivered_count >= 0
      ) not valid;
  end if;
end
$migration$;

alter table public.digest_attempts
  validate constraint digest_attempts_delivery_status_check;
alter table public.digest_attempts
  validate constraint digest_attempts_delivery_counts_check;

create index if not exists idx_digest_attempts_delivery_status_fecha
  on public.digest_attempts (delivery_status, fecha desc)
  where delivery_status is not null;

comment on column public.digest_candidate_decisions.decision_state is
  'Estado contractual final de la pareja usuario-alerta.';
comment on column public.digest_candidate_decisions.input_hash is
  'Huella reproducible de la entrada estructurada enviada al juez.';
comment on column public.digest_candidate_decisions.llm_usage is
  'Uso de tokens informado por el proveedor para esta evaluacion; null en cache o fallback.';
comment on column public.digest_candidate_decisions.llm_cost is
  'Coste calculado solo con tarifas configuradas y uso real; nunca presupone precios.';
comment on column public.digest_attempts.delivery_status is
  'Último estado agregado de entrega observado para el intento de digest.';

-- Reserva atómica del presupuesto diario del juez. La tabla no contiene PII;
-- solo impide que dos requests o instancias consuman el mismo saldo.
create table if not exists public.alert_decision_llm_daily_budget (
  fecha date primary key,
  call_limit integer not null,
  reserved_calls integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint alert_decision_llm_daily_budget_limit_check check (call_limit > 0),
  constraint alert_decision_llm_daily_budget_reserved_check check (reserved_calls >= 0)
);

alter table public.alert_decision_llm_daily_budget enable row level security;
revoke all on table public.alert_decision_llm_daily_budget from public, anon, authenticated;
grant select, insert, update, delete
  on table public.alert_decision_llm_daily_budget
  to service_role;

create or replace function public.reserve_alert_decision_llm_call(
  p_fecha date,
  p_limit integer,
  p_observed_calls integer default 0
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $function$
declare
  v_used integer;
  v_limit integer;
begin
  if p_fecha is null or p_limit is null or p_limit < 1 then
    raise exception 'invalid_alert_decision_llm_budget';
  end if;

  insert into public.alert_decision_llm_daily_budget as budget (
    fecha,
    call_limit,
    reserved_calls,
    updated_at
  ) values (
    p_fecha,
    p_limit,
    greatest(0, coalesce(p_observed_calls, 0)),
    now()
  )
  on conflict (fecha) do update
  set call_limit = excluded.call_limit,
      reserved_calls = greatest(budget.reserved_calls, excluded.reserved_calls),
      updated_at = now();

  update public.alert_decision_llm_daily_budget
  set reserved_calls = reserved_calls + 1,
      updated_at = now()
  where fecha = p_fecha
    and reserved_calls < call_limit
  returning reserved_calls, call_limit into v_used, v_limit;

  if found then
    return jsonb_build_object(
      'allowed', true,
      'used_calls', v_used,
      'remaining_calls', greatest(0, v_limit - v_used)
    );
  end if;

  select reserved_calls, call_limit
  into v_used, v_limit
  from public.alert_decision_llm_daily_budget
  where fecha = p_fecha;

  return jsonb_build_object(
    'allowed', false,
    'used_calls', coalesce(v_used, 0),
    'remaining_calls', greatest(0, coalesce(v_limit, p_limit) - coalesce(v_used, 0))
  );
end;
$function$;

revoke all on function public.reserve_alert_decision_llm_call(date, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_alert_decision_llm_call(date, integer, integer)
  to service_role;

comment on table public.alert_decision_llm_daily_budget is
  'Reservas atómicas de llamadas lógicas del juez por día de Madrid.';

-- ---------------------------------------------------------------------------
-- Entrega real e idempotencia
-- ---------------------------------------------------------------------------

alter table public.digests
  add column if not exists idempotency_key text,
  add column if not exists message_version text,
  add column if not exists delivery_status text,
  add column if not exists provider_message_id text,
  add column if not exists accepted_at timestamptz,
  add column if not exists sent_to_whatsapp_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz,
  add column if not exists failed_at timestamptz;

alter table public.mia_outbox
  add column if not exists idempotency_key text,
  add column if not exists digest_id bigint,
  add column if not exists provider text not null default 'ultramsg',
  add column if not exists provider_message_id text,
  add column if not exists provider_status text,
  add column if not exists message_version text,
  add column if not exists delivery_status text,
  add column if not exists accepted_at timestamptz,
  add column if not exists sent_to_whatsapp_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists provider_error_code text,
  add column if not exists provider_error_reason text,
  add column if not exists delivery_updated_at timestamptz,
  add column if not exists reconcile_after timestamptz,
  add column if not exists reconciliation_attempts integer not null default 0;

alter table public.whatsapp_logs
  add column if not exists idempotency_key text,
  add column if not exists outbox_id bigint,
  add column if not exists digest_id bigint,
  add column if not exists user_id bigint,
  add column if not exists provider text not null default 'ultramsg',
  add column if not exists provider_message_id text,
  add column if not exists provider_status text,
  add column if not exists message_version text,
  add column if not exists delivery_status text,
  add column if not exists accepted_at timestamptz,
  add column if not exists sent_to_whatsapp_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists provider_error_code text,
  add column if not exists provider_error_reason text,
  add column if not exists updated_at timestamptz not null default now();

-- Normaliza solo hechos inequívocos. Un `sent` histórico significaba respuesta
-- HTTP aceptada, no entrega al dispositivo; por eso nunca se migra a DELIVERED.
-- Los borradores y los `sending` ambiguos conservan delivery_status nulo.
update public.digests
set delivery_status = 'PROVIDER_ACCEPTED',
    accepted_at = coalesce(accepted_at, enviado_at)
where delivery_status is null
  and enviado is true;

update public.mia_outbox
set delivery_status = 'PROVIDER_ACCEPTED',
    accepted_at = coalesce(accepted_at, sent_at),
    delivery_updated_at = coalesce(delivery_updated_at, sent_at, updated_at, created_at, now()),
    reconcile_after = case
      when provider_message_id is not null then coalesce(reconcile_after, now())
      else reconcile_after
    end
where delivery_status is null
  and (provider_message_id is not null or status = 'sent');

update public.mia_outbox
set delivery_status = 'QUEUED',
    delivery_updated_at = coalesce(delivery_updated_at, updated_at, created_at, now())
where delivery_status is null
  and provider_message_id is null
  and status in ('queued', 'failed');

update public.whatsapp_logs
set delivery_status = case
      when provider_message_id is not null then 'PROVIDER_ACCEPTED'
      when lower(coalesce(status, '')) in ('enviado', 'sent', 'accepted') then 'PROVIDER_ACCEPTED'
      when lower(coalesce(status, '')) in ('error', 'failed') then 'FAILED'
      else null
    end,
    updated_at = coalesce(updated_at, created_at, now())
where delivery_status is null;

-- Materializa el vínculo que antes solo vivía dentro del JSON. Solo se aceptan
-- IDs que existen, de modo que la FK posterior pueda validarse con seguridad.
update public.mia_outbox as outbox
set digest_id = digest.id
from public.digests as digest
where outbox.digest_id is null
  and outbox.metadata_json ? 'digest_id'
  and outbox.metadata_json->>'digest_id' ~ '^[0-9]+$'
  and digest.id::text = outbox.metadata_json->>'digest_id';

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'digests_delivery_status_check'
      and conrelid = 'public.digests'::regclass
  ) then
    alter table public.digests
      add constraint digests_delivery_status_check
      check (
        delivery_status is null or delivery_status in (
          'DRAFT', 'APPROVED', 'QUEUED', 'PROVIDER_ACCEPTED',
          'SENT_TO_WHATSAPP', 'DELIVERED', 'READ', 'FAILED', 'UNDELIVERED'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'mia_outbox_delivery_status_check'
      and conrelid = 'public.mia_outbox'::regclass
  ) then
    alter table public.mia_outbox
      add constraint mia_outbox_delivery_status_check
      check (
        delivery_status is null or delivery_status in (
          'DRAFT', 'APPROVED', 'QUEUED', 'PROVIDER_ACCEPTED',
          'SENT_TO_WHATSAPP', 'DELIVERED', 'READ', 'FAILED', 'UNDELIVERED'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'mia_outbox_reconciliation_attempts_check'
      and conrelid = 'public.mia_outbox'::regclass
  ) then
    alter table public.mia_outbox
      add constraint mia_outbox_reconciliation_attempts_check
      check (reconciliation_attempts >= 0) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'mia_outbox_digest_id_fkey'
      and conrelid = 'public.mia_outbox'::regclass
  ) then
    alter table public.mia_outbox
      add constraint mia_outbox_digest_id_fkey
      foreign key (digest_id) references public.digests (id) on delete set null
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'whatsapp_logs_delivery_status_check'
      and conrelid = 'public.whatsapp_logs'::regclass
  ) then
    alter table public.whatsapp_logs
      add constraint whatsapp_logs_delivery_status_check
      check (
        delivery_status is null or delivery_status in (
          'DRAFT', 'APPROVED', 'QUEUED', 'PROVIDER_ACCEPTED',
          'SENT_TO_WHATSAPP', 'DELIVERED', 'READ', 'FAILED', 'UNDELIVERED'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'whatsapp_logs_outbox_id_fkey'
      and conrelid = 'public.whatsapp_logs'::regclass
  ) then
    alter table public.whatsapp_logs
      add constraint whatsapp_logs_outbox_id_fkey
      foreign key (outbox_id) references public.mia_outbox (id) on delete set null
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'whatsapp_logs_digest_id_fkey'
      and conrelid = 'public.whatsapp_logs'::regclass
  ) then
    alter table public.whatsapp_logs
      add constraint whatsapp_logs_digest_id_fkey
      foreign key (digest_id) references public.digests (id) on delete set null
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'whatsapp_logs_user_id_fkey'
      and conrelid = 'public.whatsapp_logs'::regclass
  ) then
    alter table public.whatsapp_logs
      add constraint whatsapp_logs_user_id_fkey
      foreign key (user_id) references public.users (id) on delete cascade
      not valid;
  end if;
end
$migration$;

alter table public.digests validate constraint digests_delivery_status_check;
alter table public.mia_outbox validate constraint mia_outbox_delivery_status_check;
alter table public.mia_outbox validate constraint mia_outbox_reconciliation_attempts_check;
alter table public.mia_outbox validate constraint mia_outbox_digest_id_fkey;
alter table public.whatsapp_logs validate constraint whatsapp_logs_delivery_status_check;
alter table public.whatsapp_logs validate constraint whatsapp_logs_outbox_id_fkey;
alter table public.whatsapp_logs validate constraint whatsapp_logs_digest_id_fkey;
alter table public.whatsapp_logs validate constraint whatsapp_logs_user_id_fkey;

create unique index if not exists uq_digests_idempotency_key
  on public.digests (idempotency_key)
  where idempotency_key is not null;

-- El índice legacy trataba cualquier metadata.digest_id como si fuera el
-- propio mensaje digest. Las preguntas selectivas también referencian ese ID,
-- así que se limita la unicidad antigua a las filas de digest real. La clave
-- idempotente siguiente protege de forma universal el resto de mensajes.
drop index if exists public.uq_mia_outbox_digest;
create unique index uq_mia_outbox_digest
  on public.mia_outbox (channel, to_phone, digest_id)
  where digest_id is not null
    and metadata_json->>'source' = 'digest_diario';

create unique index if not exists uq_mia_outbox_learning_question_digest
  on public.mia_outbox (user_id, digest_id)
  where user_id is not null
    and digest_id is not null
    and metadata_json->>'intent' = 'learning_question';

create unique index if not exists uq_mia_outbox_idempotency_key
  on public.mia_outbox (idempotency_key)
  where idempotency_key is not null;

create unique index if not exists uq_whatsapp_logs_idempotency_key
  on public.whatsapp_logs (idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_digests_provider_message_id
  on public.digests (provider_message_id)
  where provider_message_id is not null;

create unique index if not exists uq_mia_outbox_provider_message_id
  on public.mia_outbox (provider_message_id)
  where provider_message_id is not null;

create index if not exists idx_mia_outbox_digest_id
  on public.mia_outbox (digest_id)
  where digest_id is not null;

create index if not exists idx_mia_outbox_reconcile_stuck
  on public.mia_outbox (reconcile_after, delivery_updated_at)
  where delivery_status in ('PROVIDER_ACCEPTED', 'SENT_TO_WHATSAPP');

create index if not exists idx_whatsapp_logs_provider_message_id
  on public.whatsapp_logs (provider_message_id)
  where provider_message_id is not null;

create index if not exists idx_whatsapp_logs_outbox
  on public.whatsapp_logs (outbox_id, created_at desc)
  where outbox_id is not null;

create index if not exists idx_whatsapp_logs_digest_id
  on public.whatsapp_logs (digest_id)
  where digest_id is not null;

create index if not exists idx_whatsapp_logs_user_id
  on public.whatsapp_logs (user_id)
  where user_id is not null;

create table if not exists public.whatsapp_delivery_events (
  id bigint generated always as identity primary key,
  event_hash text not null,
  idempotency_key text,
  outbox_id bigint references public.mia_outbox (id) on delete set null,
  digest_id bigint references public.digests (id) on delete set null,
  user_id bigint references public.users (id) on delete cascade,
  provider text not null default 'ultramsg',
  provider_message_id text,
  provider_status text not null,
  delivery_status text not null,
  message_version text,
  event_at timestamptz not null,
  payload_json jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_delivery_events_event_hash_key unique (event_hash),
  constraint whatsapp_delivery_events_delivery_status_check
    check (delivery_status in (
      'DRAFT', 'APPROVED', 'QUEUED', 'PROVIDER_ACCEPTED',
      'SENT_TO_WHATSAPP', 'DELIVERED', 'READ', 'FAILED', 'UNDELIVERED'
    )),
  constraint whatsapp_delivery_events_payload_object_check
    check (jsonb_typeof(payload_json) = 'object')
);

create index if not exists idx_whatsapp_delivery_events_provider_message
  on public.whatsapp_delivery_events (provider_message_id, event_at desc)
  where provider_message_id is not null;

create index if not exists idx_whatsapp_delivery_events_outbox
  on public.whatsapp_delivery_events (outbox_id, event_at desc)
  where outbox_id is not null;

create index if not exists idx_whatsapp_delivery_events_digest
  on public.whatsapp_delivery_events (digest_id, event_at desc)
  where digest_id is not null;

create index if not exists idx_whatsapp_delivery_events_user
  on public.whatsapp_delivery_events (user_id, event_at desc)
  where user_id is not null;

create index if not exists idx_whatsapp_delivery_events_stuck
  on public.whatsapp_delivery_events (delivery_status, event_at)
  where delivery_status in ('PROVIDER_ACCEPTED', 'SENT_TO_WHATSAPP');

alter table public.whatsapp_delivery_events enable row level security;

revoke all on table public.whatsapp_delivery_events from public, anon, authenticated;
revoke all on sequence public.whatsapp_delivery_events_id_seq from public, anon, authenticated;

grant select, insert, update, delete
  on table public.whatsapp_delivery_events
  to service_role;
grant usage, select
  on sequence public.whatsapp_delivery_events_id_seq
  to service_role;

comment on table public.whatsapp_delivery_events is
  'ACK de proveedor idempotentes y ordenables, separados de cada intento de envío.';
comment on column public.mia_outbox.delivery_status is
  'Estado contractual de transporte; status se conserva temporalmente por compatibilidad.';
comment on column public.digests.provider_message_id is
  'Identificador devuelto por el proveedor; su presencia no implica entrega.';

-- ---------------------------------------------------------------------------
-- Memoria atómica canónica (mia_structured_memory queda solo para lectura)
-- ---------------------------------------------------------------------------

alter table public.user_memory
  add column if not exists memory_key text,
  add column if not exists scope_type text,
  add column if not exists scope_value text,
  add column if not exists polarity text not null default 'neutral',
  add column if not exists source text not null default 'legacy',
  add column if not exists strength double precision not null default 0.5,
  add column if not exists confidence double precision not null default 0.5,
  add column if not exists status text not null default 'active',
  add column if not exists expires_at timestamptz,
  add column if not exists correction_of bigint,
  add column if not exists metadata_json jsonb not null default '{}'::jsonb,
  add column if not exists duplicate_count integer not null default 0,
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists decision_version text,
  add column if not exists inbound_id bigint;

update public.user_memory
set strength = greatest(0.0, least(1.0, coalesce(peso_inicial, 0.5))),
    last_seen_at = coalesce(created_at, now()),
    updated_at = coalesce(created_at, now())
where memory_key is null
  and source = 'legacy';

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_memory_scope_check'
      and conrelid = 'public.user_memory'::regclass
  ) then
    alter table public.user_memory
      add constraint user_memory_scope_check
      check (
        (scope_type is null and scope_value is null)
        or (
          scope_type in (
            'alert', 'topic', 'subsector', 'territory', 'frequency',
            'channel', 'activity'
          )
          and nullif(btrim(scope_value), '') is not null
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'user_memory_polarity_check'
      and conrelid = 'public.user_memory'::regclass
  ) then
    alter table public.user_memory
      add constraint user_memory_polarity_check
      check (polarity in ('positive', 'negative', 'neutral')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'user_memory_strength_check'
      and conrelid = 'public.user_memory'::regclass
  ) then
    alter table public.user_memory
      add constraint user_memory_strength_check
      check (strength between 0.0 and 1.0) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'user_memory_confidence_check'
      and conrelid = 'public.user_memory'::regclass
  ) then
    alter table public.user_memory
      add constraint user_memory_confidence_check
      check (confidence between 0.0 and 1.0) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'user_memory_status_check'
      and conrelid = 'public.user_memory'::regclass
  ) then
    alter table public.user_memory
      add constraint user_memory_status_check
      check (status in ('active', 'corrected', 'deleted', 'expired')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'user_memory_metadata_object_check'
      and conrelid = 'public.user_memory'::regclass
  ) then
    alter table public.user_memory
      add constraint user_memory_metadata_object_check
      check (jsonb_typeof(metadata_json) = 'object') not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'user_memory_duplicate_count_check'
      and conrelid = 'public.user_memory'::regclass
  ) then
    alter table public.user_memory
      add constraint user_memory_duplicate_count_check
      check (duplicate_count >= 0) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'user_memory_correction_of_fkey'
      and conrelid = 'public.user_memory'::regclass
  ) then
    alter table public.user_memory
      add constraint user_memory_correction_of_fkey
      foreign key (correction_of) references public.user_memory (id) on delete set null
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'user_memory_inbound_id_fkey'
      and conrelid = 'public.user_memory'::regclass
  ) then
    alter table public.user_memory
      add constraint user_memory_inbound_id_fkey
      foreign key (inbound_id) references public.mia_inbound_messages (id) on delete set null
      not valid;
  end if;
end
$migration$;

alter table public.user_memory validate constraint user_memory_scope_check;
alter table public.user_memory validate constraint user_memory_polarity_check;
alter table public.user_memory validate constraint user_memory_strength_check;
alter table public.user_memory validate constraint user_memory_confidence_check;
alter table public.user_memory validate constraint user_memory_status_check;
alter table public.user_memory validate constraint user_memory_metadata_object_check;
alter table public.user_memory validate constraint user_memory_duplicate_count_check;
alter table public.user_memory validate constraint user_memory_correction_of_fkey;
alter table public.user_memory validate constraint user_memory_inbound_id_fkey;

create unique index if not exists uq_user_memory_key
  on public.user_memory (user_id, memory_key);

create index if not exists idx_user_memory_active_scope
  on public.user_memory (user_id, scope_type, scope_value, polarity)
  where status = 'active';

create index if not exists idx_user_memory_active_expiry
  on public.user_memory (user_id, expires_at)
  where status = 'active';

create index if not exists idx_user_memory_last_seen
  on public.user_memory (user_id, last_seen_at desc);

create index if not exists idx_user_memory_inbound
  on public.user_memory (inbound_id)
  where inbound_id is not null;

create index if not exists idx_user_memory_correction
  on public.user_memory (correction_of)
  where correction_of is not null;

comment on column public.user_memory.memory_key is
  'Clave determinista de idempotencia para una señal atómica.';
comment on column public.user_memory.scope_type is
  'Ámbito limitado de la señal: alerta, tema, subsector, territorio, frecuencia, canal o actividad.';
comment on table public.mia_structured_memory is
  'Memoria estructurada legacy conservada solo para lectura y borrado de privacidad; no recibe escrituras nuevas.';

do $migration$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_interest_profile'
      and column_name = 'score'
      and data_type <> 'double precision'
  ) then
    alter table public.user_interest_profile
      alter column score type double precision using score::double precision;
  end if;
end
$migration$;

alter table public.user_interest_profile
  alter column score set default 0;

comment on column public.user_interest_profile.score is
  'Puntuación fraccionaria; preserva pesos débiles como clics sin redondearlos.';

-- ---------------------------------------------------------------------------
-- Recuperación acotada de fichas con evidencia incompleta
-- ---------------------------------------------------------------------------

alter table public.alert_fact_sheets
  add column if not exists content_hash text,
  add column if not exists recovery_status text,
  add column if not exists recovery_attempts integer not null default 0,
  add column if not exists recovery_next_at timestamptz,
  add column if not exists recovery_last_at timestamptz,
  add column if not exists recovery_strategy text,
  add column if not exists recovery_missing_fields text[] not null default '{}'::text[],
  add column if not exists recovery_error text;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'alert_fact_sheets_recovery_status_check'
      and conrelid = 'public.alert_fact_sheets'::regclass
  ) then
    alter table public.alert_fact_sheets
      add constraint alert_fact_sheets_recovery_status_check
      check (
        recovery_status is null or recovery_status in (
          'PENDING', 'PROCESSING', 'RECOVERED', 'EXHAUSTED', 'FAILED', 'EXPIRED'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'alert_fact_sheets_recovery_attempts_check'
      and conrelid = 'public.alert_fact_sheets'::regclass
  ) then
    alter table public.alert_fact_sheets
      add constraint alert_fact_sheets_recovery_attempts_check
      check (recovery_attempts >= 0) not valid;
  end if;
end
$migration$;

alter table public.alert_fact_sheets
  validate constraint alert_fact_sheets_recovery_status_check;
alter table public.alert_fact_sheets
  validate constraint alert_fact_sheets_recovery_attempts_check;

create index if not exists idx_alert_fact_sheets_content_hash
  on public.alert_fact_sheets (content_hash)
  where content_hash is not null;

create index if not exists idx_alert_fact_sheets_recovery_queue
  on public.alert_fact_sheets (recovery_next_at, recovery_attempts)
  where recovery_status in ('PENDING', 'FAILED');

comment on column public.alert_fact_sheets.recovery_missing_fields is
  'Campos esenciales ausentes que justifican HOLD_FOR_EVIDENCE.';
comment on column public.alert_fact_sheets.recovery_strategy is
  'Última estrategia de relectura aplicada sobre evidencia ya almacenada.';

-- ---------------------------------------------------------------------------
-- Retención: decisiones reproducibles durante al menos 180 días
-- ---------------------------------------------------------------------------

-- Una decisión no puede conservarse si su alerta padre se borra antes: la FK
-- usa ON DELETE CASCADE. Se conserva íntegra la protección previa y se añaden
-- las alertas referenciadas por decisiones dentro de la ventana de replay.
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
     )
     or exists (
       select 1
       from public.digest_candidate_decisions dcd
       where dcd.alerta_id = a.id
         and dcd.created_at >= now() - interval '180 days'
     );
$function$;

revoke all on function private.protected_alert_ids_for_retention() from public;

-- Conserva el nombre y el contrato JSON de la función vigente. Amplía la
-- retención de decisiones e intentos, poda los ACK y reconoce los estados
-- terminales nuevos del outbox. El resto de ventanas permanece sin cambios.
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
  deleted_delivery_events bigint := 0;
  deleted_webhook_events bigint := 0;
  deleted_logs bigint := 0;
  deleted_outbox bigint := 0;
  deleted_verification_codes bigint := 0;
  deleted_cron_runs bigint := 0;
begin
  delete from public.digest_candidate_decisions
  where created_at < now() - interval '180 days';
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
  where created_at < now() - interval '180 days';
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

  delete from public.whatsapp_delivery_events
  where created_at < now() - interval '180 days';
  get diagnostics deleted_delivery_events = row_count;

  delete from public.webhook_events
  where created_at < now() - interval '30 days';
  get diagnostics deleted_webhook_events = row_count;

  delete from public.logs
  where created_at < now() - interval '30 days';
  get diagnostics deleted_logs = row_count;

  delete from public.mia_outbox
  where (
      status in ('sent', 'cancelled')
      or delivery_status in ('DELIVERED', 'READ', 'FAILED', 'UNDELIVERED')
    )
    and coalesce(
      read_at,
      delivered_at,
      failed_at,
      sent_at,
      delivery_updated_at,
      updated_at,
      created_at
    ) < now() - interval '30 days';
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
    'whatsapp_delivery_events', deleted_delivery_events,
    'webhook_events', deleted_webhook_events,
    'logs', deleted_logs,
    'mia_outbox', deleted_outbox,
    'verification_codes', deleted_verification_codes,
    'cron_job_run_details', deleted_cron_runs
  );
end;
$function$;

revoke all on function private.run_operational_retention() from public;

comment on function private.run_operational_retention() is
  'Purga operativa: conserva decisiones, intentos y ACK 180 días para replay; minimiza logs raw y outbox terminal.';
