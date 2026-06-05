const { evaluarPoliticaDecisionMIA } = require('../src/mia/policy');
const { necesitaCasoAgenteMIA } = require('../src/mia/actionExecutor');
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

console.log('\n=== TESTS: mia policy ===\n');

const autoAnswer = evaluarPoliticaDecisionMIA({
  texto: 'Hay ayudas de la PAC para tractores?',
  digest: null,
  decision: {
    intent: 'pregunta_usuario',
    confidence: 0.84,
    risk_flags: ['digest_missing', 'auto_answered_from_knowledge_base'],
    feedback_actions: [],
    memory_actions: [{ tipo: 'pregunta_usuario', contenido: 'Pregunta PAC', peso_inicial: 0.7 }],
    reply_action: { canal: 'whatsapp', texto: 'MIA ha encontrado una referencia [E1].' },
    knowledge_context: {
      answered: true,
      needs_agent: false,
      evidence_level: 'alta',
      tipo_pregunta: 'general',
      answer_source: 'deterministic_grounded',
      matches: [{ id: 8064, titulo: 'Ayudas PAC', score: 12 }],
    },
    summary: 'Pregunta PAC',
  },
});

assert(autoAnswer.policy.outcome === 'auto_answer', 'Auto responde preguntas con evidencia suficiente');
assert(autoAnswer.policy.requires_agent === false, 'No requiere agente si la respuesta esta grounded');
assert(!autoAnswer.risk_flags.includes('digest_missing'), 'Quita digest_missing cuando no aplica al contexto');
assert(necesitaCasoAgenteMIA(autoAnswer) === false, 'Action executor respeta policy sin agente');
assert(!construirAccionesDesdeDecision({ decision: autoAnswer, userId: 1 }).some((a) => a.action_type === 'handoff_agent'), 'Decision store no crea handoff si policy lo desactiva');

const autoBloqueadaSinEvidencia = evaluarPoliticaDecisionMIA({
  texto: 'Hay ayudas para tractores?',
  decision: {
    intent: 'pregunta_usuario',
    confidence: 0.9,
    risk_flags: [],
    feedback_actions: [],
    memory_actions: [],
    reply_action: { canal: 'whatsapp', texto: 'Si, hay ayudas para tractores.' },
    knowledge_context: {
      answered: true,
      needs_agent: false,
      evidence_level: 'alta',
      tipo_pregunta: 'general',
      matches: [{ id: 8064, titulo: 'Ayudas tractores' }],
    },
  },
});
assert(autoBloqueadaSinEvidencia.policy.outcome === 'partial_answer_handoff', 'Bloquea auto-respuesta sin evidencia visible');
assert(autoBloqueadaSinEvidencia.risk_flags.includes('auto_blocked_missing_traceable_evidence'), 'Marca motivo de bloqueo de auto-respuesta');

const autoBloqueadaSensible = evaluarPoliticaDecisionMIA({
  texto: 'Cuando pagan la ayuda?',
  decision: {
    intent: 'pregunta_usuario',
    confidence: 0.9,
    risk_flags: [],
    feedback_actions: [],
    memory_actions: [],
    reply_action: { canal: 'whatsapp', texto: 'MIA ha encontrado una referencia [E1].' },
    knowledge_context: {
      answered: true,
      needs_agent: false,
      evidence_level: 'alta',
      tipo_pregunta: 'pago',
      answer_source: 'deterministic_grounded',
      matches: [{ id: 9001, titulo: 'Pago ayudas' }],
    },
  },
});
assert(autoBloqueadaSensible.policy.requires_agent === true, 'Bloquea auto-respuesta en pagos aunque haya evidencia');
assert(autoBloqueadaSensible.risk_flags.includes('auto_blocked_sensitive_question_requires_review'), 'Marca bloqueo por pregunta sensible');

const partial = evaluarPoliticaDecisionMIA({
  texto: 'Cuando pagan las ayudas de la dana en Extremadura?',
  digest: null,
  decision: {
    intent: 'pregunta_usuario',
    confidence: 0.68,
    risk_flags: ['knowledge_partial_answer'],
    feedback_actions: [],
    memory_actions: [],
    reply_action: { canal: 'whatsapp', texto: 'MIA ha encontrado referencias, pero lo revisa un agente de Ruralicos [E1].' },
    knowledge_context: { answered: true, needs_agent: true, evidence_level: 'media' },
    summary: 'Pregunta sensible',
  },
});

assert(partial.policy.outcome === 'partial_answer_handoff', 'Escala respuestas parciales o sensibles');
assert(partial.policy.requires_agent === true, 'Marca agente requerido para respuesta parcial');
assert(necesitaCasoAgenteMIA(partial) === true, 'Action executor crea caso si policy requiere agente');

const preference = evaluarPoliticaDecisionMIA({
  texto: 'Me gustaria recibir avisos sobre tractores',
  digest: { id: 10 },
  decision: {
    intent: 'actualizar_preferencias',
    confidence: 0.9,
    risk_flags: [],
    feedback_actions: [],
    memory_actions: [{ tipo: 'interes_detectado', contenido: 'Le interesan tractores', peso_inicial: 0.8 }],
    reply_action: null,
    summary: 'Preferencia futura',
  },
});

assert(preference.policy.outcome === 'ack_preference', 'Confirma preferencias futuras sin tratarlas como feedback');
assert(preference.reply_action.texto.includes('Ruralicos'), 'Genera respuesta sobria de confirmacion');
assert(preference.policy.requires_agent === false, 'No escala preferencias claras');

const preferenceCoop = evaluarPoliticaDecisionMIA({
  texto: 'Me gustaria recibir avisos sobre olivar',
  decision: {
    intent: 'actualizar_preferencias',
    confidence: 0.9,
    risk_flags: [],
    feedback_actions: [],
    memory_actions: [{ tipo: 'interes_detectado', contenido: 'Le interesa olivar', peso_inicial: 0.8 }],
    reply_action: null,
    organization_context: { reply_sender: 'Cooperativa Los Olivos' },
  },
});
assert(preferenceCoop.reply_action.texto.includes('Cooperativa Los Olivos'), 'Policy usa marca de organizacion en respuestas automaticas');

const feedback = evaluarPoliticaDecisionMIA({
  texto: '1',
  digest: { id: 11 },
  alertasDelDigest: [{ id: 100 }],
  decision: {
    intent: 'feedback_digest',
    confidence: 0.95,
    risk_flags: [],
    feedback_actions: [{ item_numero: 1, valor: 1, confianza: 'alta' }],
    memory_actions: [],
    reply_action: { canal: 'whatsapp', texto: 'Gracias' },
    summary: 'Feedback',
  },
});

assert(feedback.policy.outcome === 'record_feedback', 'Registra feedback claro');
assert(feedback.reply_action === null, 'No responde a feedback simple para no molestar');
assert(feedback.policy.should_feedback === true, 'Policy marca que hay feedback ejecutable');

const feedbackNegativo = evaluarPoliticaDecisionMIA({
  texto: 'ninguna',
  digest: { id: 13 },
  alertasDelDigest: [{ id: 100 }, { id: 101 }],
  decision: {
    intent: 'feedback_digest',
    confidence: 0.95,
    risk_flags: [],
    feedback_actions: [
      { item_numero: 1, valor: -1, confianza: 'alta' },
      { item_numero: 2, valor: -1, confianza: 'alta' },
    ],
    memory_actions: [],
    reply_action: null,
    summary: 'Feedback negativo',
  },
});

assert(feedbackNegativo.policy.outcome === 'record_feedback_with_reply', 'Pregunta por contexto cuando rechaza todas');
assert(feedbackNegativo.reply_action.texto.includes('zona'), 'La pregunta de seguimiento pide motivo util');
assert(feedbackNegativo.policy.requires_agent === false, 'No escala a agente por pedir motivo de rechazo');

const feedbackAmbiguo = evaluarPoliticaDecisionMIA({
  texto: 'la otra',
  digest: { id: 12 },
  alertasDelDigest: [{ id: 101 }, { id: 102 }],
  decision: {
    intent: 'feedback_digest',
    confidence: 0.45,
    risk_flags: ['feedback_digest_without_executable_actions', 'low_confidence'],
    feedback_actions: [],
    memory_actions: [],
    reply_action: null,
    summary: 'Feedback ambiguo',
  },
});

assert(feedbackAmbiguo.policy.outcome === 'ask_clarification', 'Pide aclaracion si el feedback no es ejecutable');
assert(feedbackAmbiguo.reply_action.texto.includes('numero'), 'Pide numero de alerta');
assert(!feedbackAmbiguo.risk_flags.includes('feedback_digest_without_executable_actions'), 'Evita handoff si basta aclaracion');
assert(necesitaCasoAgenteMIA(feedbackAmbiguo) === false, 'No abre caso agente para aclaracion simple');

const queja = evaluarPoliticaDecisionMIA({
  texto: 'Esto no funciona, nadie contesta',
  decision: {
    intent: 'queja_servicio',
    confidence: 0.8,
    risk_flags: [],
    feedback_actions: [],
    memory_actions: [],
    reply_action: null,
    summary: 'Queja',
  },
});

assert(queja.policy.outcome === 'handoff_agent', 'Escala quejas de servicio');
assert(queja.policy.priority === 'alta', 'Queja entra con prioridad alta');
assert(queja.reply_action.texto.includes('agente de Ruralicos'), 'Confirma derivacion profesional');

const libreFueraDominio = evaluarPoliticaDecisionMIA({
  texto: 'jajaja que bueno, cuentame un chiste',
  decision: {
    intent: 'mensaje_libre',
    confidence: 0.88,
    risk_flags: [],
    feedback_actions: [],
    memory_actions: [{ tipo: 'mensaje_libre', contenido: 'Pide un chiste', peso_inicial: 0.5 }],
    reply_action: { canal: 'whatsapp', texto: 'Claro, aqui va uno.' },
    summary: 'Charla fuera de dominio',
  },
});

assert(libreFueraDominio.policy.outcome === 'silence', 'Silencia charla libre fuera de dominio');
assert(libreFueraDominio.reply_action === null, 'Elimina reply en charla fuera de dominio');
assert(libreFueraDominio.policy.should_store_memory === false, 'No guarda memoria de charla fuera de dominio');
assert(necesitaCasoAgenteMIA(libreFueraDominio) === false, 'No abre caso por charla fuera de dominio');
assert(
  !construirAccionesDesdeDecision({ decision: libreFueraDominio, userId: 1 }).some((a) => a.action_type === 'reply' || a.action_type === 'memory' || a.action_type === 'handoff_agent'),
  'Decision store no planifica reply/memoria/handoff fuera de dominio'
);

const preguntaFueraDominio = evaluarPoliticaDecisionMIA({
  texto: 'Que tiempo hace manana en Madrid?',
  decision: {
    intent: 'pregunta_usuario',
    confidence: 0.82,
    risk_flags: ['knowledge_no_match'],
    feedback_actions: [],
    memory_actions: [{ tipo: 'pregunta_usuario', contenido: 'Pregunta por el tiempo', peso_inicial: 0.7 }],
    reply_action: { canal: 'whatsapp', texto: 'No tengo datos del tiempo.' },
    knowledge_context: { answered: false, needs_agent: false, matches: [] },
    summary: 'Pregunta fuera de dominio',
  },
});

assert(preguntaFueraDominio.policy.outcome === 'silence', 'Silencia preguntas fuera de Ruralicos');
assert(preguntaFueraDominio.reply_action === null, 'No pide aclaracion en preguntas fuera de dominio');
assert(!preguntaFueraDominio.risk_flags.includes('knowledge_no_match'), 'No escala knowledge_no_match fuera de dominio');
assert(necesitaCasoAgenteMIA(preguntaFueraDominio) === false, 'No abre caso agente por pregunta fuera de dominio');

const feedbackSinContexto = evaluarPoliticaDecisionMIA({
  texto: '1',
  digest: null,
  alertasDelDigest: [],
  decision: {
    intent: 'unknown',
    confidence: 0.5,
    risk_flags: ['digest_missing'],
    feedback_actions: [],
    memory_actions: [],
    reply_action: null,
    summary: 'Numero sin digest activo',
  },
});

assert(feedbackSinContexto.policy.outcome === 'silence', 'Silencia feedback corto sin digest activo');
assert(feedbackSinContexto.reply_action === null, 'No pide numero si no hay digest activo');

const preguntaDominio = evaluarPoliticaDecisionMIA({
  texto: 'Hay ayudas para olivar?',
  decision: {
    intent: 'pregunta_usuario',
    confidence: 0.7,
    risk_flags: ['knowledge_no_match'],
    feedback_actions: [],
    memory_actions: [],
    reply_action: null,
    knowledge_context: { answered: false, needs_agent: true, matches: [] },
    summary: 'Pregunta agraria sin evidencia',
  },
});

assert(preguntaDominio.policy.requires_agent === true, 'Mantiene handoff para preguntas agrarias reales');
assert(preguntaDominio.reply_action.texto.includes('respuesta clara'), 'Sigue contestando cuando el tema es Ruralicos/agro');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
