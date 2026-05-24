const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);
const { conOrganizationId } = require('./organizationContext');

function esTablaNoDisponible(error) {
  return MISSING_TABLE_CODES.has(error?.code);
}

function construirAccionesDesdeDecision({
  decision = {},
  userId,
  digestId = null,
  inboundId = null,
  organizationId = null,
}) {
  const acciones = [];

  for (const feedback of decision.feedback_actions || []) {
    acciones.push(conOrganizationId({
      user_id: userId,
      digest_id: digestId,
      inbound_id: inboundId,
      action_type: 'feedback_digest',
      status: 'planned',
      action_json: feedback,
    }, organizationId));
  }

  for (const memoria of decision.memory_actions || []) {
    acciones.push(conOrganizationId({
      user_id: userId,
      digest_id: digestId,
      inbound_id: inboundId,
      action_type: 'memory',
      status: 'planned',
      action_json: memoria,
    }, organizationId));
  }

  if (decision.reply_action) {
    acciones.push(conOrganizationId({
      user_id: userId,
      digest_id: digestId,
      inbound_id: inboundId,
      action_type: 'reply',
      status: 'planned',
      action_json: decision.reply_action,
    }, organizationId));
  }

  const autoAnswered = Boolean(decision.auto_answered) ||
    (decision.risk_flags || []).includes('auto_answered_from_knowledge_base');
  const requiereAgente = decision.policy?.requires_agent === true
    ? true
    : decision.policy?.requires_agent === false
      ? false
      : (
        (!autoAnswered && decision.intent === 'pregunta_usuario') ||
        decision.intent === 'queja_servicio' ||
        (decision.risk_flags || []).some((flag) => [
          'low_confidence',
          'feedback_digest_without_executable_actions',
          'digest_missing',
          'knowledge_partial_answer',
          'knowledge_no_match',
          'knowledge_lookup_failed',
          'knowledge_evidence_weak',
          'policy_handoff_required',
        ].includes(flag))
      );

  if (requiereAgente) {
    acciones.push(conOrganizationId({
      user_id: userId,
      digest_id: digestId,
      inbound_id: inboundId,
      action_type: 'handoff_agent',
      status: 'planned',
      action_json: {
        intent: decision.intent || 'unknown',
        confidence: decision.confidence ?? null,
        risk_flags: decision.risk_flags || [],
        summary: decision.summary || null,
        policy: decision.policy || null,
      },
    }, organizationId));
  }

  if (acciones.length === 0) {
    acciones.push(conOrganizationId({
      user_id: userId,
      digest_id: digestId,
      inbound_id: inboundId,
      action_type: 'none',
      status: 'skipped',
      action_json: { reason: 'decision_without_actions', intent: decision.intent || 'unknown' },
    }, organizationId));
  }

  return acciones;
}

async function registrarDecisionMIA(supabase, {
  inboundId = null,
  userId,
  digestId = null,
  conversationId = null,
  organizationId = null,
  decision,
}) {
  const row = conOrganizationId({
    inbound_id: inboundId,
    user_id: userId,
    digest_id: digestId,
    conversation_id: conversationId,
    decision_version: decision.version || null,
    intent: decision.intent || 'unknown',
    confidence: Number(decision.confidence || 0),
    risk_flags: decision.risk_flags || [],
    summary: decision.summary || null,
    decision_json: decision,
  }, organizationId);

  try {
    const { data, error } = await supabase
      .from('mia_decisions')
      .insert(row)
      .select('id')
      .single();

    if (error) throw error;
    return { ok: true, available: true, id: data?.id || null };
  } catch (error) {
    if (esTablaNoDisponible(error)) {
      return { ok: true, available: false, id: null, reason: 'mia_decisions_no_disponible' };
    }

    console.warn('[mia:decision_store] No se pudo registrar decision:', error.message);
    return { ok: false, available: false, id: null, error: error.message };
  }
}

async function registrarAccionesMIA(supabase, { decisionId = null, acciones = [] }) {
  if (!decisionId || acciones.length === 0) {
    return { ok: true, available: Boolean(decisionId), inserted: 0 };
  }

  const rows = acciones.map((accion) => ({
    ...accion,
    decision_id: decisionId,
  }));

  try {
    const { error } = await supabase
      .from('mia_actions')
      .insert(rows);

    if (error) throw error;
    return { ok: true, available: true, inserted: rows.length };
  } catch (error) {
    if (esTablaNoDisponible(error)) {
      return { ok: true, available: false, inserted: 0, reason: 'mia_actions_no_disponible' };
    }

    console.warn('[mia:decision_store] No se pudieron registrar acciones:', error.message);
    return { ok: false, available: false, inserted: 0, error: error.message };
  }
}

async function registrarDecisionYAccionesMIA(supabase, options = {}) {
  const decisionResult = await registrarDecisionMIA(supabase, options);
  const acciones = construirAccionesDesdeDecision({
    decision: options.decision,
    userId: options.userId,
    digestId: options.digestId,
    inboundId: options.inboundId,
    organizationId: options.organizationId,
  });

  const accionesResult = await registrarAccionesMIA(supabase, {
    decisionId: decisionResult.id,
    acciones,
  });

  return {
    ok: decisionResult.ok && accionesResult.ok,
    available: decisionResult.available && accionesResult.available,
    decision_id: decisionResult.id,
    actions_planned: acciones.length,
    actions_inserted: accionesResult.inserted,
    errors: [decisionResult.error, accionesResult.error].filter(Boolean),
  };
}

async function actualizarDecisionResultadoMIA(supabase, decisionId, resultJson = {}) {
  if (!decisionId) return false;

  try {
    const { error } = await supabase
      .from('mia_decisions')
      .update({
        result_json: resultJson,
        updated_at: new Date().toISOString(),
      })
      .eq('id', decisionId);

    if (error) throw error;
    return true;
  } catch (error) {
    if (!esTablaNoDisponible(error)) {
      console.warn('[mia:decision_store] No se pudo actualizar resultado decision:', error.message);
    }
    return false;
  }
}

async function actualizarAccionesPorTipoMIA(supabase, {
  decisionId,
  actionType,
  status,
  resultJson = {},
  errorMsg = null,
}) {
  if (!decisionId || !actionType || !status) return false;

  try {
    const { error } = await supabase
      .from('mia_actions')
      .update({
        status,
        result_json: resultJson,
        error_msg: errorMsg ? String(errorMsg).slice(0, 1000) : null,
        executed_at: ['executed', 'failed', 'skipped'].includes(status) ? new Date().toISOString() : null,
      })
      .eq('decision_id', decisionId)
      .eq('action_type', actionType);

    if (error) throw error;
    return true;
  } catch (error) {
    if (!esTablaNoDisponible(error)) {
      console.warn('[mia:decision_store] No se pudieron actualizar acciones:', error.message);
    }
    return false;
  }
}

module.exports = {
  construirAccionesDesdeDecision,
  registrarDecisionYAccionesMIA,
  actualizarDecisionResultadoMIA,
  actualizarAccionesPorTipoMIA,
};
