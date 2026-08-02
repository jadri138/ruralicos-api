const crypto = require('crypto');

const {
  DECISION_STATES,
  TRANSIENT_HOLD_REASON_CODES,
} = require('../alertas/decision/contracts');

const HOLD_RETRY_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  FAILED: 'FAILED',
  RESOLVED: 'RESOLVED',
  EXHAUSTED: 'EXHAUSTED',
  EXPIRED: 'EXPIRED',
});

const TRANSIENT_HOLD_REASON_SET = new Set(TRANSIENT_HOLD_REASON_CODES);

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function holdRetryPolicy(overrides = {}) {
  return {
    maxRetries: boundedInteger(
      overrides.maxRetries ?? process.env.ALERT_DECISION_HOLD_MAX_RETRIES,
      3,
      1,
      6
    ),
    perUser: boundedInteger(
      overrides.perUser ?? process.env.ALERT_DECISION_HOLD_RETRY_PER_USER,
      2,
      1,
      5
    ),
    baseDelayHours: boundedInteger(
      overrides.baseDelayHours ?? process.env.ALERT_DECISION_HOLD_RETRY_BASE_HOURS,
      24,
      1,
      168
    ),
    maxDelayHours: boundedInteger(
      overrides.maxDelayHours ?? process.env.ALERT_DECISION_HOLD_RETRY_MAX_HOURS,
      96,
      1,
      720
    ),
    leaseMs: boundedInteger(
      overrides.leaseMs ?? process.env.ALERT_DECISION_HOLD_RETRY_LEASE_MS,
      15 * 60 * 1000,
      60 * 1000,
      24 * 60 * 60 * 1000
    ),
  };
}

function isoDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function decisionState(decision = {}) {
  return String(decision.decision || decision.decision_state || '').trim().toUpperCase();
}

function decisionReasonCodes(decision = {}) {
  return [...new Set((Array.isArray(decision.reason_codes) ? decision.reason_codes : [])
    .map((code) => String(code || '').trim().toUpperCase())
    .filter(Boolean))];
}

function esHoldTransitorio(decision = {}) {
  return decisionState(decision) === DECISION_STATES.HOLD_FOR_EVIDENCE
    && decisionReasonCodes(decision).some((code) => TRANSIENT_HOLD_REASON_SET.has(code));
}

function siguienteReintentoHold({ now = new Date(), attempts = 0, policy = {} } = {}) {
  const currentPolicy = holdRetryPolicy(policy);
  const safeAttempts = Math.max(0, Number(attempts) || 0);
  const delayHours = Math.min(
    currentPolicy.maxDelayHours,
    currentPolicy.baseDelayHours * (2 ** Math.min(10, safeAttempts))
  );
  return new Date(new Date(now).getTime() + delayHours * 60 * 60 * 1000).toISOString();
}

function construirLifecycleHold(decision = {}, { now = new Date(), policy = {} } = {}) {
  if (!esHoldTransitorio(decision)) return {};
  const attempts = Math.max(0, Number(decision.hold_retry_attempt ?? decision.hold_attempts) || 0);
  const current = isoDate(now);
  return {
    hold_status: HOLD_RETRY_STATUS.PENDING,
    hold_attempts: attempts,
    hold_next_at: siguienteReintentoHold({ now: current, attempts, policy }),
    hold_last_at: current,
    hold_claim_token: null,
    hold_claimed_at: null,
    hold_resolution_json: {
      reason_codes: decisionReasonCodes(decision),
      input_hash: decision.input_hash || decision.judge_audit?.input_hash || null,
      previous_hold_id: decision.hold_retry_source_id || null,
    },
  };
}

function adjuntarRetryAAlerta(alerta = {}, hold = {}, { policy = {} } = {}) {
  const currentPolicy = holdRetryPolicy(policy);
  const retryAttempt = Math.max(0, Number(hold.hold_attempts) || 0) + 1;
  return {
    ...alerta,
    _hold_retry: {
      source_id: hold.id,
      claim_token: hold.hold_claim_token,
      attempt: retryAttempt,
      final: retryAttempt >= currentPolicy.maxRetries,
      prior_input_hash: hold.input_hash || hold.hold_resolution_json?.input_hash || null,
      prior_reason_codes: hold.reason_codes || hold.hold_resolution_json?.reason_codes || [],
    },
  };
}

function retryMetadataFromCandidate(candidate = {}) {
  const retry = candidate.metadata || candidate._hold_retry || {};
  const sourceId = retry.hold_retry_source_id ?? retry.source_id;
  if (!sourceId) return {};
  return {
    hold_retry_source_id: sourceId,
    hold_retry_attempt: Math.max(1, Number(retry.hold_retry_attempt ?? retry.attempt) || 1),
    hold_retry_final: retry.hold_retry_final === true || retry.final === true,
  };
}

const HOLD_SELECT = [
  'id',
  'user_id',
  'alerta_id',
  'organization_id',
  'reason_codes',
  'input_hash',
  'hold_status',
  'hold_attempts',
  'hold_next_at',
  'hold_last_at',
  'hold_claim_token',
  'hold_claimed_at',
  'hold_resolution_json',
].join(', ');

async function reclamarHoldsDecisionUsuario(supabase, {
  userId,
  now = new Date(),
  policy = {},
} = {}) {
  if (!supabase?.from || !userId) throw new Error('hold_retry_context_invalid');
  const currentPolicy = holdRetryPolicy(policy);
  const current = isoDate(now);
  const staleBefore = new Date(new Date(current).getTime() - currentPolicy.leaseMs).toISOString();

  const staleResult = await supabase
    .from('digest_candidate_decisions')
    .update({
      hold_status: HOLD_RETRY_STATUS.FAILED,
      hold_claim_token: null,
      hold_claimed_at: null,
      hold_next_at: current,
      hold_last_at: current,
      hold_resolution_json: { retry_error: 'stale_processing_lease' },
    })
    .eq('user_id', userId)
    .eq('stage', 'personal_relevance_judge')
    .eq('hold_status', HOLD_RETRY_STATUS.PROCESSING)
    .lt('hold_claimed_at', staleBefore)
    .select('id');
  if (staleResult.error) throw staleResult.error;

  const { data: pending, error } = await supabase
    .from('digest_candidate_decisions')
    .select(HOLD_SELECT)
    .eq('user_id', userId)
    .eq('stage', 'personal_relevance_judge')
    .in('hold_status', [HOLD_RETRY_STATUS.PENDING, HOLD_RETRY_STATUS.FAILED])
    .lte('hold_next_at', current)
    .order('hold_next_at', { ascending: true })
    .limit(currentPolicy.perUser);
  if (error) throw error;

  const claimed = [];
  for (const row of pending || []) {
    const claimToken = crypto.randomUUID();
    const { data, error: claimError } = await supabase
      .from('digest_candidate_decisions')
      .update({
        hold_status: HOLD_RETRY_STATUS.PROCESSING,
        hold_claim_token: claimToken,
        hold_claimed_at: current,
        hold_last_at: current,
      })
      .eq('id', row.id)
      .in('hold_status', [HOLD_RETRY_STATUS.PENDING, HOLD_RETRY_STATUS.FAILED])
      .lte('hold_next_at', current)
      .select(HOLD_SELECT)
      .maybeSingle();
    if (claimError) throw claimError;
    if (data?.id) claimed.push(data);
  }

  return {
    claimed,
    stale_requeued: Array.isArray(staleResult.data) ? staleResult.data.length : 0,
    policy: currentPolicy,
  };
}

async function actualizarHoldReclamado(supabase, hold, patch = {}, { now = new Date() } = {}) {
  const current = isoDate(now);
  const { data, error } = await supabase
    .from('digest_candidate_decisions')
    .update({
      ...patch,
      hold_claim_token: null,
      hold_claimed_at: null,
      hold_last_at: current,
      updated_at: current,
    })
    .eq('id', hold.id)
    .eq('hold_status', HOLD_RETRY_STATUS.PROCESSING)
    .eq('hold_claim_token', hold.hold_claim_token)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) {
    const claimError = new Error(`hold_retry_claim_lost:${hold.id}`);
    claimError.code = 'HOLD_RETRY_CLAIM_LOST';
    throw claimError;
  }
  return data;
}

async function finalizarHoldsDecision(supabase, {
  claimed = [],
  decisions = [],
  now = new Date(),
  policy = {},
} = {}) {
  const byAlert = new Map((decisions || []).map((decision) => [String(decision.alerta_id ?? decision.id), decision]));
  const results = [];
  for (const hold of claimed || []) {
    const decision = byAlert.get(String(hold.alerta_id));
    if (!decision) {
      await actualizarHoldReclamado(supabase, hold, {
        hold_status: HOLD_RETRY_STATUS.FAILED,
        hold_next_at: siguienteReintentoHold({ now, attempts: hold.hold_attempts, policy }),
        hold_resolution_json: { retry_error: 'canonical_decision_missing' },
      }, { now });
      results.push({ alerta_id: hold.alerta_id, status: HOLD_RETRY_STATUS.FAILED });
      continue;
    }

    const reasons = decisionReasonCodes(decision);
    const exhausted = reasons.includes('HOLD_RETRY_EXHAUSTED');
    const transferred = esHoldTransitorio(decision);
    const status = exhausted ? HOLD_RETRY_STATUS.EXHAUSTED : HOLD_RETRY_STATUS.RESOLVED;
    await actualizarHoldReclamado(supabase, hold, {
      hold_status: status,
      hold_next_at: null,
      hold_resolution_json: {
        decision_state: decisionState(decision),
        reason_codes: reasons,
        transferred_to_new_hold: transferred,
        retry_attempt: Math.max(0, Number(hold.hold_attempts) || 0) + 1,
      },
    }, { now });
    results.push({ alerta_id: hold.alerta_id, status, decision_state: decisionState(decision) });
  }
  return results;
}

async function cerrarHoldsSinAlerta(supabase, {
  claimed = [],
  loadedAlertIds = [],
  now = new Date(),
} = {}) {
  const loaded = new Set((loadedAlertIds || []).map(String));
  const remaining = [];
  for (const hold of claimed || []) {
    if (loaded.has(String(hold.alerta_id))) {
      remaining.push(hold);
      continue;
    }
    await actualizarHoldReclamado(supabase, hold, {
      hold_status: HOLD_RETRY_STATUS.EXPIRED,
      hold_next_at: null,
      hold_resolution_json: { retry_error: 'alert_missing_or_not_visible' },
    }, { now });
  }
  return remaining;
}

module.exports = {
  HOLD_RETRY_STATUS,
  TRANSIENT_HOLD_REASON_SET,
  holdRetryPolicy,
  decisionState,
  decisionReasonCodes,
  esHoldTransitorio,
  siguienteReintentoHold,
  construirLifecycleHold,
  adjuntarRetryAAlerta,
  retryMetadataFromCandidate,
  reclamarHoldsDecisionUsuario,
  actualizarHoldReclamado,
  finalizarHoldsDecision,
  cerrarHoldsSinAlerta,
};
