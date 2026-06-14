const { construirDecisionDesdeInterpretacion } = require('./decisionCore');
const { aplicarRespuestaConocimientoADecision } = require('./knowledgeBase');
const { evaluarPoliticaDecisionMIA } = require('./policy');
const { necesitaCasoAgenteMIA } = require('./actionExecutor');
const { construirAccionesDesdeDecision } = require('./decisionStore');

const DEFAULT_USER_PROFILE = {
  version: 'mia_user_profile_v1',
  declared: {
    provincias: ['Extremadura'],
    sectores: ['agricultura'],
  },
  interests: [
    { topic: 'pac', score: 2.4 },
    { topic: 'ayudas_maquinaria', score: 2.1 },
  ],
  dislikes: [],
};

const DEFAULT_DIGEST_ALERTAS = [
  {
    id: 8064,
    titulo: 'Ayudas agrarias y maquinaria agricola',
    resumen_final: 'Convocatoria relacionada con explotaciones agrarias y maquinaria.',
    url: 'https://example.com/8064',
  },
  {
    id: 8065,
    titulo: 'Concesion de aguas para riego',
    resumen_final: 'Expediente individual de aguas.',
    url: 'https://example.com/8065',
  },
];

const MIA_EVAL_FIXTURES = [
  {
    id: 'feedback_numero_positivo',
    texto: '1',
    digest: { id: 1001 },
    alertasDelDigest: [DEFAULT_DIGEST_ALERTAS[0]],
    interpretacion: {
      feedbacks: [{ item_numero: 1, valor: 1, confianza: 'alta', razon: 'Numero 1' }],
      memoria: [],
      requiere_respuesta: false,
      respuesta: '',
      intencion: 'feedback',
      resumen_para_log: 'Feedback item 1',
    },
    expect: {
      intent: 'feedback_digest',
      policyOutcome: 'record_feedback',
      feedbackActions: 1,
      reply: false,
      requiresAgent: false,
    },
  },
  {
    id: 'feedback_ninguna',
    texto: 'ninguna',
    digest: { id: 1002 },
    alertasDelDigest: DEFAULT_DIGEST_ALERTAS,
    interpretacion: {
      feedbacks: [
        { item_numero: 1, valor: -1, confianza: 'alta', razon: 'Ninguna' },
        { item_numero: 2, valor: -1, confianza: 'alta', razon: 'Ninguna' },
      ],
      memoria: [],
      requiere_respuesta: false,
      respuesta: '',
      intencion: 'feedback',
      resumen_para_log: 'Feedback negativo todos',
    },
    expect: {
      intent: 'feedback_digest',
      policyOutcome: 'record_feedback_with_reply',
      feedbackActions: 2,
      reply: true,
      replyIncludes: ['zona'],
      requiresAgent: false,
    },
  },
  {
    id: 'preferencia_futura_pac_tractores',
    texto: 'Me gustaria recibir avisos sobre la PAC y ayudas para tractores',
    digest: { id: 1003 },
    alertasDelDigest: [DEFAULT_DIGEST_ALERTAS[0]],
    interpretacion: {
      feedbacks: [],
      memoria: [
        { tipo: 'interes_detectado', contenido: 'Le interesa la PAC', peso_inicial: 0.9 },
        { tipo: 'interes_detectado', contenido: 'Le interesan ayudas para tractores', peso_inicial: 0.8 },
      ],
      requiere_respuesta: false,
      respuesta: '',
      intencion: 'conversacion',
      resumen_para_log: 'Preferencia futura',
    },
    expect: {
      intent: 'actualizar_preferencias',
      policyOutcome: 'ack_preference',
      feedbackActions: 0,
      memoryActionsMin: 2,
      reply: true,
      replyIncludes: ['Ruralicos'],
      requiresAgent: false,
    },
  },
  {
    id: 'pregunta_auto_answer_grounded',
    texto: 'Hay ayudas para tractores en Extremadura?',
    digest: null,
    alertasDelDigest: [],
    interpretacion: {
      feedbacks: [],
      memoria: [{ tipo: 'pregunta_usuario', contenido: 'Pregunta por ayudas para tractores en Extremadura', peso_inicial: 0.7 }],
      requiere_respuesta: true,
      respuesta: 'Lo reviso en Ruralicos.',
      intencion: 'pregunta',
      resumen_para_log: 'Pregunta ayudas tractores',
    },
    knowledgeResult: {
      answered: true,
      needs_agent: false,
      confidence: 0.88,
      evidence_level: 'alta',
      tipo_pregunta: 'general',
      answer_source: 'deterministic_grounded',
      reply: 'MIA ha encontrado una referencia sobre ayudas para maquinaria agricola [E1].',
      matches: [{ id: 8064, titulo: 'Ayudas para maquinaria agricola', score: 12 }],
      grounded_evidences: [{ ref: 'E1', id: 8064, titulo: 'Ayudas para maquinaria agricola' }],
    },
    expect: {
      intent: 'pregunta_usuario',
      policyOutcome: 'auto_answer',
      reply: true,
      replyIncludes: ['[E1]'],
      requiresAgent: false,
      riskFlagsExclude: ['digest_missing'],
      autoAnswered: true,
    },
  },
  {
    id: 'pregunta_auto_bloqueada_sin_cita_visible',
    texto: 'Hay ayudas para tractores en Extremadura?',
    digest: null,
    alertasDelDigest: [],
    interpretacion: {
      feedbacks: [],
      memoria: [{ tipo: 'pregunta_usuario', contenido: 'Pregunta por ayudas para tractores', peso_inicial: 0.7 }],
      requiere_respuesta: true,
      respuesta: 'Hay ayudas para tractores.',
      intencion: 'pregunta',
      resumen_para_log: 'Pregunta ayudas sin evidencia visible',
    },
    knowledgeResult: {
      answered: true,
      needs_agent: false,
      confidence: 0.9,
      evidence_level: 'alta',
      tipo_pregunta: 'general',
      answer_source: 'deterministic_grounded',
      reply: 'Hay ayudas para tractores.',
      matches: [{ id: 8064, titulo: 'Ayudas para maquinaria agricola', score: 12 }],
    },
    expect: {
      intent: 'pregunta_usuario',
      policyOutcome: 'partial_answer_handoff',
      reply: true,
      requiresAgent: true,
      riskFlagsInclude: ['auto_blocked_missing_traceable_evidence'],
      riskFlagsExclude: ['auto_answered_from_knowledge_base'],
      actionTypes: ['handoff_agent', 'reply'],
    },
  },
  {
    id: 'pregunta_pago_sensible_handoff',
    texto: 'quiero saber cuando llegara el pago de las ayudas por las borrascas a extremadura',
    digest: null,
    alertasDelDigest: [],
    interpretacion: {
      feedbacks: [],
      memoria: [{ tipo: 'pregunta_usuario', contenido: 'Pregunta por pagos de ayudas por borrascas en Extremadura', peso_inicial: 0.7 }],
      requiere_respuesta: true,
      respuesta: 'MIA ha encontrado referencias relacionadas, pero no confirma pagos sin revision.',
      intencion: 'pregunta',
      resumen_para_log: 'Pregunta pago sensible',
    },
    knowledgeResult: {
      answered: true,
      needs_agent: true,
      confidence: 0.68,
      evidence_level: 'media',
      tipo_pregunta: 'pago',
      answer_source: 'deterministic_grounded',
      reply: 'MIA ha encontrado referencias relacionadas [E1], pero no confirma fechas o pagos sin revision. Lo revisa un agente de Ruralicos.',
      matches: [{ id: 9001, titulo: 'Ayudas por danos climaticos', score: 8 }],
      grounded_evidences: [{ ref: 'E1', id: 9001, titulo: 'Ayudas por danos climaticos' }],
    },
    expect: {
      intent: 'pregunta_usuario',
      policyOutcome: 'partial_answer_handoff',
      reply: true,
      replyIncludes: ['agente de Ruralicos'],
      requiresAgent: true,
      actionTypes: ['handoff_agent', 'reply'],
    },
  },
  {
    id: 'preferencia_cooperativa_branding',
    texto: 'Me gustaria recibir avisos sobre olivar ecologico',
    digest: null,
    alertasDelDigest: [],
    interpretacion: {
      feedbacks: [],
      memoria: [{ tipo: 'interes_detectado', contenido: 'Le interesa olivar ecologico', peso_inicial: 0.9 }],
      requiere_respuesta: false,
      respuesta: '',
      intencion: 'conversacion',
      resumen_para_log: 'Preferencia futura cooperativa',
    },
    decisionPatch: {
      organization_context: {
        reply_sender: 'Cooperativa Los Olivos',
        brand_name: 'Cooperativa Los Olivos',
      },
    },
    expect: {
      intent: 'actualizar_preferencias',
      policyOutcome: 'ack_preference',
      reply: true,
      replyIncludes: ['Cooperativa Los Olivos'],
      requiresAgent: false,
    },
  },
  {
    id: 'feedback_ambiguo_digest_pide_numero',
    texto: 'me interesa la del agua',
    digest: { id: 1008 },
    alertasDelDigest: DEFAULT_DIGEST_ALERTAS,
    interpretacion: {
      feedbacks: [{ item_numero: 3, valor: 1, confianza: 'alta', razon: 'Referencia ambigua fuera de rango' }],
      memoria: [],
      requiere_respuesta: false,
      respuesta: '',
      intencion: 'feedback',
      resumen_para_log: 'Feedback ambiguo fuera de rango',
    },
    expect: {
      intent: 'feedback_digest',
      policyOutcome: 'ask_clarification',
      feedbackActions: 0,
      reply: true,
      replyIncludes: ['numero'],
      requiresAgent: false,
      riskFlagsExclude: ['digest_missing'],
    },
  },
  {
    id: 'feedback_sin_digest_pide_numero',
    texto: '1',
    digest: null,
    alertasDelDigest: [],
    interpretacion: {
      feedbacks: [{ item_numero: 1, valor: 1, confianza: 'alta', razon: 'Numero 1' }],
      memoria: [],
      requiere_respuesta: false,
      respuesta: '',
      intencion: 'feedback',
      resumen_para_log: 'Feedback sin digest',
    },
    expect: {
      intentNot: 'feedback_digest',
      policyOutcome: 'silence',
      feedbackActions: 0,
      reply: false,
      requiresAgent: false,
      riskFlagsExclude: ['digest_missing'],
    },
  },
  {
    id: 'queja_servicio_handoff',
    texto: 'Hoy no han mandado nada y siempre llega tarde',
    digest: null,
    alertasDelDigest: [],
    interpretacion: {
      feedbacks: [],
      memoria: [{ tipo: 'mensaje_libre', contenido: 'Queja por retraso en envio', peso_inicial: 0.7 }],
      requiere_respuesta: true,
      respuesta: 'Lo revisamos.',
      intencion: 'queja',
      resumen_para_log: 'Queja de servicio',
    },
    expect: {
      intent: 'queja_servicio',
      policyOutcome: 'handoff_agent',
      reply: true,
      replyIncludes: ['agente de Ruralicos'],
      requiresAgent: true,
      policyPriority: 'alta',
      actionTypes: ['handoff_agent', 'reply'],
    },
  },
  {
    id: 'respuesta_rara_sanitizada',
    texto: 'cuando sale la resolucion en Andalucia',
    digest: null,
    alertasDelDigest: [],
    interpretacion: {
      feedbacks: [],
      memoria: [{ tipo: 'pregunta_usuario', contenido: 'Pregunta por resolucion en Andalucia', peso_inicial: 0.7 }],
      requiere_respuesta: true,
      respuesta: 'Hola Jose Luis,\nLo reviso y te aviso cuando haya una fecha clara.\nQue tengas buen dia en tu granja con tus vacas.',
      intencion: 'pregunta',
      resumen_para_log: 'Pregunta con respuesta rara',
    },
    knowledgeResult: {
      answered: false,
      needs_agent: true,
      confidence: 0.2,
      evidence_level: 'sin_evidencia',
      reply: '',
      matches: [],
    },
    expect: {
      intent: 'pregunta_usuario',
      reply: true,
      replyNotMatches: ['Jose Luis', 'granja', 'vacas'],
      requiresAgent: true,
    },
  },
];

function crearDecisionEvaluadaMIA(fixture = {}) {
  let decision = construirDecisionDesdeInterpretacion({
    texto: fixture.texto,
    digest: fixture.digest,
    alertasDelDigest: fixture.alertasDelDigest || [],
    interpretacion: fixture.interpretacion,
  });

  if (fixture.knowledgeResult) {
    decision = aplicarRespuestaConocimientoADecision(decision, fixture.knowledgeResult);
  }

  if (fixture.decisionPatch) {
    decision = {
      ...decision,
      ...fixture.decisionPatch,
      risk_flags: [
        ...(decision.risk_flags || []),
        ...(fixture.decisionPatch.risk_flags || []),
      ],
    };
  }

  decision = evaluarPoliticaDecisionMIA({
    decision,
    texto: fixture.texto,
    perfilOperativo: fixture.perfilOperativo || DEFAULT_USER_PROFILE,
    digest: fixture.digest,
    alertasDelDigest: fixture.alertasDelDigest || [],
  });

  const actions = construirAccionesDesdeDecision({
    decision,
    userId: fixture.userId || 141,
    digestId: fixture.digest?.id || null,
    inboundId: fixture.inboundId || 1,
  });

  return {
    fixture_id: fixture.id,
    decision,
    actions,
    requires_agent: necesitaCasoAgenteMIA(decision),
  };
}

function assertEval(condition, code, message, details = {}) {
  return condition
    ? { ok: true, code, message, details }
    : { ok: false, code, message, details };
}

function evaluarEscenarioMIA(fixture = {}) {
  const result = crearDecisionEvaluadaMIA(fixture);
  const decision = result.decision;
  const expect = fixture.expect || {};
  const checks = [];
  const replyText = decision.reply_action?.texto || '';
  const actionTypes = new Set(result.actions.map((action) => action.action_type));

  if (expect.intent) {
    checks.push(assertEval(decision.intent === expect.intent, 'intent', `intent=${expect.intent}`, { actual: decision.intent }));
  }
  if (expect.intentNot) {
    checks.push(assertEval(decision.intent !== expect.intentNot, 'intent_not', `intent!=${expect.intentNot}`, { actual: decision.intent }));
  }
  if (expect.policyOutcome) {
    checks.push(assertEval(decision.policy?.outcome === expect.policyOutcome, 'policy_outcome', `policy=${expect.policyOutcome}`, { actual: decision.policy?.outcome }));
  }
  if (expect.policyPriority) {
    checks.push(assertEval(decision.policy?.priority === expect.policyPriority, 'policy_priority', `priority=${expect.policyPriority}`, { actual: decision.policy?.priority }));
  }
  if (expect.feedbackActions !== undefined) {
    checks.push(assertEval((decision.feedback_actions || []).length === expect.feedbackActions, 'feedback_actions', `feedback_actions=${expect.feedbackActions}`, { actual: (decision.feedback_actions || []).length }));
  }
  if (expect.memoryActionsMin !== undefined) {
    checks.push(assertEval((decision.memory_actions || []).length >= expect.memoryActionsMin, 'memory_actions_min', `memory_actions>=${expect.memoryActionsMin}`, { actual: (decision.memory_actions || []).length }));
  }
  if (expect.reply !== undefined) {
    checks.push(assertEval(Boolean(replyText) === Boolean(expect.reply), 'reply_presence', `reply=${expect.reply}`, { actual: Boolean(replyText), reply: replyText }));
  }
  for (const text of expect.replyIncludes || []) {
    checks.push(assertEval(replyText.includes(text), 'reply_includes', `reply includes ${text}`, { reply: replyText }));
  }
  for (const pattern of expect.replyNotMatches || []) {
    const regex = new RegExp(pattern, 'i');
    checks.push(assertEval(!regex.test(replyText), 'reply_not_matches', `reply does not match ${pattern}`, { reply: replyText }));
  }
  if (expect.requiresAgent !== undefined) {
    checks.push(assertEval(result.requires_agent === expect.requiresAgent, 'requires_agent', `requires_agent=${expect.requiresAgent}`, { actual: result.requires_agent }));
  }
  if (expect.autoAnswered !== undefined) {
    checks.push(assertEval(Boolean(decision.auto_answered) === Boolean(expect.autoAnswered), 'auto_answered', `auto_answered=${expect.autoAnswered}`, { actual: Boolean(decision.auto_answered) }));
  }
  for (const flag of expect.riskFlagsInclude || []) {
    checks.push(assertEval((decision.risk_flags || []).includes(flag), 'risk_flag_include', `risk includes ${flag}`, { risk_flags: decision.risk_flags || [] }));
  }
  for (const flag of expect.riskFlagsExclude || []) {
    checks.push(assertEval(!(decision.risk_flags || []).includes(flag), 'risk_flag_exclude', `risk excludes ${flag}`, { risk_flags: decision.risk_flags || [] }));
  }
  for (const type of expect.actionTypes || []) {
    checks.push(assertEval(actionTypes.has(type), 'action_type', `action includes ${type}`, { action_types: [...actionTypes] }));
  }

  return {
    id: fixture.id,
    ok: checks.every((check) => check.ok),
    checks,
    decision,
    actions: result.actions,
    requires_agent: result.requires_agent,
  };
}

function ejecutarEvalsMIA(fixtures = MIA_EVAL_FIXTURES) {
  const scenarios = fixtures.map(evaluarEscenarioMIA);
  const totalChecks = scenarios.reduce((acc, scenario) => acc + scenario.checks.length, 0);
  const failedChecks = scenarios.flatMap((scenario) =>
    scenario.checks
      .filter((check) => !check.ok)
      .map((check) => ({
        scenario_id: scenario.id,
        ...check,
      }))
  );

  return {
    ok: failedChecks.length === 0,
    scenarios_total: scenarios.length,
    scenarios_passed: scenarios.filter((scenario) => scenario.ok).length,
    checks_total: totalChecks,
    checks_failed: failedChecks.length,
    failed_checks: failedChecks,
    scenarios,
  };
}

module.exports = {
  MIA_EVAL_FIXTURES,
  crearDecisionEvaluadaMIA,
  evaluarEscenarioMIA,
  ejecutarEvalsMIA,
};
