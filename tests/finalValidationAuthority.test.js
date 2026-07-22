process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
delete process.env.DIGEST_FINAL_VALIDATION_MODE;
delete process.env.DIGEST_FINAL_VALIDATION_ENFORCEMENT;

const assert = require('assert');
const fixture = require('./fixtures/audited-2026-07-21/final-validation-authority.json');
const {
  DIGEST_FINAL_VALIDATION_MODE,
  construirDecisionEfectivaEnvioAutomatico,
  filtrarAlertasEnviablesAutomaticamente,
  filtrarAlertasPorValidacionFinalDigest,
} = require('../src/modules/digest/digest.service');

const alertas = Array.from({ length: fixture.selected_items }, (_, index) => ({
  id: index + 1,
  decision_digest: {
    action: fixture.selection_action,
    incluir: true,
    motivo: 'selected_before_final_validation',
  },
}));

const itemResults = alertas.map((alerta, index) => ({
  alerta_id: alerta.id,
  status: index < fixture.final_validation.blocked ? 'blocked' : 'review_only',
  flags: [index < fixture.final_validation.blocked ? 'audited_block' : 'audited_review'],
  reasons: [],
}));

const selectionGate = filtrarAlertasEnviablesAutomaticamente(alertas);
assert.strictEqual(
  selectionGate.enviables.length,
  fixture.selected_items,
  'El fixture reproduce que la seleccion include autorizaba los 84 items antes del gate final'
);

const finalGate = filtrarAlertasPorValidacionFinalDigest(
  selectionGate.enviables,
  { item_results: itemResults },
  { mode: DIGEST_FINAL_VALIDATION_MODE }
);

assert.strictEqual(
  finalGate.aceptadas.length,
  fixture.expected.effective_send_items,
  'La validacion final debe ser autoritativa aunque la seleccion previa fuese include'
);
assert.strictEqual(finalGate.rechazadas.length, fixture.selected_items);
assert.strictEqual(finalGate.summary.blocked, fixture.final_validation.blocked);
assert.strictEqual(finalGate.summary.review_only, fixture.final_validation.review_only);

function effective(finalValidation, context = 'automatic_daily', selectionAction = 'include') {
  return construirDecisionEfectivaEnvioAutomatico({
    alerta: { id: 900, decision_digest: { action: selectionAction, incluir: selectionAction === 'include' } },
    itemValidation: finalValidation,
    context,
  });
}

const mandatoryCases = [
  ['include + send', { status: 'send' }, true],
  ['include + blocked', { status: 'blocked' }, false],
  ['include + review_only', { status: 'review_only' }, false],
  ['include + insufficient_evidence', { status: 'insufficient_evidence' }, false],
  ['include + selection_missing', { status: 'selection_missing' }, false],
  ['include + validation missing', null, false],
  ['include + validation error', { status: 'error' }, false],
  ['include + validation timeout', { status: 'timeout' }, false],
  ['include + validation incomplete', { flags: [] }, false],
  ['include + validation invalid', { status: 'unexpected' }, false],
];

for (const [name, finalValidation, expected] of mandatoryCases) {
  const decision = effective(finalValidation);
  assert.strictEqual(decision.automatic_send_allowed, expected, name);
  assert.strictEqual(decision.effective_send_decision, expected ? 'send' : 'blocked', name);
}

for (const context of ['rescue', 'legacy', 'fallback']) {
  const decision = effective({ status: 'blocked' }, context);
  assert.strictEqual(decision.automatic_send_allowed, false, `${context} + blocked`);
  assert.strictEqual(decision.context, context);
}

const auditedMetrics = mandatoryCases.map(([name, finalValidation]) => ({
  name,
  ...effective(finalValidation),
}));
assert(
  auditedMetrics
    .filter((decision) => decision.automatic_send_allowed)
    .every((decision) => decision.final_validation_decision.status === 'send'),
  'automatic_send_allowed solo puede existir con validacion final send'
);

const missingItemGate = filtrarAlertasPorValidacionFinalDigest(
  [{ id: 901, decision_digest: { action: 'include', incluir: true } }],
  { item_results: [{ alerta_id: 999, status: 'send' }] }
);
assert.strictEqual(missingItemGate.aceptadas.length, 0, 'Un item ausente en la respuesta queda bloqueado');
assert.strictEqual(
  missingItemGate.rechazadas[0].effective_send_gate.effective_reason,
  'final_validation_missing'
);

console.log('OK: incidente 84 seleccionados, 81 blocked y 3 review_only queda fail-closed');
