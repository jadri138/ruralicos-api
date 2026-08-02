const assert = require('assert');

const {
  HOLD_RETRY_STATUS,
  adjuntarRetryAAlerta,
  cerrarHoldsSinAlerta,
  construirLifecycleHold,
  esHoldTransitorio,
  finalizarHoldsDecision,
  reclamarHoldsDecisionUsuario,
  siguienteReintentoHold,
} = require('../src/modules/digest/decisionHoldRetry');
const { aplicarSalidaHoldAgotado } = require('../src/modules/alertas/decision/judge');
const { cargarAlertasListasDigest } = require('../src/modules/digest/digest.service');
const { crearSupabaseMemoria } = require('./helpers/inMemorySupabase');

async function main() {
  const now = '2026-08-01T08:00:00.000Z';
  const transientDecision = {
    decision: 'HOLD_FOR_EVIDENCE',
    reason_codes: ['LLM_UNAVAILABLE'],
    input_hash: 'sha256:hold-a',
  };
  assert.strictEqual(esHoldTransitorio(transientDecision), true);
  assert.strictEqual(esHoldTransitorio({
    decision: 'HOLD_FOR_EVIDENCE',
    reason_codes: ['ACTION_EVIDENCE_MISSING'],
  }), false);

  const lifecycle = construirLifecycleHold(transientDecision, {
    now,
    policy: { baseDelayHours: 24, maxDelayHours: 96 },
  });
  assert.strictEqual(lifecycle.hold_status, HOLD_RETRY_STATUS.PENDING);
  assert.strictEqual(lifecycle.hold_attempts, 0);
  assert.strictEqual(lifecycle.hold_next_at, '2026-08-02T08:00:00.000Z');
  assert.deepStrictEqual(
    construirLifecycleHold({
      decision: 'HOLD_FOR_EVIDENCE',
      reason_codes: ['ACTION_EVIDENCE_MISSING'],
    }, { now }),
    {}
  );
  assert.strictEqual(siguienteReintentoHold({
    now,
    attempts: 2,
    policy: { baseDelayHours: 24, maxDelayHours: 72 },
  }), '2026-08-04T08:00:00.000Z');

  const supabase = crearSupabaseMemoria({
    digest_candidate_decisions: [{
      id: 10,
      user_id: 1,
      alerta_id: 50,
      organization_id: null,
      stage: 'personal_relevance_judge',
      reason_codes: ['LLM_UNAVAILABLE'],
      input_hash: 'sha256:hold-a',
      hold_status: HOLD_RETRY_STATUS.PENDING,
      hold_attempts: 0,
      hold_next_at: '2026-08-01T07:00:00.000Z',
      hold_last_at: '2026-07-31T07:00:00.000Z',
      hold_claim_token: null,
      hold_claimed_at: null,
      hold_resolution_json: {},
    }],
  });
  const claimedResult = await reclamarHoldsDecisionUsuario(supabase, {
    userId: 1,
    now,
    policy: { perUser: 2, maxRetries: 3 },
  });
  assert.strictEqual(claimedResult.claimed.length, 1);
  const claimed = claimedResult.claimed[0];
  assert.strictEqual(claimed.hold_status, HOLD_RETRY_STATUS.PROCESSING);
  assert(claimed.hold_claim_token);

  const enriched = adjuntarRetryAAlerta({ id: 50, titulo: 'Ayuda agraria' }, claimed, {
    policy: { maxRetries: 3 },
  });
  assert.strictEqual(enriched._hold_retry.attempt, 1);
  assert.strictEqual(enriched._hold_retry.final, false);
  assert.strictEqual(enriched._hold_retry.source_id, 10);

  const finalized = await finalizarHoldsDecision(supabase, {
    claimed: [claimed],
    decisions: [{ id: 50, decision: 'ADD_TO_DIGEST', reason_codes: ['APPROVED_DIGEST'] }],
    now,
  });
  assert.strictEqual(finalized[0].status, HOLD_RETRY_STATUS.RESOLVED);
  assert.strictEqual(supabase.tables.digest_candidate_decisions[0].hold_status, HOLD_RETRY_STATUS.RESOLVED);
  assert.strictEqual(supabase.tables.digest_candidate_decisions[0].hold_claim_token, null);

  const pendingAlertStore = crearSupabaseMemoria({
    alertas: [{ id: 50, estado_ia: 'pendiente', fecha: '2026-07-31', titulo: 'Ayuda agraria' }],
  });
  const pendingAlert = await cargarAlertasListasDigest(pendingAlertStore, {
    ids: [50],
    requireReady: false,
  });
  assert.ifError(pendingAlert.error);
  assert.strictEqual(pendingAlert.data.length, 1);
  assert.strictEqual(pendingAlert.data[0].estado_ia, 'pendiente');

  const exhaustedCandidate = {
    metadata: {
      hold_retry_source_id: 11,
      hold_retry_attempt: 3,
      hold_retry_final: true,
    },
  };
  const exhausted = aplicarSalidaHoldAgotado({
    candidate: exhaustedCandidate,
    judged: {
      decision: {
        decision: 'HOLD_FOR_EVIDENCE',
        applicability: 0,
        usefulness: 0,
        actionability: 0,
        urgency: 0,
        novelty: 0,
        confidence: 0,
        reason_codes: ['LLM_INVALID_OUTPUT'],
        evidence_refs: [],
        missing_information: ['salida valida'],
      },
      audit: { fallback: 'invalid_output' },
    },
  });
  assert.strictEqual(exhausted.decision.decision, 'DROP');
  assert(exhausted.decision.reason_codes.includes('HOLD_RETRY_EXHAUSTED'));
  assert.strictEqual(exhausted.audit.hold_retry.exhausted, true);

  const evidenceHold = {
    decision: {
      decision: 'HOLD_FOR_EVIDENCE',
      reason_codes: ['ACTION_EVIDENCE_MISSING'],
    },
    audit: {},
  };
  assert.strictEqual(
    aplicarSalidaHoldAgotado({ candidate: exhaustedCandidate, judged: evidenceHold }),
    evidenceHold
  );

  const staleSupabase = crearSupabaseMemoria({
    digest_candidate_decisions: [{
      id: 20,
      user_id: 2,
      alerta_id: 60,
      stage: 'personal_relevance_judge',
      hold_status: HOLD_RETRY_STATUS.PROCESSING,
      hold_attempts: 1,
      hold_next_at: '2026-07-31T08:00:00.000Z',
      hold_claim_token: 'dead-worker',
      hold_claimed_at: '2026-08-01T06:00:00.000Z',
      hold_resolution_json: {},
    }, {
      id: 21,
      user_id: 2,
      alerta_id: 61,
      stage: 'personal_relevance_judge',
      hold_status: HOLD_RETRY_STATUS.PENDING,
      hold_attempts: 0,
      hold_next_at: '2026-08-01T07:00:00.000Z',
      hold_claim_token: null,
      hold_claimed_at: null,
      hold_resolution_json: {},
    }],
  });
  const reclaimed = await reclamarHoldsDecisionUsuario(staleSupabase, {
    userId: 2,
    now,
    policy: { perUser: 2, leaseMs: 15 * 60 * 1000 },
  });
  assert.strictEqual(reclaimed.stale_requeued, 1);
  assert.strictEqual(reclaimed.claimed.length, 2);

  const remaining = await cerrarHoldsSinAlerta(staleSupabase, {
    claimed: reclaimed.claimed,
    loadedAlertIds: [61],
    now,
  });
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].alerta_id, 61);
  assert.strictEqual(
    staleSupabase.tables.digest_candidate_decisions.find((row) => row.id === 20).hold_status,
    HOLD_RETRY_STATUS.EXPIRED
  );

  console.log('OK: HOLD tecnico tiene reintento acotado, lease y salida automatica');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
