const { evaluarRespuestaMIA } = require('./replyGuard');
const { respuestaTieneEvidenciaTrazable } = require('./policy');

function redondear(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function porcentaje(part, total) {
  if (!total) return 0;
  return redondear((Number(part || 0) / Number(total || 1)) * 100, 2);
}

function contarPor(items = [], fn) {
  return (Array.isArray(items) ? items : []).reduce((acc, item) => {
    const key = fn(item) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getDecisionJson(row = {}) {
  return parseJson(row.decision_json || row);
}

function getPolicy(row = {}) {
  const decision = getDecisionJson(row);
  return decision.policy || row.policy || {};
}

function getKnowledge(row = {}) {
  const decision = getDecisionJson(row);
  return decision.knowledge_context || row.knowledge_context || {};
}

function getReplyText(row = {}, outboxByDecision = new Map()) {
  const decision = getDecisionJson(row);
  const direct = decision.reply_action?.texto || row.reply_text || null;
  if (direct) return String(direct);
  const outbox = outboxByDecision.get(Number(row.id));
  return outbox?.body ? String(outbox.body) : '';
}

function evaluarDecisionRespuesta(row = {}, { outboxByDecision = new Map() } = {}) {
  const decision = getDecisionJson(row);
  const policy = getPolicy(row);
  const knowledge = getKnowledge(row);
  const replyText = getReplyText(row, outboxByDecision);
  const replyAudit = replyText ? evaluarRespuestaMIA(replyText, { decision }) : null;
  const decisionConRespuesta = {
    ...decision,
    knowledge_context: knowledge,
    reply_action: decision.reply_action?.texto
      ? decision.reply_action
      : (replyText ? { canal: 'whatsapp', texto: replyText } : decision.reply_action),
  };
  const flags = [];
  const outcome = policy.outcome || 'unknown';
  const intent = decision.intent || row.intent || 'unknown';
  const confidence = Number(row.confidence ?? decision.confidence ?? 0);
  const answered = Boolean(knowledge.answered);
  const needsAgent = Boolean(knowledge.needs_agent || policy.requires_agent);
  const groundedEvidenceCount = Array.isArray(knowledge.grounded_evidences)
    ? knowledge.grounded_evidences.length
    : 0;
  const matchesCount = Array.isArray(knowledge.matches) ? knowledge.matches.length : 0;

  if (replyAudit?.flags?.length) flags.push(...replyAudit.flags);
  if (outcome === 'auto_answer' && !answered) flags.push('auto_answer_without_knowledge_context');
  if (outcome === 'auto_answer' && answered && groundedEvidenceCount === 0 && matchesCount === 0) {
    flags.push('auto_answer_without_evidence_payload');
  }
  if (outcome === 'auto_answer' && !respuestaTieneEvidenciaTrazable(decisionConRespuesta)) {
    flags.push('auto_answer_without_traceable_evidence');
  }
  if (outcome === 'handoff_agent' && confidence >= 0.8 && answered && !knowledge.needs_agent) {
    flags.push('possible_over_escalation');
  }
  if (outcome === 'auto_answer' && confidence < 0.62) flags.push('low_confidence_auto_answer');
  if (replyText && !outboxByDecision.has(Number(row.id))) flags.push('reply_not_in_outbox_sample');
  if (!replyText && policy.should_reply) flags.push('missing_reply_for_policy');

  return {
    id: row.id || null,
    user_id: row.user_id || decision.user_id || null,
    intent,
    outcome,
    confidence,
    answered,
    needs_agent: needsAgent,
    evidence_level: knowledge.evidence_level || null,
    answer_source: knowledge.answer_source || null,
    reply_present: Boolean(replyText),
    reply_flags: replyAudit?.flags || [],
    flags: [...new Set(flags)],
    created_at: row.created_at || null,
  };
}

function construirRecomendaciones(metrics = {}, breakdown = {}) {
  const recommendations = [];

  if (metrics.sensitive_without_agent > 0) {
    recommendations.push({
      priority: 'alta',
      area: 'safety',
      title: 'Bloquear respuestas sensibles sin revision',
      detail: 'Hay respuestas de pagos, plazos o resoluciones que no pasan por agente. Deben quedar como parcial + handoff.',
    });
  }

  if (metrics.auto_without_evidence > 0) {
    recommendations.push({
      priority: 'alta',
      area: 'evidence',
      title: 'Exigir evidencia visible en auto-respuestas',
      detail: 'Una respuesta automatica debe llevar referencia, enlace o cita de evidencia para ser vendible.',
    });
  }

  if (metrics.reply_guard_flags > 0) {
    recommendations.push({
      priority: 'media',
      area: 'tone',
      title: 'Revisar respuestas corregidas por guardrail',
      detail: 'El guard final esta limpiando tono, nombres o exceso de confianza. Conviene mejorar prompts/policy aguas arriba.',
    });
  }

  if (metrics.possible_over_escalation > 0) {
    recommendations.push({
      priority: 'media',
      area: 'routing',
      title: 'Reducir escalados innecesarios',
      detail: 'Hay preguntas con evidencia y confianza alta que aun acaban en agente. Revisar umbrales.',
    });
  }

  if ((breakdown.outcomes?.auto_answer || 0) === 0 && metrics.total_decisions >= 5) {
    recommendations.push({
      priority: 'media',
      area: 'coverage',
      title: 'Aumentar cobertura de auto-respuesta segura',
      detail: 'MIA no esta respondiendo automaticamente aunque hay trafico. Puede faltar retrieval, embeddings o reglas de confianza.',
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'baja',
      area: 'answers',
      title: 'Respuestas bajo control',
      detail: 'No se ven problemas graves de evidencia, tono o escalado en la muestra.',
    });
  }

  return recommendations;
}

function construirAnswerAuditMIA({
  since = null,
  until = null,
  decisions = [],
  outbox = [],
  agentCases = [],
  availability = {},
} = {}) {
  const outboxByDecision = new Map();
  for (const item of outbox || []) {
    if (item.decision_id) outboxByDecision.set(Number(item.decision_id), item);
  }

  const evaluations = (decisions || []).map((row) => evaluarDecisionRespuesta(row, { outboxByDecision }));
  const flagCounts = {};
  for (const item of evaluations) {
    for (const flag of item.flags) flagCounts[flag] = (flagCounts[flag] || 0) + 1;
  }

  const total = evaluations.length;
  const autoAnswers = evaluations.filter((item) => item.outcome === 'auto_answer').length;
  const handoffs = evaluations.filter((item) => item.needs_agent || item.outcome.includes('handoff')).length;
  const answered = evaluations.filter((item) => item.answered).length;
  const grounded = evaluations.filter((item) => item.answer_source === 'ai_grounded').length;
  const replyGuardFlags = evaluations.filter((item) => item.reply_flags.length > 0).length;
  const evidenceProblemFlags = new Set([
    'auto_answer_without_evidence_payload',
    'auto_answer_without_visible_evidence',
    'auto_answer_without_traceable_evidence',
  ]);

  const metrics = {
    total_decisions: total,
    answered_from_knowledge: answered,
    auto_answers: autoAnswers,
    handoffs,
    grounded_answers: grounded,
    reply_guard_flags: replyGuardFlags,
    auto_without_evidence: evaluations.filter((item) => item.flags.some((flag) => evidenceProblemFlags.has(flag))).length,
    sensitive_without_agent: flagCounts.sensitive_answer_without_agent_review || 0,
    possible_over_escalation: flagCounts.possible_over_escalation || 0,
    missing_reply_for_policy: flagCounts.missing_reply_for_policy || 0,
    open_agent_cases: (agentCases || []).filter((item) => ['open', 'in_progress'].includes(item.status)).length,
  };

  const rates = {
    auto_answer_rate: porcentaje(autoAnswers, total),
    handoff_rate: porcentaje(handoffs, total),
    knowledge_answer_rate: porcentaje(answered, total),
    grounded_answer_rate: porcentaje(grounded, total),
    reply_guard_rate: porcentaje(replyGuardFlags, total),
  };

  const breakdown = {
    intents: contarPor(evaluations, (item) => item.intent),
    outcomes: contarPor(evaluations, (item) => item.outcome),
    evidence_levels: contarPor(evaluations, (item) => item.evidence_level),
    answer_sources: contarPor(evaluations, (item) => item.answer_source),
    flags: flagCounts,
    agent_cases_by_status: contarPor(agentCases, (item) => item.status),
  };

  let score = 100;
  score -= Math.min(30, metrics.sensitive_without_agent * 20);
  score -= Math.min(25, metrics.auto_without_evidence * 12);
  score -= Math.min(16, replyGuardFlags * 4);
  score -= Math.min(14, metrics.missing_reply_for_policy * 8);
  score -= Math.min(10, metrics.possible_over_escalation * 3);
  score = Math.max(0, Math.min(100, redondear(score, 1)));

  return {
    ok: score >= 85,
    since,
    until,
    availability,
    score,
    grade: score >= 90 ? 'enterprise_ready' : score >= 75 ? 'production_ready' : score >= 60 ? 'needs_attention' : 'blocked',
    metrics,
    rates,
    breakdown,
    problematicas: evaluations
      .filter((item) => item.flags.length > 0)
      .sort((a, b) => b.flags.length - a.flags.length || String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 50),
    recommendations: construirRecomendaciones(metrics, breakdown),
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

async function generarAnswerAuditMIA(supabase, { hours = 72, limit = 500 } = {}) {
  const safeHours = Math.max(1, Math.min(720, Number(hours) || 72));
  const safeLimit = Math.max(50, Math.min(3000, Number(limit) || 500));
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();

  const [decisions, outbox, agentCases] = await Promise.all([
    selectSeguro(supabase, 'mia_decisions', 'id, user_id, intent, confidence, risk_flags, decision_json, result_json, created_at', { since, limit: safeLimit }),
    selectSeguro(supabase, 'mia_outbox', 'id, decision_id, user_id, status, body, attempts, last_error, created_at, updated_at', { since, limit: safeLimit }),
    selectSeguro(supabase, 'mia_agent_cases', 'id, user_id, decision_id, status, priority, reason, created_at, updated_at, closed_at', { since, limit: safeLimit }),
  ]);

  return construirAnswerAuditMIA({
    since,
    until,
    decisions: decisions.data,
    outbox: outbox.data,
    agentCases: agentCases.data,
    availability: {
      mia_decisions: decisions.available,
      mia_outbox: outbox.available,
      mia_agent_cases: agentCases.available,
    },
  });
}

module.exports = {
  construirAnswerAuditMIA,
  evaluarDecisionRespuesta,
  generarAnswerAuditMIA,
};
