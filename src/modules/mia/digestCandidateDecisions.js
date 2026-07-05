function texto(value, max = 500) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function actionFromDecision(decision = {}) {
  if (decision.action) return texto(decision.action, 60);
  if (decision.status === 'send') return 'include';
  if (decision.status === 'review_only') return 'review_only';
  if (decision.status === 'blocked') return 'blocked';
  return decision.incluir === true ? 'include' : 'exclude';
}

function alertIdFromDecision(decision = {}) {
  return decision.alerta_id ?? decision.id ?? decision.alerta?.id ?? null;
}

function construirDigestCandidateDecisionRow(input = {}) {
  const decision = jsonObject(input.decision);
  const userId = input.user_id ?? input.userId;
  const alertaId = input.alerta_id ?? input.alertaId ?? alertIdFromDecision(decision);
  if (!userId || !alertaId || !input.fecha || !input.stage) return null;

  const row = {
    user_id: userId,
    alerta_id: alertaId,
    fecha: input.fecha,
    kind: texto(input.kind || 'daily', 60) || 'daily',
    stage: texto(input.stage, 80),
    action: texto(input.action || actionFromDecision(decision), 60) || 'unknown',
    score: Number.isFinite(Number(input.score ?? decision.score))
      ? Number(input.score ?? decision.score)
      : null,
    risk: texto(input.risk ?? decision.riesgo ?? decision.riesgo_de_ruido, 60),
    reason: texto(input.reason ?? decision.motivo ?? decision.reason, 500),
    decision_json: decision,
    metadata_json: jsonObject(input.metadata),
    updated_at: new Date().toISOString(),
  };

  const optional = [
    ['organization_id', input.organization_id ?? input.organizationId],
    ['digest_id', input.digest_id ?? input.digestId],
    ['digest_attempt_id', input.digest_attempt_id ?? input.digestAttemptId],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined && value !== null && value !== '') row[key] = value;
  }
  return row;
}

function construirDigestCandidateDecisionRows(input = {}) {
  return (Array.isArray(input.decisions) ? input.decisions : [])
    .map((decision) => construirDigestCandidateDecisionRow({ ...input, decision }))
    .filter(Boolean);
}

async function registrarDigestCandidateDecisions(supabase, input = {}) {
  const rows = construirDigestCandidateDecisionRows(input);
  if (!supabase?.from || rows.length === 0) {
    return { ok: true, available: Boolean(supabase?.from), stored: 0, rows };
  }

  try {
    const { error } = await supabase
      .from('digest_candidate_decisions')
      .upsert(rows, { onConflict: 'user_id,fecha,kind,alerta_id,stage' });
    if (error) throw error;
    return { ok: true, available: true, stored: rows.length, rows };
  } catch (error) {
    console.warn('[digest_candidate_decisions] No se pudo guardar auditoria:', error.message);
    return { ok: false, available: false, stored: 0, error: error.message, rows };
  }
}

async function vincularDigestCandidateDecisions(supabase, {
  userId,
  fecha,
  kind = 'daily',
  digestId,
  digestAttemptId = null,
} = {}) {
  if (!supabase?.from || !userId || !fecha || !digestId) {
    return { ok: false, available: false, reason: 'invalid_candidate_decision_link' };
  }

  const patch = { digest_id: digestId, updated_at: new Date().toISOString() };
  if (digestAttemptId) patch.digest_attempt_id = digestAttemptId;

  try {
    const { error } = await supabase
      .from('digest_candidate_decisions')
      .update(patch)
      .eq('user_id', userId)
      .eq('fecha', fecha)
      .eq('kind', kind);
    if (error) throw error;
    return { ok: true, available: true };
  } catch (error) {
    return { ok: false, available: false, error: error.message };
  }
}

module.exports = {
  actionFromDecision,
  construirDigestCandidateDecisionRow,
  construirDigestCandidateDecisionRows,
  registrarDigestCandidateDecisions,
  vincularDigestCandidateDecisions,
};
