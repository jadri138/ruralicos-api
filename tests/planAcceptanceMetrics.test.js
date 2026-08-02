const assert = require('assert');
const fixture = require('./fixtures/acceptance/plan-metrics.json');
const { calcularMetricasCalidadPlan } = require('../src/modules/mia/alertQuality');

const metrics = calcularMetricasCalidadPlan({
  alertas: fixture.alertas,
  digestItems: fixture.digest_items,
  candidateDecisions: fixture.candidate_decisions,
  reviews: fixture.reviews,
  scraperRuns: fixture.scraper_runs,
});

for (const [name, expected] of Object.entries(fixture.expected)) {
  assert.strictEqual(metrics[name], expected, `${name} debe ser ${expected}`);
}

for (const objective of [
  'discard_reason_coverage',
  'ready_alerts_without_taxonomy',
  'review_only_sent',
  'decision_digest_missing',
  'final_validation_blocked_but_allowed',
  'final_validation_missing_but_allowed',
]) {
  assert.strictEqual(typeof metrics.objectives[objective], 'boolean', `objetivo ${objective}`);
}

console.log(`OK: las ${Object.keys(fixture.expected).length} metricas detectan el corpus operativo de aceptacion`);
