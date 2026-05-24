const {
  construirAnswerAuditMIA,
  evaluarDecisionRespuesta,
} = require('../src/mia/answerAudit');

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

console.log('\n=== TESTS: mia answer audit ===\n');

const decisionAutoSinEvidencia = {
  id: 1,
  user_id: 141,
  intent: 'pregunta_usuario',
  confidence: 0.84,
  created_at: '2026-05-24T10:00:00Z',
  decision_json: {
    intent: 'pregunta_usuario',
    confidence: 0.84,
    policy: { outcome: 'auto_answer', requires_agent: false, should_reply: true },
    knowledge_context: {
      answered: true,
      needs_agent: false,
      evidence_level: 'media',
      tipo_pregunta: 'general',
      matches: [],
      grounded_evidences: [],
      answer_source: 'deterministic_template',
    },
    reply_action: { canal: 'whatsapp', texto: 'MIA ha encontrado referencias relacionadas.' },
  },
};

const decisionSensible = {
  id: 2,
  user_id: 141,
  intent: 'pregunta_usuario',
  confidence: 0.8,
  created_at: '2026-05-24T10:01:00Z',
  decision_json: {
    intent: 'pregunta_usuario',
    confidence: 0.8,
    policy: { outcome: 'auto_answer', requires_agent: false, should_reply: true },
    knowledge_context: {
      answered: true,
      needs_agent: false,
      evidence_level: 'alta',
      tipo_pregunta: 'pago',
      matches: [{ id: 10 }],
      grounded_evidences: [{ ref: 'E1' }],
      answer_source: 'ai_grounded',
    },
    reply_action: { canal: 'whatsapp', texto: 'Te garantizo que pagan el 15 de junio [E1].' },
  },
};

const decisionEscalada = {
  id: 3,
  user_id: 142,
  intent: 'pregunta_usuario',
  confidence: 0.91,
  created_at: '2026-05-24T10:02:00Z',
  decision_json: {
    intent: 'pregunta_usuario',
    confidence: 0.91,
    policy: { outcome: 'handoff_agent', requires_agent: true, should_reply: true },
    knowledge_context: {
      answered: true,
      needs_agent: false,
      evidence_level: 'alta',
      matches: [{ id: 11 }],
      answer_source: 'ai_grounded',
    },
    reply_action: { canal: 'whatsapp', texto: 'Lo revisa un agente de Ruralicos.' },
  },
};

const evaluated = evaluarDecisionRespuesta(decisionAutoSinEvidencia);
assert(evaluated.flags.includes('auto_answer_without_evidence_payload'), 'Detecta auto-respuesta sin evidencia payload');
assert(evaluated.flags.includes('auto_answer_without_visible_evidence'), 'Detecta auto-respuesta sin evidencia visible');
assert(evaluated.flags.includes('auto_answer_without_traceable_evidence'), 'Detecta auto-respuesta sin evidencia trazable');

const audit = construirAnswerAuditMIA({
  decisions: [decisionAutoSinEvidencia, decisionSensible, decisionEscalada],
  outbox: [
    { id: 10, decision_id: 1, body: 'MIA ha encontrado referencias relacionadas.', status: 'sent' },
    { id: 11, decision_id: 2, body: 'Te garantizo que pagan el 15 de junio [E1].', status: 'sent' },
    { id: 12, decision_id: 3, body: 'Lo revisa un agente de Ruralicos.', status: 'sent' },
  ],
  agentCases: [{ id: 5, decision_id: 3, status: 'open', priority: 'normal' }],
});

assert(audit.ok === false, 'Auditoria falla con problemas de evidencia/sensibilidad');
assert(audit.metrics.total_decisions === 3, 'Cuenta decisiones');
assert(audit.metrics.sensitive_without_agent === 1, 'Cuenta sensibles sin agente');
assert(audit.metrics.auto_without_evidence >= 1, 'Cuenta auto-respuestas sin evidencia');
assert(audit.metrics.possible_over_escalation === 1, 'Cuenta posible sobre-escalado');
assert(audit.problematicas.length >= 2, 'Incluye decisiones problematicas');
assert(audit.recommendations.some((item) => item.priority === 'alta'), 'Genera recomendaciones altas');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
