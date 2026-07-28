const assert = require('assert');
const {
  calcularSaludRecomendaciones,
  contarRepeticionesPorUsuario,
} = require('../src/modules/mia/recommendationHealth');

const digests = [
  { id: 1, user_id: 10, fecha: '2026-07-20', alerta_ids: [100, 101], enviado: true },
  { id: 2, user_id: 10, fecha: '2026-07-21', alerta_ids: [101, 102], enviado: true },
  { id: 3, user_id: 11, fecha: '2026-07-21', alerta_ids: [101], enviado: true },
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
assert.strictEqual(report.metrics.trace_coverage_pct, 100);
assert.strictEqual(report.metrics.repeated_alerts_same_user, 1);
assert(report.flags.some((flag) => flag.code === 'wrong_location_feedback'));
assert(report.flags.some((flag) => flag.code === 'repeated_alerts_same_user'));
assert.strictEqual(report.status, 'critical');

console.log('OK: MIA mide utilidad, territorio, trazabilidad y repeticiones automaticamente');
