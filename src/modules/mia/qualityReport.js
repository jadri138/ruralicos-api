const RISK_WEIGHTS = {
  knowledge_lookup_failed: 18,
  digest_missing: 16,
  knowledge_no_match: 12,
  low_confidence: 10,
  feedback_digest_without_executable_actions: 9,
  knowledge_evidence_weak: 6,
  auto_blocked_missing_traceable_evidence: 8,
  auto_blocked_reply_missing: 6,
  auto_blocked_confidence_below_auto_threshold: 4,
  auto_blocked_sensitive_question_requires_review: 2,
  knowledge_partial_answer: 4,
  policy_handoff_required: 4,
  policy_clarification_requested: 1,
};

function porcentaje(part, total) {
  if (!total) return 0;
  return Number(((Number(part || 0) / Number(total || 1)) * 100).toFixed(2));
}

function contarPor(items = [], fn) {
  return (Array.isArray(items) ? items : []).reduce((acc, item) => {
    const key = fn(item) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function flagsDecision(decision = {}) {
  const direct = Array.isArray(decision.risk_flags) ? decision.risk_flags : [];
  const nested = Array.isArray(decision.decision_json?.risk_flags)
    ? decision.decision_json.risk_flags
    : [];
  return [...new Set([...direct, ...nested].filter(Boolean))];
}

function knowledgeContext(decision = {}) {
  return decision.decision_json?.knowledge_context || decision.knowledge_context || {};
}

function policyContext(decision = {}) {
  return decision.decision_json?.policy || decision.policy || {};
}

function decisionAutoRespondida(decision = {}) {
  const policy = policyContext(decision);
  if (policy.outcome) {
    return Boolean(decision.decision_json?.auto_answered) || policy.outcome === 'auto_answer';
  }
  return Boolean(decision.decision_json?.auto_answered) ||
    flagsDecision(decision).includes('auto_answered_from_knowledge_base');
}

function redondear(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function construirRecomendacionesMIA(metrics = {}, rates = {}, breakdown = {}) {
  const recomendaciones = [];

  if (metrics.inbound_failed > 0) {
    recomendaciones.push({
      priority: 'alta',
      area: 'inbound',
      title: 'Revisar mensajes entrantes fallidos',
      detail: 'Hay mensajes de WhatsApp que no terminan el flujo MIA. Conviene mirar error_msg y webhook_events.',
    });
  }

  if (metrics.outbox_failed > 0) {
    recomendaciones.push({
      priority: 'alta',
      area: 'outbox',
      title: 'Resolver respuestas pendientes o fallidas',
      detail: 'MIA tiene respuestas en outbox fallidas. Para producto B2B esto debe estar en cero o con reintento controlado.',
    });
  }

  if (metrics.actions_failed > 0) {
    recomendaciones.push({
      priority: 'alta',
      area: 'actions',
      title: 'Auditar acciones fallidas',
      detail: 'Alguna accion planificada no se ejecuto. Puede afectar feedback, memoria, respuestas o handoff.',
    });
  }

  if (rates.handoff_rate >= 45 && metrics.decisions_total >= 5) {
    recomendaciones.push({
      priority: 'media',
      area: 'knowledge',
      title: 'Reducir escalados con mejor base de conocimiento',
      detail: 'MIA esta derivando muchas conversaciones a agente. Hay que revisar intents, evidencia y respuestas parciales.',
    });
  }

  if ((breakdown.risk_flags?.knowledge_no_match || 0) > 0) {
    recomendaciones.push({
      priority: 'media',
      area: 'retrieval',
      title: 'Mejorar cobertura de busqueda',
      detail: 'Aparecen preguntas sin evidencia suficiente. Revisar embeddings, RPC semantica y sinonimos del dominio.',
    });
  }

  if ((breakdown.risk_flags?.auto_blocked_missing_traceable_evidence || 0) > 0) {
    recomendaciones.push({
      priority: 'media',
      area: 'evidence',
      title: 'Mejorar citas visibles en respuestas',
      detail: 'MIA encontro una posible respuesta, pero no la pudo enviar sola porque faltaba evidencia trazable en el texto.',
    });
  }

  if (metrics.knowledge_answered > 0 && metrics.ai_grounded_answers === 0) {
    recomendaciones.push({
      priority: 'media',
      area: 'answering',
      title: 'Activar redaccion grounded si procede',
      detail: 'Hay respuestas desde base Ruralicos, pero ninguna marcada como ai_grounded. Puede estar usando fallback por falta de OPENAI_API_KEY o guardrails.',
    });
  }

  if (metrics.decisions_total === 0) {
    recomendaciones.push({
      priority: 'media',
      area: 'traffic',
      title: 'Sin decisiones MIA en el periodo',
      detail: 'No hay suficiente actividad para medir calidad. Probar con mensajes reales y replay controlado.',
    });
  }

  if (recomendaciones.length === 0) {
    recomendaciones.push({
      priority: 'baja',
      area: 'quality',
      title: 'Sistema estable en el periodo',
      detail: 'No se ven fallos criticos. El siguiente paso es revisar conversaciones manualmente y calibrar tono/cobertura.',
    });
  }

  return recomendaciones;
}

function calcularQualityScoreMIA(metrics = {}, rates = {}, breakdown = {}) {
  let score = 100;
  const rate = (key) => Number.isFinite(Number(rates[key])) ? Number(rates[key]) : 0;
  score -= Math.min(30, rate('inbound_failed_rate') * 1.5);
  score -= Math.min(24, rate('outbox_failed_rate') * 1.4);
  score -= Math.min(18, rate('actions_failed_rate') * 1.2);
  score -= Math.min(16, rate('agent_open_rate') * 0.45);
  score -= Math.max(0, 65 - Number(metrics.avg_confidence || 0) * 100) * 0.35;

  for (const [flag, count] of Object.entries(breakdown.risk_flags || {})) {
    score -= Math.min(18, Number(count || 0) * (RISK_WEIGHTS[flag] || 2));
  }

  return Math.max(0, Math.min(100, redondear(score, 1)));
}

function calidadPorScore(score) {
  if (score >= 90) return 'enterprise_ready';
  if (score >= 75) return 'pilot_ready';
  if (score >= 60) return 'needs_attention';
  return 'blocked';
}

function construirQualityReportMIA({
  since = null,
  until = null,
  inbound = [],
  decisions = [],
  actions = [],
  outbox = [],
  agentCases = [],
  availability = {},
} = {}) {
  const riskFlags = {};
  const answerSources = {};
  const policyOutcomes = {};
  let confidenceSum = 0;
  let confidenceCount = 0;
  let knowledgeAnswered = 0;
  let knowledgeNeedsAgent = 0;
  let autoAnswered = 0;

  for (const decision of decisions || []) {
    const confidence = Number(decision.confidence ?? decision.decision_json?.confidence);
    if (Number.isFinite(confidence)) {
      confidenceSum += confidence;
      confidenceCount++;
    }

    for (const flag of flagsDecision(decision)) {
      riskFlags[flag] = (riskFlags[flag] || 0) + 1;
    }

    if (decisionAutoRespondida(decision)) autoAnswered++;

    const context = knowledgeContext(decision);
    if (context?.answered) knowledgeAnswered++;
    if (context?.needs_agent) knowledgeNeedsAgent++;
    if (context?.answer_source) {
      answerSources[context.answer_source] = (answerSources[context.answer_source] || 0) + 1;
    }

    const policy = policyContext(decision);
    if (policy?.outcome) {
      policyOutcomes[policy.outcome] = (policyOutcomes[policy.outcome] || 0) + 1;
    }
  }

  const inboundTotal = inbound.length;
  const decisionsTotal = decisions.length;
  const actionsTotal = actions.length;
  const outboxTotal = outbox.length;
  const agentTotal = agentCases.length;

  const inboundByStatus = contarPor(inbound, (item) => item.status || (item.processed ? 'processed' : 'unknown'));
  const decisionsByIntent = contarPor(decisions, (item) => item.intent || item.decision_json?.intent);
  const actionsByStatus = contarPor(actions, (item) => item.status);
  const actionsByType = contarPor(actions, (item) => item.action_type);
  const outboxByStatus = contarPor(outbox, (item) => item.status);
  const agentByStatus = contarPor(agentCases, (item) => item.status);
  const agentByPriority = contarPor(agentCases, (item) => item.priority);

  const metrics = {
    inbound_total: inboundTotal,
    inbound_processed: inboundByStatus.processed || 0,
    inbound_failed: inboundByStatus.failed || 0,
    inbound_ignored: inboundByStatus.ignored || 0,
    decisions_total: decisionsTotal,
    avg_confidence: confidenceCount ? redondear(confidenceSum / confidenceCount, 3) : 0,
    auto_answered: autoAnswered,
    knowledge_answered: knowledgeAnswered,
    knowledge_needs_agent: knowledgeNeedsAgent,
    ai_grounded_answers: answerSources.ai_grounded || 0,
    actions_total: actionsTotal,
    actions_failed: actionsByStatus.failed || 0,
    handoff_actions: actionsByType.handoff_agent || 0,
    outbox_total: outboxTotal,
    outbox_failed: outboxByStatus.failed || 0,
    outbox_pending: (outboxByStatus.queued || 0) + (outboxByStatus.sending || 0),
    agent_cases_total: agentTotal,
    agent_cases_open: (agentByStatus.open || 0) + (agentByStatus.in_progress || 0),
    agent_cases_high_priority: (agentCases || []).filter((item) => item.priority === 'alta').length,
  };

  const rates = {
    inbound_failed_rate: porcentaje(metrics.inbound_failed, inboundTotal),
    action_failure_rate: porcentaje(metrics.actions_failed, actionsTotal),
    actions_failed_rate: porcentaje(metrics.actions_failed, actionsTotal),
    outbox_failed_rate: porcentaje(metrics.outbox_failed, outboxTotal),
    handoff_rate: porcentaje(metrics.handoff_actions, Math.max(decisionsTotal, 1)),
    auto_answer_rate: porcentaje(metrics.auto_answered, decisionsTotal),
    knowledge_answer_rate: porcentaje(metrics.knowledge_answered, decisionsTotal),
    agent_open_rate: porcentaje(metrics.agent_cases_open, Math.max(decisionsTotal, 1)),
  };

  const breakdown = {
    inbound_by_status: inboundByStatus,
    decisions_by_intent: decisionsByIntent,
    risk_flags: riskFlags,
    answer_sources: answerSources,
    policy_outcomes: policyOutcomes,
    actions_by_status: actionsByStatus,
    actions_by_type: actionsByType,
    outbox_by_status: outboxByStatus,
    agent_cases_by_status: agentByStatus,
    agent_cases_by_priority: agentByPriority,
  };

  const qualityScore = calcularQualityScoreMIA(metrics, rates, breakdown);
  const recommendations = construirRecomendacionesMIA(metrics, rates, breakdown);

  return {
    since,
    until,
    availability,
    score: qualityScore,
    grade: calidadPorScore(qualityScore),
    metrics,
    rates,
    breakdown,
    recommendations,
  };
}

async function selectSeguro(supabase, table, select, { since, limit = 500 } = {}) {
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return { available: true, data: data || [] };
}

async function generarQualityReportMIA(supabase, { hours = 24, limit = 500 } = {}) {
  const safeHours = Math.max(1, Math.min(720, Number(hours) || 24));
  const safeLimit = Math.max(50, Math.min(2000, Number(limit) || 500));
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();

  const [inbound, decisions, actions, outbox, agentCases] = await Promise.all([
    selectSeguro(supabase, 'mia_inbound_messages', 'id, status, ignored_reason, error_msg, created_at', { since, limit: safeLimit }),
    selectSeguro(supabase, 'mia_decisions', 'id, intent, confidence, risk_flags, decision_json, result_json, created_at', { since, limit: safeLimit }),
    selectSeguro(supabase, 'mia_actions', 'id, action_type, status, error_msg, created_at', { since, limit: safeLimit }),
    selectSeguro(supabase, 'mia_outbox', 'id, status, attempts, last_error, created_at', { since, limit: safeLimit }),
    selectSeguro(supabase, 'mia_agent_cases', 'id, status, priority, reason, created_at', { since, limit: safeLimit }),
  ]);

  return construirQualityReportMIA({
    since,
    until,
    inbound: inbound.data,
    decisions: decisions.data,
    actions: actions.data,
    outbox: outbox.data,
    agentCases: agentCases.data,
    availability: {
      mia_inbound_messages: inbound.available,
      mia_decisions: decisions.available,
      mia_actions: actions.available,
      mia_outbox: outbox.available,
      mia_agent_cases: agentCases.available,
    },
  });
}

module.exports = {
  construirQualityReportMIA,
  generarQualityReportMIA,
  calcularQualityScoreMIA,
  calidadPorScore,
};
