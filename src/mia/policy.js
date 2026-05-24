const POLICY_VERSION = 'mia_policy_v1';
const { obtenerMiaBranding } = require('./organizationContext');

const FEEDBACK_CLARIFICATION_REPLY = 'No he podido asociar tu respuesta a una alerta concreta. Puedes responder con el numero de la alerta, por ejemplo 1, 2 o ninguna.';

function construirTextosPolitica(organizationContext = null) {
  const branding = obtenerMiaBranding(organizationContext);
  return {
    clarification: `Para poder mirarlo bien, dime la ayuda, comunidad o tema concreto y lo revisa ${branding.assistant_name} en la base de ${branding.reply_sender}.`,
    agent: `Lo revisa ${branding.agent_label} y te contestamos cuando haya una respuesta clara.`,
    serviceComplaint: `Lo revisa ${branding.agent_label}. Gracias por avisarnos.`,
    preferenceAck: `Perfecto, lo tenemos en cuenta para ajustar tus alertas de ${branding.reply_sender}.`,
    feedbackClarification: FEEDBACK_CLARIFICATION_REPLY,
  };
}

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function limpiarRespuestaPolitica(texto, max = 900) {
  return String(texto || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((linea) => linea.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((linea) => !/\b(granja|vacas|ovejas|que tengas|feliz dia|buen dia)\b/i.test(linea))
    .join('\n')
    .replace(/^hola\s+[^,\n.!?]{2,80}[,.!?\s]+/i, '')
    .replace(/^hola[,.!?\s]+/i, '')
    .trim()
    .slice(0, max);
}

function conReply(decision, texto) {
  const limpio = limpiarRespuestaPolitica(texto);
  return limpio ? { ...decision, reply_action: { canal: 'whatsapp', texto: limpio } } : decision;
}

function asegurarAvisoRevision(decision, avisoRevision) {
  const actual = String(decision.reply_action?.texto || '').trim();
  if (!actual) return conReply(decision, avisoRevision);
  if (/\b(agente|equipo|contestamos)\b/i.test(actual)) return decision;
  return conReply(decision, `${actual}\n${avisoRevision}`);
}

function sinReply(decision) {
  return { ...decision, reply_action: null };
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function removeFlags(flags = [], toRemove = []) {
  const blocked = new Set(toRemove);
  return flags.filter((flag) => !blocked.has(flag));
}

function parecePregunta(texto) {
  const value = normalizar(texto);
  return /\?$/.test(String(texto || '').trim()) ||
    /\b(cuando|donde|como|que|cual|cuanto|por que|sabeis|puedes|podrias|me puedes|hay|existe|sale|pagan|pago|plazo|resolucion)\b/.test(value);
}

function parecePreferenciaFutura(texto) {
  const value = normalizar(texto);
  return /\b(quiero|me gustaria|avisadme|avisame|mandadme|enviadme|recibir|alertas?|avisos?)\b/.test(value) ||
    /\b(no me interesa|no quiero|evitar|no enviar|no mandar)\b/.test(value);
}

function esFeedbackCorto(texto) {
  const value = normalizar(texto)
    .replace(/[\u{1F44D}\u{2705}\u{2B50}\u{1F31F}\u{1F49A}]/gu, '+')
    .replace(/[\u{1F44E}\u{274C}\u{1F6D1}]/gu, '-');

  return /^[+-]?\s*\d{1,2}$/.test(value) ||
    /^\d{1,2}\s*[+-]$/.test(value) ||
    /^(ninguna|ninguno|ambas|todos|todas)$/.test(value) ||
    /^[+-]$/.test(value);
}

function preguntaDemasiadoVaga(texto, perfilOperativo = {}) {
  const value = normalizar(texto);
  const palabras = value.split(/\s+/).filter(Boolean);

  const temas = [
    ...(perfilOperativo.interests || []).map((item) => item.topic),
    ...(perfilOperativo.declared?.provincias || []),
    ...(perfilOperativo.declared?.sectores || []),
  ].map(normalizar).filter(Boolean);

  const tieneTemaPerfil = temas.some((tema) => tema && value.includes(tema));
  const tieneTemaAgrario = /\b(pac|tractor|tractores|maquinaria|ayuda|ayudas|subvencion|borrasca|dana|andalucia|extremadura|aragon|agua|riego|olivar|porcino|vacuno|plazo|pago|resolucion)\b/.test(value);

  if (palabras.length <= 4 && !tieneTemaPerfil && !tieneTemaAgrario) return true;
  return !tieneTemaPerfil && !tieneTemaAgrario && palabras.length < 8;
}

function tipoPreguntaSensible(tipo = '') {
  return ['pago', 'fecha_resolucion', 'plazo'].includes(String(tipo || ''));
}

function respuestaTieneEvidenciaTrazable(decision = {}) {
  const knowledge = decision.knowledge_context || {};
  const replyText = String(decision.reply_action?.texto || '');
  const matches = Array.isArray(knowledge.matches) ? knowledge.matches : [];
  const evidences = Array.isArray(knowledge.grounded_evidences) ? knowledge.grounded_evidences : [];
  const answerSource = String(knowledge.answer_source || '');
  const hasVisibleEvidence = /\[E\d+\]/.test(replyText) || /https?:\/\//i.test(replyText);
  const hasPayloadEvidence = matches.length > 0 || evidences.length > 0;
  const groundedSource = ['ai_grounded', 'deterministic_grounded', 'deterministic_after_guardrail'].includes(answerSource);

  return hasVisibleEvidence && hasPayloadEvidence && (groundedSource || evidences.length > 0);
}

function evaluarPermisoAutoRespuestaMIA({
  decision = {},
  texto = '',
  perfilOperativo = {},
} = {}) {
  const knowledge = decision.knowledge_context || {};
  const reasons = [];
  const confidence = Number(decision.confidence || 0);

  if (!knowledge.answered) reasons.push('knowledge_not_answered');
  if (knowledge.needs_agent) reasons.push('knowledge_requires_agent');
  if (!decision.reply_action?.texto) reasons.push('reply_missing');
  if (confidence < 0.72) reasons.push('confidence_below_auto_threshold');
  if (tipoPreguntaSensible(knowledge.tipo_pregunta)) reasons.push('sensitive_question_requires_review');
  if (!respuestaTieneEvidenciaTrazable(decision)) reasons.push('missing_traceable_evidence');
  if (preguntaDemasiadoVaga(texto, perfilOperativo)) reasons.push('question_too_vague_for_auto_answer');

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

function construirPolicy({
  outcome,
  reasons = [],
  requiresAgent = false,
  shouldReply = false,
  shouldStoreMemory = false,
  shouldFeedback = false,
  priority = 'normal',
  confidence = null,
}) {
  return {
    version: POLICY_VERSION,
    outcome,
    reasons: unique(reasons),
    requires_agent: Boolean(requiresAgent),
    should_reply: Boolean(shouldReply),
    should_store_memory: Boolean(shouldStoreMemory),
    should_feedback: Boolean(shouldFeedback),
    priority,
    confidence,
  };
}

function aplicarPolicy(decision, policy, { riskFlags = [], replyAction = undefined, autoAnswered = undefined } = {}) {
  const next = {
    ...decision,
    risk_flags: unique(riskFlags),
    policy,
    summary: decision.summary
      ? `${decision.summary} Politica: ${policy.outcome}.`
      : `Politica: ${policy.outcome}.`,
  };

  if (replyAction !== undefined) next.reply_action = replyAction;
  if (autoAnswered !== undefined) next.auto_answered = Boolean(autoAnswered);
  return next;
}

function evaluarPoliticaDecisionMIA({
  decision = {},
  texto = '',
  perfilOperativo = {},
  digest = null,
  alertasDelDigest = [],
} = {}) {
  let next = { ...decision };
  let riskFlags = unique(decision.risk_flags || []);
  const intent = decision.intent || 'unknown';
  const knowledge = decision.knowledge_context || {};
  const textos = construirTextosPolitica(decision.organization_context || null);
  const hasFeedback = (decision.feedback_actions || []).length > 0;
  const hasMemory = (decision.memory_actions || []).length > 0;
  const hasReply = Boolean(decision.reply_action?.texto);
  const questionish = parecePregunta(texto);
  const preferenceish = parecePreferenciaFutura(texto);
  const feedbackShort = esFeedbackCorto(texto);

  const digestContextRequired = intent === 'feedback_digest' || hasFeedback || feedbackShort;
  if (!digestContextRequired) {
    riskFlags = removeFlags(riskFlags, ['digest_missing', 'digest_without_items']);
  }

  if (intent === 'trivial') {
    const policy = construirPolicy({
      outcome: 'silence',
      reasons: ['trivial_message'],
      requiresAgent: false,
      shouldReply: false,
      confidence: decision.confidence,
    });
    return aplicarPolicy(sinReply(next), policy, {
      riskFlags: unique([...riskFlags, 'policy_silence_trivial']),
      replyAction: null,
      autoAnswered: true,
    });
  }

  if (intent === 'queja_servicio') {
    next = hasReply ? asegurarAvisoRevision(next, textos.serviceComplaint) : conReply(next, textos.serviceComplaint);
    const policy = construirPolicy({
      outcome: 'handoff_agent',
      reasons: ['service_complaint'],
      requiresAgent: true,
      shouldReply: true,
      shouldStoreMemory: hasMemory,
      priority: 'alta',
      confidence: decision.confidence,
    });
    return aplicarPolicy(next, policy, {
      riskFlags: unique([...riskFlags, 'policy_handoff_required']),
      autoAnswered: false,
    });
  }

  if (intent === 'feedback_digest') {
    if (hasFeedback) {
      const policy = construirPolicy({
        outcome: questionish ? 'record_feedback_with_reply' : 'record_feedback',
        reasons: ['valid_digest_feedback'],
        requiresAgent: false,
        shouldReply: questionish && hasReply,
        shouldStoreMemory: hasMemory,
        shouldFeedback: true,
        confidence: decision.confidence,
      });
      return aplicarPolicy(questionish && hasReply ? next : sinReply(next), policy, {
        riskFlags,
        replyAction: questionish && hasReply ? next.reply_action : null,
        autoAnswered: true,
      });
    }

    next = conReply(next, textos.feedbackClarification);
    const policy = construirPolicy({
      outcome: 'ask_clarification',
      reasons: ['feedback_without_executable_action'],
      requiresAgent: false,
      shouldReply: true,
      shouldStoreMemory: false,
      shouldFeedback: false,
      confidence: Math.min(Number(decision.confidence || 0.5), 0.55),
    });
    riskFlags = removeFlags(riskFlags, ['feedback_digest_without_executable_actions', 'low_confidence']);
    return aplicarPolicy(next, policy, {
      riskFlags: unique([...riskFlags, 'policy_clarification_requested']),
      autoAnswered: true,
    });
  }

  if (intent === 'actualizar_preferencias') {
    next = hasReply ? next : conReply(next, textos.preferenceAck);
    const policy = construirPolicy({
      outcome: 'ack_preference',
      reasons: [preferenceish ? 'explicit_future_preference' : 'memory_update'],
      requiresAgent: false,
      shouldReply: true,
      shouldStoreMemory: hasMemory,
      shouldFeedback: false,
      confidence: decision.confidence,
    });
    return aplicarPolicy(next, policy, {
      riskFlags: removeFlags(riskFlags, ['digest_missing', 'digest_without_items']),
      autoAnswered: true,
    });
  }

  if (intent === 'pregunta_usuario') {
    const autoPermission = evaluarPermisoAutoRespuestaMIA({ decision, texto, perfilOperativo });
    if (autoPermission.allowed) {
      const policy = construirPolicy({
        outcome: 'auto_answer',
        reasons: ['grounded_knowledge_answer'],
        requiresAgent: false,
        shouldReply: true,
        shouldStoreMemory: hasMemory,
        shouldFeedback: false,
        confidence: decision.confidence,
      });
      riskFlags = removeFlags(riskFlags, ['digest_missing', 'digest_without_items', 'low_confidence']);
      return aplicarPolicy(next, policy, {
        riskFlags: unique([...riskFlags, 'policy_auto_answered']),
        autoAnswered: true,
      });
    }

    if (knowledge.answered && !knowledge.needs_agent && hasReply) {
      riskFlags = unique([...riskFlags, ...autoPermission.reasons.map((reason) => `auto_blocked_${reason}`)]);
    }

    if (preguntaDemasiadoVaga(texto, perfilOperativo)) {
      next = conReply(next, textos.clarification);
      const policy = construirPolicy({
        outcome: 'ask_clarification',
        reasons: ['question_too_vague'],
        requiresAgent: false,
        shouldReply: true,
        shouldStoreMemory: true,
        shouldFeedback: false,
        confidence: Math.min(Number(decision.confidence || 0.5), 0.55),
      });
      riskFlags = removeFlags(riskFlags, ['auto_answered_from_knowledge_base', 'knowledge_no_match', 'knowledge_evidence_weak', 'digest_missing', 'digest_without_items', 'low_confidence']);
      return aplicarPolicy(next, policy, {
        riskFlags: unique([...riskFlags, 'policy_clarification_requested']),
        autoAnswered: true,
      });
    }

    riskFlags = removeFlags(riskFlags, ['auto_answered_from_knowledge_base']);
    next = hasReply ? asegurarAvisoRevision(next, textos.agent) : conReply(next, textos.agent);
    const partial = Boolean(knowledge.answered || hasReply);
    const policy = construirPolicy({
      outcome: partial ? 'partial_answer_handoff' : 'handoff_agent',
      reasons: [partial ? 'knowledge_requires_review' : 'answer_requires_agent'],
      requiresAgent: true,
      shouldReply: true,
      shouldStoreMemory: true,
      shouldFeedback: false,
      priority: knowledge.evidence_level === 'baja' ? 'media' : 'normal',
      confidence: decision.confidence,
    });
    return aplicarPolicy(next, policy, {
      riskFlags: unique([...riskFlags, 'policy_handoff_required']),
      autoAnswered: false,
    });
  }

  if (intent === 'unknown') {
    if (questionish || feedbackShort) {
      next = conReply(next, feedbackShort ? textos.feedbackClarification : textos.clarification);
      const policy = construirPolicy({
        outcome: 'ask_clarification',
        reasons: [feedbackShort ? 'short_feedback_without_digest_context' : 'unknown_question'],
        requiresAgent: false,
        shouldReply: true,
        shouldStoreMemory: hasMemory || questionish,
        shouldFeedback: false,
        confidence: Math.min(Number(decision.confidence || 0.5), 0.55),
      });
      riskFlags = removeFlags(riskFlags, ['digest_missing', 'digest_without_items', 'knowledge_no_match', 'low_confidence']);
      return aplicarPolicy(next, policy, {
        riskFlags: unique([...riskFlags, 'policy_clarification_requested']),
        autoAnswered: true,
      });
    }

    if (hasMemory || preferenceish) {
      next = hasReply ? next : conReply(next, textos.preferenceAck);
      const policy = construirPolicy({
        outcome: 'ack_preference',
        reasons: ['unknown_but_memory_useful'],
        requiresAgent: false,
        shouldReply: true,
        shouldStoreMemory: true,
        confidence: decision.confidence,
      });
      return aplicarPolicy(next, policy, {
        riskFlags: removeFlags(riskFlags, ['digest_missing', 'digest_without_items']),
        autoAnswered: true,
      });
    }
  }

  if (intent === 'mensaje_libre') {
    const policy = construirPolicy({
      outcome: hasReply ? 'reply_social' : 'silence',
      reasons: ['free_message'],
      requiresAgent: false,
      shouldReply: hasReply,
      shouldStoreMemory: hasMemory,
      confidence: decision.confidence,
    });
    return aplicarPolicy(hasReply ? next : sinReply(next), policy, {
      riskFlags: removeFlags(riskFlags, ['digest_missing', 'digest_without_items']),
      replyAction: hasReply ? next.reply_action : null,
      autoAnswered: true,
    });
  }

  const finalPolicy = construirPolicy({
    outcome: hasReply ? 'reply_controlled' : 'silence',
    reasons: ['fallback_policy'],
    requiresAgent: false,
    shouldReply: hasReply,
    shouldStoreMemory: hasMemory,
    shouldFeedback: false,
    confidence: decision.confidence,
  });
  return aplicarPolicy(hasReply ? next : sinReply(next), finalPolicy, {
    riskFlags: removeFlags(riskFlags, ['digest_missing', 'digest_without_items']),
    replyAction: hasReply ? next.reply_action : null,
    autoAnswered: true,
  });
}

module.exports = {
  POLICY_VERSION,
  evaluarPoliticaDecisionMIA,
  evaluarPermisoAutoRespuestaMIA,
  respuestaTieneEvidenciaTrazable,
  parecePregunta,
  parecePreferenciaFutura,
  preguntaDemasiadoVaga,
};
