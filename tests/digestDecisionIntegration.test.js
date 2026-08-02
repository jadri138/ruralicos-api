const assert = require('assert');
const {
  CONTRACT_VERSIONS,
  DECISION_STATES,
  REASON_CODES,
} = require('../src/modules/alertas/decision');
const {
  crearPresupuestoJuezDiario,
  decidirAlertasDigest,
  consumeIdempotenciaEntrega,
} = require('../src/modules/digest/decisionIntegration');

function verified(value, evidence) {
  return {
    valor: value,
    evidencia: evidence || `Documento oficial: ${value}`,
    source: 'raw_document.texto_raw',
    confidence: 0.95,
    evidence_level: 'official',
    status: 'verified',
  };
}

function alert(id, province) {
  return {
    id,
    titulo: `Ayuda agraria ${id}`,
    resumen: 'Convocatoria para modernizar explotaciones agrarias.',
    url: `https://example.test/oficial/${id}`,
    fuente: 'BOA',
    provincias: [province],
    sectores: ['agricultura'],
    subsectores: ['regadio'],
    tipos_alerta: ['ayuda'],
    similitud: 0.82,
    decision_digest: { score: 94, incluir: true, action: 'include' },
    fact_sheet: {
      schema_version: 'fact_sheet_v3',
      builder_version: 'fact_sheet_builder_v6',
      generated_at: '2026-08-01T08:00:00.000Z',
      alerta_id: id,
      raw_document_id: `doc-${id}`,
      content_hash: `hash-${id}`,
      tipo_documento: verified('ayuda'),
      tema_principal: verified('modernizacion agraria'),
      resumen_neutro: verified('Convocatoria para modernizar explotaciones agrarias.'),
      territorio: [verified(province, `Se aplica en la provincia de ${province}.`)],
      sectores: [verified('agricultura')],
      subsectores: [verified('regadio')],
      accion_requerida: verified('Presentar la solicitud.'),
      accion_codigo: verified('solicitar'),
      application_deadline: verified('2026-09-18'),
      beneficiarios: verified('Titulares de explotaciones agrarias.'),
      url_oficial: verified(`https://example.test/oficial/${id}`),
      truth_score: 96,
      risk_score: 4,
      evidence_coverage: 95,
      status: 'ready_for_digest',
      flags: [],
      reasons: [],
      resumen_estructurado: {},
    },
  };
}

(async () => {
  assert.strictEqual(consumeIdempotenciaEntrega({ delivery_status: 'FAILED' }), false);
  assert.strictEqual(consumeIdempotenciaEntrega({ delivery_status: 'UNDELIVERED' }), false);
  assert.strictEqual(consumeIdempotenciaEntrega({ delivery_status: 'APPROVED' }), false);
  assert.strictEqual(consumeIdempotenciaEntrega({ delivery_status: 'QUEUED' }), true);
  assert.strictEqual(consumeIdempotenciaEntrega({ delivery_status: 'PROVIDER_ACCEPTED' }), true);
  assert.strictEqual(consumeIdempotenciaEntrega({ enviado: true }), true);

  let calls = 0;
  const caller = async (request) => {
    calls += 1;
    const evidence = request.input.untrusted_alert_data.evidence;
    const fields = ['title', 'summary', 'territory', 'beneficiaries', 'action', 'deadline', 'official_url']
      .filter((field) => evidence[field]);
    return {
      contract_version: CONTRACT_VERSIONS.decision,
      policy_version: CONTRACT_VERSIONS.policy,
      decision: DECISION_STATES.ADD_TO_DIGEST,
      applicability: 0.94,
      usefulness: 0.9,
      actionability: 0.85,
      urgency: 0.5,
      novelty: 0.9,
      confidence: 0.9,
      reason_codes: [REASON_CODES.ACTIVITY_MATCH],
      evidence_refs: fields.map((field) => evidence[field].ref),
      missing_information: [],
      user_reason: 'Puede ayudarte a modernizar tu explotación en Teruel.',
      message_facts: fields.map((field) => ({ field, evidence_ref: evidence[field].ref })),
    };
  };

  const result = await decidirAlertasDigest({
    supabase: null,
    alertas: [alert(1, 'Teruel'), alert(2, 'Valencia')],
    user: {
      id: 77,
      subscription: 'agricultor',
      preferences: {
        provincias: ['Teruel'],
        sectores: ['agricultura'],
        subsectores: ['regadio'],
        frecuencia: 'daily',
      },
    },
    perfilOperativo: { atomic_memories: [] },
    context: {
      now: '2026-08-01T10:00:00.000Z',
      recentCommunications: [],
      recentDeliveries: [],
      usedIdempotencyKeys: [],
    },
    caller,
    policy: { topK: 10, maxItems: 3 },
  });

  assert.strictEqual(calls, 1, 'los bloqueos duros no llegan al juez LLM');
  assert.deepStrictEqual(result.alertas.map((item) => item.id), [1]);
  assert.strictEqual(result.alertas[0].personal_decision.state, DECISION_STATES.ADD_TO_DIGEST);
  assert.strictEqual(result.alertas[0].personal_decision.message_projection.allowed, true);
  const blocked = result.audit_decisions.find((row) => row.id === 2);
  assert.strictEqual(blocked.decision, DECISION_STATES.BLOCKED);
  assert(blocked.reason_codes.includes(REASON_CODES.TERRITORY_MISMATCH));
  assert.strictEqual(result.ranking.funnel.generated, 2);

  const explorationResult = await decidirAlertasDigest({
    supabase: null,
    alertas: [alert(3, 'Teruel')],
    exploracion: { id: 3 },
    user: {
      id: 78,
      subscription: 'agricultor',
      preferences: {
        provincias: ['Teruel'],
        sectores: ['agricultura'],
        subsectores: ['regadio'],
        frecuencia: 'daily',
      },
    },
    perfilOperativo: { atomic_memories: [] },
    context: {
      now: '2026-08-01T10:00:00.000Z',
      recentCommunications: [],
      recentDeliveries: [],
      usedIdempotencyKeys: [],
    },
    caller,
    policy: { topK: 10, maxItems: 3 },
  });
  assert.strictEqual(explorationResult.ranking.candidates[0].is_exploration, true);
  assert(explorationResult.ranking.candidates[0].origins.some((origin) => origin.generator === 'exact'));
  assert(explorationResult.ranking.candidates[0].origins.some((origin) => origin.generator === 'exploration'));

  const budgetCalls = [];
  const budgetQuery = {
    select(columns, options) { budgetCalls.push({ op: 'select', columns, options }); return budgetQuery; },
    in(column, value) { budgetCalls.push({ op: 'in', column, value }); return budgetQuery; },
    eq(column, value) { budgetCalls.push({ op: 'eq', column, value }); return budgetQuery; },
    gte(column, value) { budgetCalls.push({ op: 'gte', column, value }); return budgetQuery; },
    async lt(column, value) {
      budgetCalls.push({ op: 'lt', column, value });
      const table = [...budgetCalls].reverse().find((call) => call.op === 'from')?.table;
      return table === 'ia_runs'
        ? { count: 4, error: null }
        : { data: [{ llm_calls: 3 }], error: null };
    },
  };
  let reservationCalls = 0;
  const dailyBudget = await crearPresupuestoJuezDiario({
    supabase: {
      from(table) { budgetCalls.push({ op: 'from', table }); return budgetQuery; },
      async rpc(name, params) {
        reservationCalls += 1;
        assert.strictEqual(name, 'reserve_alert_decision_llm_call');
        assert.deepStrictEqual(params, {
          p_fecha: '2026-08-01',
          p_limit: 5,
          p_observed_calls: 4,
        });
        return {
          data: { allowed: true, used_calls: 5, remaining_calls: 0 },
          error: null,
        };
      },
    },
    fecha: '2026-08-01',
    maxCalls: 5,
  });
  assert.strictEqual(dailyBudget.snapshot().used_calls, 4);
  assert.strictEqual(dailyBudget.snapshot().remaining_calls, 1);
  assert.strictEqual(budgetCalls.filter((call) => call.op === 'from').length, 2);
  assert.strictEqual(budgetCalls.find((call) => call.op === 'select').options.head, true);
  assert.strictEqual(await dailyBudget.tryConsumeCall(), true);
  assert.strictEqual(reservationCalls, 1);
  assert.strictEqual(dailyBudget.snapshot().used_calls, 5);
  assert.strictEqual(dailyBudget.snapshot().remaining_calls, 0);

  const unavailableBudget = await crearPresupuestoJuezDiario({
    supabase: null,
    fecha: '2026-08-01',
    maxCalls: 5,
  });
  assert.strictEqual(unavailableBudget.snapshot().unavailable, true);
  assert.strictEqual(unavailableBudget.tryConsumeCall(), false);
  console.log('OK: el digest usa una autoridad final, bloquea territorio antes del LLM y proyecta hechos.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
