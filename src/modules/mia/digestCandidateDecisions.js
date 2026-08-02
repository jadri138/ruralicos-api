const { construirLifecycleHold } = require('../digest/decisionHoldRetry');

function texto(value, max = 500) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
}

function actionFromDecision(decision = {}) {
  if (decision.action) return texto(decision.action, 60);
  if (['SEND_NOW', 'ADD_TO_DIGEST'].includes(decision.decision)) return 'include';
  if (decision.decision === 'HOLD_FOR_EVIDENCE') return 'hold';
  if (decision.decision === 'BLOCKED') return 'blocked';
  if (decision.decision === 'DROP') return 'exclude';
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

  const decisionState = input.decision_state ?? input.decisionState ?? decision.decision;
  if (decisionState) row.decision_state = texto(decisionState, 40);
  const contractVersion = input.contract_version ?? input.contractVersion ?? decision.contract_version;
  if (contractVersion) row.contract_version = texto(contractVersion, 80);
  const policyVersion = input.policy_version ?? input.policyVersion ?? decision.policy_version;
  if (policyVersion) row.policy_version = texto(policyVersion, 80);
  const judgeVersion = input.judge_version ?? input.judgeVersion ?? decision.judge_version;
  if (judgeVersion) row.judge_version = texto(judgeVersion, 80);
  const promptVersion = input.prompt_version ?? input.promptVersion ?? decision.prompt_version;
  if (promptVersion) row.prompt_version = texto(promptVersion, 80);
  const inputHash = input.input_hash ?? input.inputHash ?? decision.input_hash;
  if (inputHash) row.input_hash = texto(inputHash, 128);
  const reasonCodes = input.reason_codes ?? input.reasonCodes ?? decision.reason_codes;
  if (Array.isArray(reasonCodes)) row.reason_codes = [...new Set(reasonCodes.map(String))];
  const decidedAt = input.decided_at ?? input.decidedAt ?? decision.decided_at;
  if (decidedAt) row.decided_at = decidedAt;

  if (row.stage === 'personal_relevance_judge') {
    const lifecycle = construirLifecycleHold({
      ...decision,
      decision: decisionState,
      reason_codes: reasonCodes,
      input_hash: inputHash,
    }, { now: row.updated_at });
    Object.assign(row, {
      hold_status: lifecycle.hold_status || null,
      hold_attempts: lifecycle.hold_attempts
        ?? Math.max(0, Number(decision.hold_retry_attempt) || 0),
      hold_next_at: lifecycle.hold_next_at || null,
      hold_last_at: lifecycle.hold_last_at || row.updated_at,
      hold_claim_token: null,
      hold_claimed_at: null,
      hold_resolution_json: lifecycle.hold_resolution_json || {},
    });
  }

  const judgeAudit = jsonObject(input.judge_audit ?? input.judgeAudit ?? decision.judge_audit);
  const cachedFrom = jsonObject(judgeAudit.cached_from);
  const llmModel = input.llm_model
    ?? input.llmModel
    ?? decision.llm_model
    ?? judgeAudit.model
    ?? cachedFrom.model;
  if (llmModel) row.llm_model = texto(llmModel, 80);
  const llmUsage = jsonObject(input.llm_usage ?? input.llmUsage ?? decision.llm_usage ?? judgeAudit.usage);
  if (Object.keys(llmUsage).length > 0) row.llm_usage = llmUsage;
  const llmCost = jsonObject(input.llm_cost ?? input.llmCost ?? decision.llm_cost ?? judgeAudit.cost);
  if (Object.keys(llmCost).length > 0) row.llm_cost = llmCost;
  const llmCalls = nonNegativeInteger(
    input.llm_calls ?? input.llmCalls ?? decision.llm_calls ?? judgeAudit.llm_calls
  );
  if (llmCalls !== null) row.llm_calls = llmCalls;
  const cacheHit = input.cache_hit ?? input.cacheHit ?? decision.cache_hit ?? judgeAudit.cache_hit;
  if (cacheHit !== undefined && cacheHit !== null) row.cache_hit = cacheHit === true;
  const fallbackReason = input.fallback_reason
    ?? input.fallbackReason
    ?? decision.fallback_reason
    ?? judgeAudit.fallback;
  if (fallbackReason) row.fallback_reason = texto(fallbackReason, 80);
  return row;
}

function construirDigestCandidateDecisionRows(input = {}) {
  return (Array.isArray(input.decisions) ? input.decisions : [])
    .map((decision) => construirDigestCandidateDecisionRow({ ...input, decision }))
    .filter(Boolean);
}

const REQUIRED_CANONICAL_AUDIT_STAGES = Object.freeze([
  'fact_sheet_preselection',
  'personal_relevance_judge',
  'auto_send_gate',
  'final_validation',
  'effective_send_gate',
]);

const REQUIRED_CANONICAL_AUDIT_STAGE_SET = new Set(REQUIRED_CANONICAL_AUDIT_STAGES);

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

async function registrarDigestCandidateDecisionsCanonicas(supabase, input = {}) {
  const stage = texto(input.stage, 80);
  if (!REQUIRED_CANONICAL_AUDIT_STAGE_SET.has(stage)) {
    const error = new Error(`Etapa de auditoria canonica no reconocida: ${stage || 'ausente'}`);
    error.code = 'CANONICAL_DECISION_AUDIT_STAGE_INVALID';
    error.stage = stage || null;
    throw error;
  }

  const result = await registrarDigestCandidateDecisions(supabase, input);
  const submitted = Array.isArray(input.decisions) ? input.decisions.length : 0;
  const expected = Array.isArray(result.rows) ? result.rows.length : 0;
  if (
    !result.ok
    || !result.available
    || expected === 0
    || expected !== submitted
    || result.stored !== expected
  ) {
    const error = new Error(`No se pudo guardar la auditoria canonica de ${stage}`);
    error.code = 'CANONICAL_DECISION_AUDIT_FAILED';
    error.stage = stage;
    error.audit_error = result.error
      || (expected === 0 ? 'canonical_audit_empty' : 'canonical_audit_incomplete');
    throw error;
  }
  return result;
}

async function cargarCacheDecisionesJuez(supabase, {
  inputHashes = [],
  compatibility = {},
} = {}) {
  const hashes = [...new Set((Array.isArray(inputHashes) ? inputHashes : [])
    .map((value) => texto(value, 128))
    .filter(Boolean))].slice(0, 100);
  const required = [
    compatibility.contract_version,
    compatibility.policy_version,
    compatibility.judge_version,
    compatibility.prompt_version,
    compatibility.model,
  ];
  if (!supabase?.from || hashes.length === 0 || required.some((value) => !value)) return new Map();

  try {
    const { data, error } = await supabase
      .from('digest_candidate_decisions')
      .select([
        'input_hash',
        'contract_version',
        'policy_version',
        'judge_version',
        'prompt_version',
        'llm_model',
        'decision_json',
        'decided_at',
      ].join(', '))
      .eq('stage', 'personal_relevance_judge')
      .eq('contract_version', compatibility.contract_version)
      .eq('policy_version', compatibility.policy_version)
      .eq('judge_version', compatibility.judge_version)
      .eq('prompt_version', compatibility.prompt_version)
      .eq('llm_model', compatibility.model)
      .in('input_hash', hashes)
      .order('decided_at', { ascending: false })
      .limit(Math.min(500, Math.max(hashes.length * 4, hashes.length)));
    if (error) throw error;

    const cache = new Map();
    for (const row of data || []) {
      if (!row?.input_hash || cache.has(row.input_hash)) continue;
      const stored = jsonObject(row.decision_json);
      const audit = jsonObject(stored.judge_audit);
      const originalReusable = audit.cache_hit !== true
        && audit.fallback == null
        && audit.second_opinion !== true
        && Number(audit.llm_calls) === 1;
      const chainedReusable = audit.cache_hit === true
        && jsonObject(audit.cached_from).reusable === true;
      if (!originalReusable && !chainedReusable) continue;
      const decision = jsonObject(stored.judge);
      if (Object.keys(decision).length === 0) continue;
      if (decision.decision === 'HOLD_FOR_EVIDENCE') continue;
      cache.set(row.input_hash, {
        input_hash: row.input_hash,
        contract_version: row.contract_version,
        policy_version: row.policy_version,
        judge_version: row.judge_version,
        prompt_version: row.prompt_version,
        model: row.llm_model,
        decision,
        decided_at: row.decided_at || null,
      });
    }
    return cache;
  } catch {
    // Compatible con despliegues donde el codigo llega antes que la migracion.
    return new Map();
  }
}

module.exports = {
  REQUIRED_CANONICAL_AUDIT_STAGES,
  actionFromDecision,
  construirDigestCandidateDecisionRow,
  construirDigestCandidateDecisionRows,
  registrarDigestCandidateDecisions,
  registrarDigestCandidateDecisionsCanonicas,
  vincularDigestCandidateDecisions,
  cargarCacheDecisionesJuez,
};
