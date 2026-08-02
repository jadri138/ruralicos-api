const assert = require('assert');

const {
  construirDigestCandidateDecisionRow,
  cargarCacheDecisionesJuez,
  registrarDigestCandidateDecisions,
  vincularDigestCandidateDecisions,
} = require('../src/modules/mia/digestCandidateDecisions');

async function main() {
  const row = construirDigestCandidateDecisionRow({
    userId: 12,
    alertaId: 34,
    fecha: '2026-06-25',
    kind: 'daily',
    stage: 'selection',
    digestAttemptId: 56,
    decision: {
      action: 'review_only',
      score: 71,
      riesgo: 'medio',
      motivo: 'evidencia_incompleta',
      match_trace: {
        territory_match: 'zaragoza',
        sector_match: null,
        subsector_match: null,
        type_match: null,
        score: 71,
        decision: 'review_only',
        reason: 'evidencia_incompleta',
      },
    },
  });

  assert.strictEqual(row.user_id, 12);
  assert.strictEqual(row.alerta_id, 34);
  assert.strictEqual(row.action, 'review_only');
  assert.strictEqual(row.digest_attempt_id, 56);
  assert.strictEqual(row.score, 71);
  assert.strictEqual(row.decision_json.match_trace.decision, 'review_only');

  const excludedRow = construirDigestCandidateDecisionRow({
    userId: 12,
    alertaId: 35,
    fecha: '2026-06-25',
    stage: 'selection',
    decision: {
      action: 'exclude',
      motivo: 'animal_health_requires_livestock_profile',
      match_trace: {
        decision: 'exclude',
        reason: 'animal_health_requires_livestock_profile',
        territory_match: 'national',
        sector_match: null,
        subsector_match: null,
        type_match: 'sanidad_animal',
        score: 0,
      },
    },
  });
  assert.strictEqual(excludedRow.action, 'exclude');
  assert.strictEqual(excludedRow.decision_json.match_trace.reason, 'animal_health_requires_livestock_profile');

  const canonicalRow = construirDigestCandidateDecisionRow({
    userId: 12,
    alertaId: 36,
    fecha: '2026-06-25',
    stage: 'personal_relevance_judge',
    decision: {
      decision: 'HOLD_FOR_EVIDENCE',
      contract_version: 'alert_decision_v1',
      policy_version: 'decision_policy_v1',
      judge_version: 'personal_relevance_judge_v1',
      prompt_version: 'personal_relevance_prompt_v1',
      input_hash: 'sha256:test',
      llm_model: 'judge-test',
      llm_usage: { total_tokens: 42 },
      llm_cost: { amount: 0.002, currency: 'EUR', estimated: true },
      llm_calls: 1,
      cache_hit: false,
      reason_codes: ['EVIDENCE_REQUIRED'],
      decided_at: '2026-06-25T08:00:00.000Z',
    },
  });
  assert.strictEqual(canonicalRow.action, 'hold');
  assert.strictEqual(canonicalRow.decision_state, 'HOLD_FOR_EVIDENCE');
  assert.deepStrictEqual(canonicalRow.reason_codes, ['EVIDENCE_REQUIRED']);
  assert.strictEqual(canonicalRow.input_hash, 'sha256:test');
  assert.strictEqual(canonicalRow.llm_model, 'judge-test');
  assert.deepStrictEqual(canonicalRow.llm_usage, { total_tokens: 42 });
  assert.deepStrictEqual(canonicalRow.llm_cost, { amount: 0.002, currency: 'EUR', estimated: true });
  assert.strictEqual(canonicalRow.llm_calls, 1);
  assert.strictEqual(canonicalRow.cache_hit, false);
  assert.strictEqual(canonicalRow.hold_status, null);

  const retryableHoldRow = construirDigestCandidateDecisionRow({
    userId: 12,
    alertaId: 37,
    fecha: '2026-06-25',
    stage: 'personal_relevance_judge',
    decision: {
      decision: 'HOLD_FOR_EVIDENCE',
      reason_codes: ['LLM_UNAVAILABLE'],
      input_hash: 'sha256:retryable',
      hold_retry_attempt: 1,
    },
  });
  assert.strictEqual(retryableHoldRow.hold_status, 'PENDING');
  assert.strictEqual(retryableHoldRow.hold_attempts, 1);
  assert(retryableHoldRow.hold_next_at);

  const cacheCalls = [];
  const cacheQuery = {
    select(columns) { cacheCalls.push({ op: 'select', columns }); return cacheQuery; },
    eq(column, value) { cacheCalls.push({ op: 'eq', column, value }); return cacheQuery; },
    in(column, value) { cacheCalls.push({ op: 'in', column, value }); return cacheQuery; },
    order(column, options) { cacheCalls.push({ op: 'order', column, options }); return cacheQuery; },
    async limit(value) {
      cacheCalls.push({ op: 'limit', value });
      return {
        error: null,
        data: [{
          input_hash: 'hash-a',
          contract_version: 'alert_user_decision_v1',
          policy_version: 'alert_decision_policy_v1',
          judge_version: 'personal_relevance_judge_v2',
          prompt_version: 'personal_relevance_prompt_v1',
          llm_model: 'judge-test',
          decided_at: '2026-08-01T08:00:00.000Z',
          decision_json: {
            judge: { contract_version: 'alert_user_decision_v1' },
            judge_audit: {
              cache_hit: false,
              fallback: null,
              second_opinion: false,
              llm_calls: 1,
            },
          },
        }],
      };
    },
  };
  const cache = await cargarCacheDecisionesJuez({
    from(table) {
      cacheCalls.push({ op: 'from', table });
      return cacheQuery;
    },
  }, {
    inputHashes: ['hash-a', 'hash-b', 'hash-a'],
    compatibility: {
      contract_version: 'alert_user_decision_v1',
      policy_version: 'alert_decision_policy_v1',
      judge_version: 'personal_relevance_judge_v2',
      prompt_version: 'personal_relevance_prompt_v1',
      model: 'judge-test',
    },
  });
  assert.strictEqual(cache.size, 1);
  assert.strictEqual(cache.get('hash-a').model, 'judge-test');
  assert.deepStrictEqual(
    cacheCalls.find((call) => call.op === 'in').value,
    ['hash-a', 'hash-b']
  );
  assert.strictEqual(cacheCalls.filter((call) => call.op === 'from').length, 1);

  const calls = [];
  const supabase = {
    from(table) {
      return {
        async upsert(rows, options) {
          calls.push({ op: 'upsert', table, rows, options });
          return { error: null };
        },
        update(patch) {
          calls.push({ op: 'update', table, patch });
          const chain = {
            eq(column, value) {
              calls.push({ op: 'eq', table, column, value });
              return chain;
            },
            then(resolve) {
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
  };

  const stored = await registrarDigestCandidateDecisions(supabase, {
    userId: 12,
    fecha: '2026-06-25',
    stage: 'user_filter',
    decisions: [
      { id: 34, action: 'include', motivo: 'perfil_coincide' },
      { id: 35, action: 'exclude', motivo: 'provincia_no_coincide' },
    ],
  });
  assert.strictEqual(stored.ok, true);
  assert.strictEqual(stored.stored, 2);
  assert.strictEqual(calls[0].options.onConflict, 'user_id,fecha,kind,alerta_id,stage');

  const linked = await vincularDigestCandidateDecisions(supabase, {
    userId: 12,
    fecha: '2026-06-25',
    kind: 'daily',
    digestId: 78,
    digestAttemptId: 56,
  });
  assert.strictEqual(linked.ok, true);
  assert(calls.some((call) => call.op === 'update' && call.patch.digest_id === 78));

  console.log('OK: auditoria idempotente de todos los candidatos del digest');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
