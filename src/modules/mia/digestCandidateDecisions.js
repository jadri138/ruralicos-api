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

  // Columnas de ámbito de la llamada: valen lo mismo para todas las filas del
  // lote, así que incluirlas u omitirlas nunca rompe la uniformidad.
  const optional = [
    ['organization_id', input.organization_id ?? input.organizationId],
    ['digest_id', input.digest_id ?? input.digestId],
    ['digest_attempt_id', input.digest_attempt_id ?? input.digestAttemptId],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined && value !== null && value !== '') row[key] = value;
  }

  // Columnas que dependen de CADA decisión. Van siempre, aunque valgan null:
  // PostgREST construye el INSERT con la unión de claves de todas las filas del
  // lote y a la que le falte una se la manda como NULL, no con su DEFAULT. Una
  // sola fila incompleta tumbaba la auditoría de esa persona -es el origen del
  // error `null value in column "llm_calls"` del 5-08-2026-.
  const reasonCodes = input.reason_codes ?? input.reasonCodes ?? decision.reason_codes;
  Object.assign(row, {
    decision_state: texto(input.decision_state ?? input.decisionState ?? decision.decision, 40),
    contract_version: texto(input.contract_version ?? input.contractVersion ?? decision.contract_version, 80),
    policy_version: texto(input.policy_version ?? input.policyVersion ?? decision.policy_version, 80),
    judge_version: texto(input.judge_version ?? input.judgeVersion ?? decision.judge_version, 80),
    prompt_version: texto(input.prompt_version ?? input.promptVersion ?? decision.prompt_version, 80),
    input_hash: texto(input.input_hash ?? input.inputHash ?? decision.input_hash, 128),
    reason_codes: Array.isArray(reasonCodes) ? [...new Set(reasonCodes.map(String))] : [],
    decided_at: input.decided_at ?? input.decidedAt ?? decision.decided_at ?? null,
  });

  if (row.stage === 'personal_relevance_judge') {
    const lifecycle = construirLifecycleHold({
      ...decision,
      decision: row.decision_state,
      reason_codes: row.reason_codes,
      input_hash: row.input_hash,
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
  const llmUsage = jsonObject(input.llm_usage ?? input.llmUsage ?? decision.llm_usage ?? judgeAudit.usage);
  const llmCost = jsonObject(input.llm_cost ?? input.llmCost ?? decision.llm_cost ?? judgeAudit.cost);
  // `llm_calls` y `cache_hit` son NOT NULL. Una candidata bloqueada por el
  // ranking no pasa por el juez y no trae ninguno de los dos: sin este valor por
  // defecto, un lote que mezclara bloqueadas y evaluadas tumbaba la auditoría de
  // esa persona (24 usuarios el 5-08-2026).
  const llmCalls = nonNegativeInteger(
    input.llm_calls ?? input.llmCalls ?? decision.llm_calls ?? judgeAudit.llm_calls
  );
  Object.assign(row, {
    llm_model: texto(
      input.llm_model ?? input.llmModel ?? decision.llm_model ?? judgeAudit.model ?? cachedFrom.model,
      80
    ),
    llm_usage: Object.keys(llmUsage).length > 0 ? llmUsage : null,
    llm_cost: Object.keys(llmCost).length > 0 ? llmCost : null,
    llm_calls: llmCalls ?? 0,
    cache_hit: (input.cache_hit ?? input.cacheHit ?? decision.cache_hit ?? judgeAudit.cache_hit) === true,
    fallback_reason: texto(
      input.fallback_reason ?? input.fallbackReason ?? decision.fallback_reason ?? judgeAudit.fallback,
      80
    ),
  });
  return row;
}

// Columnas NOT NULL de la tabla que escribe la auditoría, con el valor que debe
// tener una fila cuando la decisión no aporta nada. Es la última red: aunque un
// camino nuevo olvide rellenar una, el lote no se pierde entero.
const VALORES_MINIMOS_NOT_NULL = Object.freeze({
  kind: 'daily',
  action: 'unknown',
  decision_json: {},
  metadata_json: {},
  reason_codes: [],
  llm_calls: 0,
  cache_hit: false,
});

// PostgREST manda un único INSERT con la unión de claves del lote y rellena con
// NULL las que falten en una fila. Uniformar las claves antes de escribir es lo
// que impide que una fila incompleta invalide la auditoría de toda la persona.
function uniformarFilasAuditoria(rows = []) {
  const columnas = new Set();
  for (const row of rows) for (const key of Object.keys(row)) columnas.add(key);
  return rows.map((row) => {
    const completa = {};
    for (const columna of columnas) {
      const valor = row[columna];
      completa[columna] = valor === undefined || valor === null
        ? (Object.prototype.hasOwnProperty.call(VALORES_MINIMOS_NOT_NULL, columna)
          ? VALORES_MINIMOS_NOT_NULL[columna]
          : null)
        : valor;
    }
    return completa;
  });
}

function construirDigestCandidateDecisionRows(input = {}) {
  return uniformarFilasAuditoria(
    (Array.isArray(input.decisions) ? input.decisions : [])
      .map((decision) => construirDigestCandidateDecisionRow({ ...input, decision }))
      .filter(Boolean)
  );
}

const REQUIRED_CANONICAL_AUDIT_STAGES = Object.freeze([
  'fact_sheet_preselection',
  'personal_relevance_judge',
  'auto_send_gate',
  'final_validation',
  'effective_send_gate',
]);

const REQUIRED_CANONICAL_AUDIT_STAGE_SET = new Set(REQUIRED_CANONICAL_AUDIT_STAGES);

// Postgres rechaza un upsert entero si el mismo lote trae dos filas con la
// misma clave de conflicto ("cannot affect row a second time"). Una alerta
// puede aparecer dos veces en una misma tanda de auditoría -por ejemplo
// bloqueada por el ranking y luego resuelta por el portfolio-, así que se
// consolida por clave y gana la última, que es la decisión definitiva.
function consolidarPorClaveDeConflicto(rows = []) {
  const porClave = new Map();
  for (const row of rows) {
    porClave.set(
      [row.user_id, row.fecha, row.kind, row.alerta_id, row.stage].join('|'),
      row
    );
  }
  return [...porClave.values()];
}

async function registrarDigestCandidateDecisions(supabase, input = {}) {
  const rows = construirDigestCandidateDecisionRows(input);
  const filas = consolidarPorClaveDeConflicto(rows);
  if (!supabase?.from || filas.length === 0) {
    return { ok: true, available: Boolean(supabase?.from), stored: 0, rows, filas };
  }

  try {
    const { error } = await supabase
      .from('digest_candidate_decisions')
      .upsert(filas, { onConflict: 'user_id,fecha,kind,alerta_id,stage' });
    if (error) throw error;
    return { ok: true, available: true, stored: filas.length, rows, filas };
  } catch (error) {
    console.warn('[digest_candidate_decisions] No se pudo guardar auditoria:', error.message);
    return { ok: false, available: false, stored: 0, error: error.message, rows, filas };
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

  const submitted = Array.isArray(input.decisions) ? input.decisions.length : 0;
  // Sin candidatas no hay nada que auditar. Eso es silencio legitimo -el
  // usuario no tenia alertas aplicables ese dia-, no un fallo de persistencia:
  // tratarlo como error impedia auditar y tumbaba el lote entero por una sola
  // persona. El motivo del silencio se registra en digest_attempts.
  if (submitted === 0) {
    return { ok: true, available: Boolean(supabase?.from), stored: 0, rows: [], empty: true };
  }

  const result = await registrarDigestCandidateDecisions(supabase, input);
  // Cada decisión enviada debe haber producido una fila auditable...
  const construidas = Array.isArray(result.rows) ? result.rows.length : 0;
  // ...y lo que se persiste son esas filas consolidadas por clave, porque dos
  // decisiones de la misma alerta comparten fila por definición.
  const persistibles = Array.isArray(result.filas) ? result.filas.length : construidas;
  if (
    !result.ok
    || !result.available
    || construidas !== submitted
    || result.stored !== persistibles
  ) {
    const error = new Error(`No se pudo guardar la auditoria canonica de ${stage}`);
    error.code = 'CANONICAL_DECISION_AUDIT_FAILED';
    error.stage = stage;
    // Distinguir la causa: un rechazo de Supabase no se investiga igual que una
    // decisión que no llegó a producir fila auditable.
    error.audit_error = result.error
      || (construidas === 0
        ? 'canonical_audit_empty'
        : construidas !== submitted
          ? `canonical_audit_incomplete: ${construidas}/${submitted} decisiones produjeron fila`
          : `canonical_audit_not_stored: ${result.stored}/${persistibles} filas persistidas`);
    error.audit_counts = { submitted, construidas, persistibles, stored: result.stored };
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
