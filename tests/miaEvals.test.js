const {
  MIA_EVAL_FIXTURES,
  ejecutarEvalsMIA,
  evaluarEscenarioMIA,
} = require('../src/mia/evalHarness');

let passed = 0;
let failed = 0;

function assert(condition, message, details = {}) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    if (Object.keys(details).length) {
      console.error(JSON.stringify(details, null, 2));
    }
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

console.log('\n=== EVALS: mia conversations ===\n');

assert(MIA_EVAL_FIXTURES.length >= 8, 'Incluye bateria amplia de escenarios MIA');

for (const fixture of MIA_EVAL_FIXTURES) {
  const scenario = evaluarEscenarioMIA(fixture);
  assert(scenario.ok, `${fixture.id}: escenario completo`, {
    failed_checks: scenario.checks.filter((check) => !check.ok),
    intent: scenario.decision.intent,
    policy: scenario.decision.policy,
    risk_flags: scenario.decision.risk_flags,
    reply: scenario.decision.reply_action?.texto || null,
    action_types: scenario.actions.map((action) => action.action_type),
  });

  assert(Boolean(scenario.decision.policy?.outcome), `${fixture.id}: siempre tiene policy outcome`);
  assert(
    !/jaime|granja|vacas|ovejas|que tengas/i.test(scenario.decision.reply_action?.texto || ''),
    `${fixture.id}: respuesta sin personalizacion rara`
  );
}

const report = ejecutarEvalsMIA();
assert(report.ok === true, 'Informe global de evals sin fallos', {
  failed_checks: report.failed_checks,
});
assert(report.scenarios_passed === report.scenarios_total, 'Todos los escenarios pasan');
assert(report.checks_total >= 35, 'Ejecuta suficientes checks contractuales');

const outcomes = report.scenarios.reduce((acc, scenario) => {
  const key = scenario.decision.policy?.outcome || 'unknown';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

const feedbackDigestOutcomes = (outcomes.record_feedback || 0) + (outcomes.record_feedback_with_reply || 0);
assert(feedbackDigestOutcomes >= 2, 'Cubre feedback de digest');
assert(outcomes.ack_preference >= 1, 'Cubre actualizacion de preferencias');
assert(outcomes.auto_answer >= 1, 'Cubre respuesta automatica grounded');
assert(outcomes.partial_answer_handoff >= 1 || outcomes.handoff_agent >= 1, 'Cubre escalado a agente');
assert(outcomes.ask_clarification >= 1, 'Cubre peticion de aclaracion');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
