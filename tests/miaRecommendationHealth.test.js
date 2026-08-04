const assert = require('assert');
const {
  analizarAnomaliasVolumen,
  calcularRachaSilencioGlobal,
  calcularRachaSilencioPorUsuario,
  calcularSaludRecomendaciones,
  construirVolumenDiario,
  contarRepeticionesPorUsuario,
  resumirCicloHold,
  resumirEmbudoDigest,
  resumirUsoJuez,
} = require('../src/modules/mia/recommendationHealth');

const digests = [
  { id: 1, user_id: 10, fecha: '2026-07-20', alerta_ids: [100, 101], enviado: true, delivery_status: 'DELIVERED' },
  { id: 2, user_id: 10, fecha: '2026-07-21', alerta_ids: [101, 102], enviado: true, delivery_status: 'READ' },
  { id: 3, user_id: 11, fecha: '2026-07-21', alerta_ids: [101], enviado: true, delivery_status: 'DELIVERED' },
];

assert.strictEqual(
  contarRepeticionesPorUsuario(digests),
  1,
  'solo cuenta repeticiones para la misma persona'
);

const report = calcularSaludRecomendaciones({
  digests,
  clicks: [{ digest_id: 1 }, { digest_id: 1 }],
  feedback: [
    { digest_id: 1, valor: -1, feedback_category: 'wrong_location' },
    { digest_id: 2, valor: 1, feedback_category: 'useful' },
  ],
  attempts: [
    { status: 'sent' },
    { status: 'sent' },
    { status: 'sent' },
  ],
  decisions: [{
    stage: 'selection',
    action: 'include',
    decision_json: {
      match_trace: {
        version: 'matching_trace_v1',
        reason: 'coincidencia_sectorial_verificada',
      },
    },
  }],
});

assert.strictEqual(report.metrics.click_rate_pct, 33.3);
assert.strictEqual(report.metrics.delivery_rate_pct, 100);
assert.strictEqual(report.metrics.provider_acceptance_rate_pct, 100);
assert.strictEqual(report.metrics.trace_coverage_pct, 100);
assert.strictEqual(report.metrics.repeated_alerts_same_user, 1);
assert(report.flags.some((flag) => flag.code === 'wrong_location_feedback'));
assert(report.flags.some((flag) => flag.code === 'repeated_alerts_same_user'));
assert.strictEqual(report.status, 'critical');

const judgeUsage = resumirUsoJuez([
  {
    user_id: 10,
    digest_id: 1,
    fecha: '2026-07-21',
    action: 'include',
    llm_calls: 1,
    cache_hit: false,
    llm_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    llm_cost: { amount: 0.01, currency: 'EUR' },
    decision_json: {
      judge_audit: {
        daily_budget: { max_calls: null },
        calls: [{ attempts: 2 }],
      },
    },
  },
  {
    user_id: 10,
    digest_id: 1,
    fecha: '2026-07-21',
    action: 'exclude',
    llm_calls: 0,
    cache_hit: true,
    llm_usage: null,
    llm_cost: null,
    fallback_reason: 'daily_budget_exhausted',
    decision_json: { judge_audit: { daily_budget: { unavailable: true } } },
  },
]);
assert.strictEqual(judgeUsage.judge_llm_calls, 1);
assert.strictEqual(judgeUsage.judge_provider_attempts, 2);
assert.strictEqual(judgeUsage.judge_provider_retries, 1);
assert.strictEqual(judgeUsage.judge_cache_hits, 1);
assert.strictEqual(judgeUsage.judge_total_tokens, 120);
assert.strictEqual(judgeUsage.judge_cost_by_currency.EUR, 0.01);
assert.strictEqual(judgeUsage.judge_cost_per_user.EUR, 0.01);
assert.strictEqual(judgeUsage.judge_cost_per_approved_digest.EUR, 0.01);
assert.strictEqual(judgeUsage.judge_fallbacks.daily_budget_exhausted, 1);
assert.strictEqual(judgeUsage.judge_budget_unavailable, 1);
assert.strictEqual(judgeUsage.judge_budget_unlimited, 1);

const holdHealth = resumirCicloHold([
  { decision_state: 'HOLD_FOR_EVIDENCE', hold_status: 'PENDING', hold_attempts: 0 },
  { decision_state: 'HOLD_FOR_EVIDENCE', hold_status: 'PROCESSING', hold_attempts: 1 },
  { decision_state: 'HOLD_FOR_EVIDENCE', hold_status: 'FAILED', hold_attempts: 1 },
  { decision_state: 'HOLD_FOR_EVIDENCE', hold_status: 'RESOLVED', hold_attempts: 1 },
  {
    decision_state: 'HOLD_FOR_EVIDENCE',
    hold_status: 'RESOLVED',
    hold_attempts: 1,
    hold_resolution_json: { transferred_to_new_hold: true },
  },
  { decision_state: 'HOLD_FOR_EVIDENCE', hold_status: 'EXHAUSTED', hold_attempts: 3 },
  { decision_state: 'HOLD_FOR_EVIDENCE', hold_status: 'EXPIRED', hold_attempts: 1 },
  { decision_state: 'ADD_TO_DIGEST', hold_status: null, hold_attempts: 0 },
]);
assert.strictEqual(holdHealth.judge_hold_evaluations, 7);
assert.strictEqual(holdHealth.judge_hold_rate_pct, 87.5);
assert.deepStrictEqual(holdHealth.hold_status_counts, {
  PENDING: 1,
  PROCESSING: 1,
  FAILED: 1,
  RESOLVED: 2,
  EXHAUSTED: 1,
  EXPIRED: 1,
});
assert.strictEqual(holdHealth.hold_transferred_to_retry, 1);
assert.strictEqual(holdHealth.hold_retry_attempts, 6);
assert.strictEqual(holdHealth.hold_successfully_resolved, 1);
assert.strictEqual(holdHealth.hold_terminal_outcomes, 3);
assert.strictEqual(holdHealth.hold_resolution_rate_pct, 33.3);

const holdWarnings = calcularSaludRecomendaciones({
  judgeDecisions: [
    { decision_state: 'HOLD_FOR_EVIDENCE', hold_status: 'EXHAUSTED' },
    { decision_state: 'HOLD_FOR_EVIDENCE', hold_status: 'EXPIRED' },
  ],
});
assert(holdWarnings.flags.some((flag) => flag.code === 'hold_retries_exhausted'));
assert(holdWarnings.flags.some((flag) => flag.code === 'hold_cases_expired'));

const silencioGlobal = calcularSaludRecomendaciones({
  attempts: [
    { fecha: '2026-07-27', status: 'no_send' },
    { fecha: '2026-07-28', status: 'failed' },
    { fecha: '2026-07-29', status: 'no_send' },
  ],
});
assert.strictEqual(silencioGlobal.metrics.global_silence_streak_days, 3);
assert(silencioGlobal.flags.some((flag) => flag.code === 'global_silence_multiple_days'));

for (const statusConResultado of ['generated', 'rescued', 'sent']) {
  assert.strictEqual(
    calcularRachaSilencioGlobal([
      { fecha: '2026-07-27', status: 'no_send' },
      { fecha: '2026-07-28', status: statusConResultado },
      { fecha: '2026-07-28', status: 'no_send' },
      { fecha: '2026-07-29', status: 'no_send' },
    ]),
    1,
    `${statusConResultado} rompe el silencio global aunque otros usuarios no reciban digest`
  );
}

const silencioDosDias = calcularSaludRecomendaciones({
  attempts: [
    { fecha: '2026-07-28', status: 'no_send' },
    { fecha: '2026-07-29', status: 'no_send' },
  ],
});
assert.strictEqual(silencioDosDias.metrics.global_silence_streak_days, 2);
assert(!silencioDosDias.flags.some((flag) => flag.code === 'global_silence_multiple_days'));

assert.strictEqual(
  calcularRachaSilencioGlobal([
    { fecha: '2026-07-27', status: 'no_send' },
    { fecha: '2026-07-28', status: 'skipped_existing' },
    { fecha: '2026-07-29', status: 'no_send' },
  ], [
    { fecha: '2026-07-28' },
  ]),
  1,
  'un digest existente evita el falso silencio de skipped_existing'
);

assert.strictEqual(
  calcularRachaSilencioGlobal([
    { fecha: '2026-07-27', status: 'no_send' },
    { fecha: '2026-07-28', status: 'no_send' },
    { fecha: '2026-07-30', status: 'no_send' },
  ]),
  1,
  'un dia calendario no evaluado rompe la racha'
);

// El silencio global puede ser cero y aun asi haber personas olvidadas.
const attemptsSilencioUsuario = [
  { user_id: 10, fecha: '2026-07-27', status: 'no_send' },
  { user_id: 10, fecha: '2026-07-28', status: 'no_send' },
  { user_id: 10, fecha: '2026-07-29', status: 'no_send' },
  { user_id: 11, fecha: '2026-07-27', status: 'no_send' },
  { user_id: 11, fecha: '2026-07-28', status: 'sent' },
  { user_id: 11, fecha: '2026-07-29', status: 'no_send' },
  { user_id: 12, fecha: '2026-07-29', status: 'sent' },
];
assert.deepStrictEqual(
  calcularRachaSilencioPorUsuario(attemptsSilencioUsuario),
  [
    { user_id: '10', streak_days: 3 },
    { user_id: '11', streak_days: 1 },
  ],
  'cada persona acumula su propia racha y quien recibio algo no aparece'
);
assert.strictEqual(
  calcularRachaSilencioGlobal(attemptsSilencioUsuario),
  0,
  'el silencio global es cero porque algun usuario si recibio'
);
assert.deepStrictEqual(
  calcularRachaSilencioPorUsuario(
    attemptsSilencioUsuario,
    [{ user_id: 10, fecha: '2026-07-29' }]
  ),
  [{ user_id: '11', streak_days: 1 }],
  'un digest existente corta la racha de esa persona'
);

const saludSilencioUsuario = calcularSaludRecomendaciones({
  attempts: attemptsSilencioUsuario,
  volumePolicy: { userSilenceStreakDays: 3 },
});
assert.strictEqual(saludSilencioUsuario.metrics.user_silence_streak_days_max, 3);
assert.strictEqual(saludSilencioUsuario.metrics.users_silenced_streak, 1);
assert(
  saludSilencioUsuario.flags.some((flag) => flag.code === 'user_silence_multiple_days'),
  'una persona silenciada varios dias genera aviso operativo'
);

const attemptsFunnel = [
  {
    fecha: '2026-07-30',
    total_alertas_dia: 12,
    judge_evaluated_count: 8,
    approved_count: 3,
    queued_count: 1,
    delivered_count: 1,
  },
  {
    fecha: '2026-07-30',
    total_alertas_dia: 12,
    judge_evaluated_count: 5,
    approved_count: 2,
    queued_count: 1,
    delivered_count: 0,
  },
];
assert.deepStrictEqual(resumirEmbudoDigest(attemptsFunnel), {
  judge_evaluated: 13,
  approved: 5,
  queued: 2,
  delivered: 1,
  stopped_by: {},
});

// El silencio debe poder explicarse por barrera, no solo con un total.
assert.deepStrictEqual(
  resumirEmbudoDigest([
    {
      fecha: '2026-07-30',
      judge_evaluated_count: 0,
      metadata_json: { ranking_funnel: { stopped_by: { territory: 4, validity: 1 } } },
    },
    {
      fecha: '2026-07-30',
      judge_evaluated_count: 0,
      metadata_json: { ranking_funnel: { stopped_by: { territory: 2, activity: 3 } } },
    },
    { fecha: '2026-07-30', judge_evaluated_count: 2, metadata_json: null },
  ]),
  {
    judge_evaluated: 2,
    approved: 0,
    queued: 0,
    delivered: 0,
    stopped_by: { territory: 6, activity: 3, validity: 1 },
  },
  'las barreras se agregan ordenadas por impacto y un intento sin embudo no rompe el resumen'
);
assert.strictEqual(
  construirVolumenDiario(attemptsFunnel)[0].available_alerts,
  12,
  'el volumen global repetido por usuario no se suma dos veces'
);

const healthFunnel = calcularSaludRecomendaciones({
  attempts: attemptsFunnel,
  digests: [
    { delivery_status: 'QUEUED' },
    { delivery_status: 'DELIVERED' },
    { delivery_status: 'READ' },
    { enviado: true, delivery_status: null },
  ],
});
assert.deepStrictEqual(healthFunnel.metrics.digest_funnel, {
  judge_evaluated: 13,
  approved: 5,
  queued: 2,
  delivered: 1,
  stopped_by: {},
});
assert.deepStrictEqual(healthFunnel.metrics.delivery_status_counts, {
  QUEUED: 1,
  DELIVERED: 1,
  READ: 1,
  LEGACY_UNKNOWN: 1,
});

const volumePolicy = {
  baselineDays: 3,
  minBaselineDays: 3,
  minBaselineVolume: 5,
  dropRatio: 0.5,
  spikeRatio: 2,
};
const dropVolume = analizarAnomaliasVolumen([
  { fecha: '2026-07-27', total_alertas_dia: 10 },
  { fecha: '2026-07-28', total_alertas_dia: 12 },
  { fecha: '2026-07-29', total_alertas_dia: 11 },
  { fecha: '2026-07-30', total_alertas_dia: 4 },
], volumePolicy);
const availableDrop = dropVolume.anomalies.find((item) => item.metric === 'available_alerts');
assert.strictEqual(availableDrop.state, 'drop');
assert.strictEqual(availableDrop.baseline_median, 11);
assert.strictEqual(availableDrop.baseline_sample_size, 3);

const spikeVolume = analizarAnomaliasVolumen([
  { fecha: '2026-07-27', approved_count: 5 },
  { fecha: '2026-07-28', approved_count: 6 },
  { fecha: '2026-07-29', approved_count: 7 },
  { fecha: '2026-07-30', approved_count: 13 },
], volumePolicy);
assert.strictEqual(
  spikeVolume.anomalies.find((item) => item.metric === 'approved').state,
  'spike'
);

const insufficientVolume = analizarAnomaliasVolumen([
  { fecha: '2026-07-28', total_alertas_dia: 10 },
  { fecha: '2026-07-29', total_alertas_dia: 11 },
  { fecha: '2026-07-30', total_alertas_dia: 0 },
], volumePolicy);
assert.strictEqual(insufficientVolume.anomalies.length, 0, 'dos dias no bastan para alertar');

const residualVolume = analizarAnomaliasVolumen([
  { fecha: '2026-07-27', total_alertas_dia: 1 },
  { fecha: '2026-07-28', total_alertas_dia: 2 },
  { fecha: '2026-07-29', total_alertas_dia: 1 },
  { fecha: '2026-07-30', total_alertas_dia: 10 },
], volumePolicy);
assert.strictEqual(residualVolume.anomalies.length, 0, 'un volumen residual no crea un pico falso');

const healthWithVolumeAlert = calcularSaludRecomendaciones({
  attempts: [
    { fecha: '2026-07-27', total_alertas_dia: 10 },
    { fecha: '2026-07-28', total_alertas_dia: 12 },
    { fecha: '2026-07-29', total_alertas_dia: 11 },
    { fecha: '2026-07-30', total_alertas_dia: 0 },
  ],
  volumePolicy,
});
assert(
  healthWithVolumeAlert.flags.some((flag) => flag.code === 'volume_drop_available_alerts'),
  'una caida a cero genera aviso operativo automatico'
);

console.log('OK: MIA mide utilidad, embudo, entrega, volumen, repeticiones y silencio global');
