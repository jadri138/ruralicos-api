const { construirAccionesDesdeDecision } = require('../src/mia/decisionStore');

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

console.log('\n=== TESTS: mia decision store ===\n');

const acciones = construirAccionesDesdeDecision({
  userId: 141,
  digestId: 1097,
  inboundId: 72,
  organizationId: 12,
  decision: {
    intent: 'actualizar_preferencias',
    feedback_actions: [{ item_numero: 1, valor: 1 }],
    memory_actions: [{ tipo: 'interes_detectado', contenido: 'PAC' }],
    reply_action: { canal: 'whatsapp', texto: 'Guardado.' },
  },
});

assert(acciones.length === 3, 'Construye acciones para feedback, memoria y respuesta');
assert(acciones.some((a) => a.action_type === 'feedback_digest'), 'Incluye accion feedback_digest');
assert(acciones.some((a) => a.action_type === 'memory'), 'Incluye accion memory');
assert(acciones.some((a) => a.action_type === 'reply'), 'Incluye accion reply');
assert(acciones.every((a) => a.organization_id === 12), 'Propaga organization_id a todas las acciones');

const accionesConAgente = construirAccionesDesdeDecision({
  userId: 141,
  digestId: 1097,
  inboundId: 73,
  decision: {
    intent: 'pregunta_usuario',
    confidence: 0.82,
    risk_flags: [],
    feedback_actions: [],
    memory_actions: [{ tipo: 'pregunta_usuario', contenido: 'Cuando sale la resolucion' }],
    reply_action: { canal: 'whatsapp', texto: 'Lo revisa nuestro equipo.' },
  },
});

assert(accionesConAgente.some((a) => a.action_type === 'handoff_agent'), 'Incluye handoff_agent para preguntas de usuario');

const accionesAutoRespondidas = construirAccionesDesdeDecision({
  userId: 141,
  digestId: 1097,
  inboundId: 74,
  decision: {
    intent: 'pregunta_usuario',
    confidence: 0.88,
    risk_flags: ['auto_answered_from_knowledge_base'],
    feedback_actions: [],
    memory_actions: [],
    reply_action: { canal: 'whatsapp', texto: 'He encontrado referencias en Ruralicos.' },
  },
});

assert(!accionesAutoRespondidas.some((a) => a.action_type === 'handoff_agent'), 'No crea handoff_agent si la pregunta queda auto respondida');

const accionesSinEvidencia = construirAccionesDesdeDecision({
  userId: 141,
  decision: {
    intent: 'unknown',
    confidence: 0.4,
    risk_flags: ['knowledge_no_match'],
    feedback_actions: [],
    memory_actions: [],
    reply_action: { canal: 'whatsapp', texto: 'Lo revisa un agente de Ruralicos.' },
  },
});

assert(accionesSinEvidencia.some((a) => a.action_type === 'handoff_agent'), 'Escala a agente si no hay evidencia en base Ruralicos');

const sinAcciones = construirAccionesDesdeDecision({
  userId: 141,
  decision: { intent: 'trivial', feedback_actions: [], memory_actions: [] },
});

assert(sinAcciones.length === 1 && sinAcciones[0].action_type === 'none', 'Registra accion none para decisiones sin acciones');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
