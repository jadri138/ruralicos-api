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
    ...construirPatchHold(HOLD_RETRY_STATUS.PENDING, {
      nextAt: siguienteReintentoHold({ now: current, attempts, policy }),
      resolution: {
        reason_codes: decisionReasonCodes(decision),
        input_hash: decision.input_hash || decision.judge_audit?.input_hash || null,
        previous_hold_id: decision.hold_retry_source_id || null,
      },
    }),
    hold_attempts: attempts,
    hold_last_at: current,
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
      ...construirPatchHold(HOLD_RETRY_STATUS.FAILED, {
        nextAt: current,
        resolution: { retry_error: 'stale_processing_lease' },
      }),
      hold_last_at: current,
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
        ...construirPatchHold(HOLD_RETRY_STATUS.PROCESSING, {
          claimToken,
          claimedAt: current,
          resolution: row.hold_resolution_json || {},
        }),
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

// Única puerta de escritura del ciclo de vida de un HOLD. Devuelve siempre una
// combinación que cumple `digest_candidate_decisions_hold_lifecycle_check`:
// PENDING/FAILED exigen próxima cita, PROCESSING exige claim, y los estados
// finales exigen que no quede próxima cita pendiente.
function construirPatchHold(status, { nextAt = null, claimToken = null, claimedAt = null, resolution = {} } = {}) {
  const estado = String(status || '').trim().toUpperCase();
  if (!Object.values(HOLD_RETRY_STATUS).includes(estado)) {
    throw new TypeError(`hold_status_invalido:${status}`);
  }
  const resolucion = resolution && typeof resolution === 'object' && !Array.isArray(resolution)
    ? resolution
    : {};

  if (estado === HOLD_RETRY_STATUS.PROCESSING) {
    if (!claimToken || !claimedAt) throw new TypeError('hold_processing_requiere_claim');
    return {
      hold_status: estado,
      hold_next_at: null,
      hold_claim_token: claimToken,
      hold_claimed_at: claimedAt,
      hold_resolution_json: resolucion,
    };
  }

  if ([HOLD_RETRY_STATUS.PENDING, HOLD_RETRY_STATUS.FAILED].includes(estado)) {
    if (!nextAt) throw new TypeError('hold_pendiente_requiere_next_at');
    return {
      hold_status: estado,
      hold_next_at: nextAt,
      hold_claim_token: null,
      hold_claimed_at: null,
      hold_resolution_json: resolucion,
    };
  }

  return {
    hold_status: estado,
    hold_next_at: null,
    hold_claim_token: null,
    hold_claimed_at: null,
    hold_resolution_json: resolucion,
  };
}

// Un claim perdido no es un fallo del sistema: significa que otra pasada ya
// cerró ese HOLD. Antes lanzaba y, sin try/catch alrededor, dejaba sin digest a
// todo el lote. Ahora se informa y el reintento del mismo día es idempotente.
async function actualizarHoldReclamado(supabase, hold, patch = {}, { now = new Date() } = {}) {
  const current = isoDate(now);
  const { data, error } = await supabase
    .from('digest_candidate_decisions')
    .update({
      ...patch,
      hold_last_at: current,
      updated_at: current,
    })
    .eq('id', hold.id)
    .eq('hold_status', HOLD_RETRY_STATUS.PROCESSING)
    .eq('hold_claim_token', hold.hold_claim_token)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) return { id: hold.id, claim_lost: true };
  return { ...data, claim_lost: false };
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
      const fallo = await actualizarHoldReclamado(supabase, hold, construirPatchHold(
        HOLD_RETRY_STATUS.FAILED,
        {
          nextAt: siguienteReintentoHold({ now, attempts: hold.hold_attempts, policy }),
          resolution: { retry_error: 'canonical_decision_missing' },
        }
      ), { now });
      results.push({
        alerta_id: hold.alerta_id,
        status: HOLD_RETRY_STATUS.FAILED,
        claim_lost: fallo.claim_lost === true,
      });
      continue;
    }

    const reasons = decisionReasonCodes(decision);
    const exhausted = reasons.includes('HOLD_RETRY_EXHAUSTED');
    const transferred = esHoldTransitorio(decision);
    const status = exhausted ? HOLD_RETRY_STATUS.EXHAUSTED : HOLD_RETRY_STATUS.RESOLVED;
    const cierre = await actualizarHoldReclamado(supabase, hold, construirPatchHold(status, {
      resolution: {
        decision_state: decisionState(decision),
        reason_codes: reasons,
        transferred_to_new_hold: transferred,
        retry_attempt: Math.max(0, Number(hold.hold_attempts) || 0) + 1,
      },
    }), { now });
    results.push({
      alerta_id: hold.alerta_id,
      status,
      decision_state: decisionState(decision),
      claim_lost: cierre.claim_lost === true,
    });
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
    await actualizarHoldReclamado(supabase, hold, construirPatchHold(HOLD_RETRY_STATUS.EXPIRED, {
      resolution: { retry_error: 'alert_missing_or_not_visible' },
    }), { now });
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
  construirPatchHold,
  construirLifecycleHold,
  adjuntarRetryAAlerta,
  retryMetadataFromCandidate,
  reclamarHoldsDecisionUsuario,
  actualizarHoldReclamado,
  finalizarHoldsDecision,
  cerrarHoldsSinAlerta,
};
