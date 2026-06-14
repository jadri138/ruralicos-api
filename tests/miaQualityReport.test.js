const {
  construirQualityReportMIA,
  calcularQualityScoreMIA,
  calidadPorScore,
} = require('../src/modules/mia/qualityReport');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

console.log('\n=== TESTS: mia quality report ===\n');

const report = construirQualityReportMIA({
  inbound: [
    { status: 'processed' },
    { status: 'processed' },
    { status: 'failed', error_msg: 'boom' },
  ],
  decisions: [
    {
      intent: 'pregunta_usuario',
      confidence: 0.91,
      risk_flags: ['auto_answered_from_knowledge_base'],
      decision_json: {
        policy: { outcome: 'auto_answer', requires_agent: false },
        knowledge_context: {
          answered: true,
          needs_agent: false,
          answer_source: 'ai_grounded',
        },
      },
    },
    {
      intent: 'pregunta_usuario',
      confidence: 0.42,
      risk_flags: ['knowledge_no_match'],
      decision_json: {
        policy: { outcome: 'handoff_agent', requires_agent: true },
        knowledge_context: {
          answered: false,
          needs_agent: true,
          answer_source: 'deterministic_no_evidence',
        },
      },
    },
  ],
  actions: [
    { action_type: 'reply', status: 'executed' },
    { action_type: 'handoff_agent', status: 'planned' },
    { action_type: 'memory', status: 'failed' },
  ],
  outbox: [
    { status: 'sent' },
    { status: 'failed' },
  ],
  agentCases: [
    { status: 'open', priority: 'alta' },
  ],
});

assert(report.metrics.inbound_total === 3, 'Cuenta inbound total');
assert(report.metrics.inbound_failed === 1, 'Cuenta inbound fallido');
assert(report.metrics.knowledge_answered === 1, 'Cuenta respuestas con base de conocimiento');
assert(report.metrics.ai_grounded_answers === 1, 'Cuenta respuestas ai_grounded');
assert(report.breakdown.risk_flags.knowledge_no_match === 1, 'Agrupa risk flags');
assert(report.breakdown.policy_outcomes.auto_answer === 1, 'Agrupa resultados de politica');
assert(report.recommendations.some((item) => item.priority === 'alta'), 'Genera recomendaciones de prioridad alta');
assert(report.score < 100, 'Penaliza fallos y riesgos');

const healthy = construirQualityReportMIA({
  inbound: [{ status: 'processed' }, { status: 'processed' }],
  decisions: [{
    intent: 'actualizar_preferencias',
    confidence: 0.96,
    risk_flags: [],
    decision_json: {},
  }],
  actions: [{ action_type: 'memory', status: 'executed' }],
  outbox: [{ status: 'sent' }],
  agentCases: [],
});

assert(healthy.score >= 90, 'Da score alto a periodo estable');
assert(healthy.grade === 'enterprise_ready', 'Clasifica periodo estable como enterprise_ready');
assert(calidadPorScore(95) === 'enterprise_ready', 'Mapea score alto a enterprise_ready');
assert(calcularQualityScoreMIA({ avg_confidence: 0.95 }, {}, {}) >= 90, 'Score alto con confianza alta y sin fallos');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
