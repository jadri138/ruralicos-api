const crypto = require('crypto');
const {
  CONTRACT_VERSIONS,
  DECISION_STATES,
  REASON_CODES,
} = require('./contracts');
const { compactText, normalizeText, uniqueStrings } = require('./truthCard');

const RECOVERY_STRATEGIES = Object.freeze([
  'structured_reparse',
  'evidence_window_scan',
  'legacy_field_reconcile',
]);

const DEFAULT_BACKOFF_MS = Object.freeze([
  15 * 60 * 1000,
  2 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
]);

function validDate(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function sanitizeStoredMaterial(material = {}) {
  const legacyAlert = material.alert || material.alerta || material.legacy_alert || {};
  const rawText = material.text
    || material.document_text
    || material.pdf_text
    || material.raw_text
    || legacyAlert.contenido
    || legacyAlert.resumen_final
    || '';
  return {
    // Conserva saltos de línea: la primera estrategia reconoce etiquetas
    // estructuradas al inicio de cada línea del documento ya almacenado.
    text: String(rawText)
      .replace(/\r\n?/g, '\n')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 200000),
    legacy_fields: {
      provinces: uniqueStrings(legacyAlert.provincias),
      municipalities: uniqueStrings(legacyAlert.municipios),
      beneficiaries: compactText(legacyAlert.beneficiarios, 500),
      action: compactText(legacyAlert.accion || legacyAlert.accion_requerida, 500),
      deadline: compactText(legacyAlert.plazo || legacyAlert.fecha_limite, 200),
      amount: compactText(legacyAlert.importe, 200),
      official_url: compactText(legacyAlert.url, 500),
    },
    stored_document_id: material.stored_document_id || material.raw_document_id || null,
    content_hash: material.content_hash || null,
  };
}

function materialFingerprint(material = {}) {
  const safe = sanitizeStoredMaterial(material);
  return crypto.createHash('sha256').update(JSON.stringify(safe)).digest('hex');
}

function canonicalMissingField(value) {
  const normalized = normalizeText(value);
  if (/territor|provincia|municipio|ambito/.test(normalized)) return 'territory';
  if (/benefici|destinatar|afecta a/.test(normalized)) return 'beneficiaries';
  if (/accion|tramite|que hacer/.test(normalized)) return 'action';
  if (/plazo|fecha limite|deadline|vence/.test(normalized)) return 'deadline';
  if (/importe|cuantia|amount/.test(normalized)) return 'amount';
  if (/url|enlace|fuente oficial/.test(normalized)) return 'official_url';
  return normalized.replace(/\s+/g, '_');
}

function createHoldRecoveryState({
  candidate,
  decision,
  missingFields,
  now = new Date(),
  expiresAt,
  maxAttempts = 3,
} = {}) {
  const current = validDate(now, new Date());
  const missing = uniqueStrings(
    missingFields
    || decision?.missing_information
    || candidate?.eligibility?.trace?.missing_evidence
  ).map(canonicalMissingField);
  return {
    contract_version: CONTRACT_VERSIONS.recovery,
    alert_id: candidate?.alert_id ?? null,
    status: DECISION_STATES.HOLD_FOR_EVIDENCE,
    missing_fields: missing,
    attempts: [],
    max_attempts: Math.max(1, Math.min(RECOVERY_STRATEGIES.length, Number(maxAttempts) || 3)),
    max_material_checks: Math.max(1, Math.min(3, Number(maxAttempts) || 3)),
    created_at: current.toISOString(),
    updated_at: current.toISOString(),
    next_attempt_at: current.toISOString(),
    expires_at: validDate(expiresAt)?.toISOString() || null,
    last_reason_code: REASON_CODES.RECOVERY_SCHEDULED,
    recovered_evidence: {},
  };
}

function planHoldRecovery({ state, storedMaterial, now = new Date() } = {}) {
  const current = validDate(now, new Date());
  if (state?.contract_version !== CONTRACT_VERSIONS.recovery) {
    return { scheduled: false, reason_code: REASON_CODES.TRUTH_CARD_INVALID, terminal: true };
  }
  if (state.status !== DECISION_STATES.HOLD_FOR_EVIDENCE) {
    return { scheduled: false, reason_code: state.last_reason_code, terminal: true };
  }
  const expiresAt = validDate(state.expires_at);
  if (expiresAt && current >= expiresAt) {
    return { scheduled: false, reason_code: REASON_CODES.RECOVERY_EXPIRED, terminal: true };
  }
  const nextAttempt = validDate(state.next_attempt_at);
  if (nextAttempt && current < nextAttempt) {
    return {
      scheduled: false,
      reason_code: REASON_CODES.RECOVERY_BACKOFF,
      terminal: false,
      next_attempt_at: nextAttempt.toISOString(),
    };
  }
  if (!Array.isArray(state.missing_fields) || state.missing_fields.length === 0) {
    return {
      scheduled: false,
      reason_code: REASON_CODES.RECOVERY_STRATEGY_EXHAUSTED,
      terminal: true,
    };
  }
  const attempts = state.attempts || [];
  const strategyAttempts = attempts.filter((attempt) => RECOVERY_STRATEGIES.includes(attempt.strategy));
  if (strategyAttempts.length >= state.max_attempts) {
    return { scheduled: false, reason_code: REASON_CODES.RECOVERY_STRATEGY_EXHAUSTED, terminal: true };
  }
  const material = sanitizeStoredMaterial(storedMaterial);
  const hasStoredMaterial = Boolean(material.text
    || Object.values(material.legacy_fields).some((value) => (
      Array.isArray(value) ? value.length : Boolean(value)
    )));
  if (!hasStoredMaterial) {
    const materialChecks = attempts.filter((attempt) => attempt.strategy === 'stored_material_lookup').length;
    if (materialChecks >= (state.max_material_checks || 3)) {
      return { scheduled: false, reason_code: REASON_CODES.RECOVERY_STRATEGY_EXHAUSTED, terminal: true };
    }
    return {
      scheduled: false,
      reason_code: REASON_CODES.UPSTREAM_MATERIAL_MISSING,
      terminal: false,
      material_fingerprint: materialFingerprint(storedMaterial),
    };
  }
  const fingerprint = materialFingerprint(storedMaterial);
  const used = new Set((state.attempts || [])
    .filter((attempt) => attempt.material_fingerprint === fingerprint)
    .map((attempt) => attempt.strategy));
  const strategy = RECOVERY_STRATEGIES.find((name) => !used.has(name));
  if (!strategy) {
    return { scheduled: false, reason_code: REASON_CODES.RECOVERY_STRATEGY_EXHAUSTED, terminal: true };
  }
  return {
    scheduled: true,
    terminal: false,
    reason_code: REASON_CODES.RECOVERY_SCHEDULED,
    strategy,
    material_fingerprint: fingerprint,
    missing_fields: state.missing_fields,
    stored_material: material,
  };
}

function evidenceItem(field, value, fragment, source, confidence = 0.65) {
  if (!value || !fragment) return null;
  return {
    field,
    value: compactText(value, 500),
    fragment: compactText(fragment, 700),
    source,
    confidence,
  };
}

function structuredReparse(material, missingFields) {
  const text = material.text || '';
  const labels = {
    territory: /^(?:TERRITORIO|PROVINCIA|AMBITO)\s*:\s*(.+)$/im,
    beneficiaries: /^BENEFICIARIOS?\s*:\s*(.+)$/im,
    action: /^ACCION\s*:\s*(.+)$/im,
    deadline: /^(?:PLAZO|FECHA_LIMITE)\s*:\s*(.+)$/im,
    amount: /^(?:IMPORTE|CUANTIA)\s*:\s*(.+)$/im,
    official_url: /^URL_OFICIAL\s*:\s*(https?:\/\/\S+)$/im,
  };
  const evidence = {};
  for (const field of missingFields) {
    const match = labels[field]?.exec(text);
    if (match) evidence[field] = evidenceItem(field, match[1], match[0], 'stored_text:structured', 0.72);
  }
  return evidence;
}

function evidenceWindowScan(material, missingFields) {
  const text = material.text || '';
  const patterns = {
    territory: /[^.\n]{0,100}\b(?:ambito|provincia|municipio|comunidad autonoma)\b[^.\n]{0,160}/i,
    beneficiaries: /[^.\n]{0,100}\b(?:beneficiari[oa]s?|dirigid[oa]s? a|titulares? de)\b[^.\n]{0,180}/i,
    action: /[^.\n]{0,100}\b(?:presentar|solicitar|subsanar|alegar|inscribirse|justificar)\b[^.\n]{0,180}/i,
    deadline: /[^.\n]{0,100}\b(?:plazo|hasta el|antes del|vence|finaliza)\b[^.\n]{0,180}/i,
    amount: /[^.\n]{0,100}\b(?:importe|cuantia|euros?)\b[^.\n]{0,180}/i,
    official_url: /https?:\/\/[^\s)]+/i,
  };
  const evidence = {};
  for (const field of missingFields) {
    const match = patterns[field]?.exec(text);
    if (match) evidence[field] = evidenceItem(field, match[0], match[0], 'stored_text:window', 0.62);
  }
  return evidence;
}

function legacyFieldReconcile(material, missingFields) {
  const text = material.text || '';
  const fields = material.legacy_fields || {};
  const mapping = {
    territory: [...(fields.municipalities || []), ...(fields.provinces || [])].join(', '),
    beneficiaries: fields.beneficiaries,
    action: fields.action,
    deadline: fields.deadline,
    amount: fields.amount,
    official_url: fields.official_url,
  };
  const evidence = {};
  for (const field of missingFields) {
    const value = mapping[field];
    const normalizedValue = normalizeText(value);
    const isUrl = field === 'official_url' && /^https?:\/\//i.test(value || '');
    if (value && (isUrl || normalizeText(text).includes(normalizedValue))) {
      evidence[field] = evidenceItem(
        field,
        value,
        isUrl ? value : text,
        `stored_alert:${field}`,
        isUrl ? 0.7 : 0.58
      );
    }
  }
  return evidence;
}

const BUILT_IN_STRATEGIES = Object.freeze({
  structured_reparse: structuredReparse,
  evidence_window_scan: evidenceWindowScan,
  legacy_field_reconcile: legacyFieldReconcile,
});

async function executeRecoveryPlan(plan, strategyHandlers = {}) {
  if (!plan?.scheduled) return { status: 'not_run', evidence: {}, technical_error: false };
  const handler = strategyHandlers[plan.strategy] || BUILT_IN_STRATEGIES[plan.strategy];
  if (typeof handler !== 'function') {
    return { status: 'technical_error', evidence: {}, technical_error: true, error_type: 'MissingStrategy' };
  }
  try {
    const evidence = await handler(plan.stored_material, plan.missing_fields);
    return {
      status: Object.keys(evidence || {}).length ? 'evidence_found' : 'no_evidence',
      evidence: evidence || {},
      technical_error: false,
    };
  } catch (error) {
    return {
      status: 'technical_error',
      evidence: {},
      technical_error: true,
      error_type: error?.name || 'Error',
    };
  }
}

function recordRecoveryAttempt({ state, plan, result, now = new Date(), backoffMs = DEFAULT_BACKOFF_MS } = {}) {
  const current = validDate(now, new Date());
  if (!plan?.scheduled) {
    const expired = plan?.reason_code === REASON_CODES.RECOVERY_EXPIRED;
    const exhausted = plan?.reason_code === REASON_CODES.RECOVERY_STRATEGY_EXHAUSTED;
    const materialMissing = plan?.reason_code === REASON_CODES.UPSTREAM_MATERIAL_MISSING;
    if (materialMissing) {
      const materialChecks = (state.attempts || [])
        .filter((attempt) => attempt.strategy === 'stored_material_lookup').length + 1;
      const attempts = [...(state.attempts || []), {
        attempt: (state.attempts || []).length + 1,
        strategy: 'stored_material_lookup',
        material_fingerprint: plan.material_fingerprint || null,
        started_at: current.toISOString(),
        status: 'no_stored_material',
        technical_error: false,
        error_type: null,
        recovered_fields: [],
        counts_toward_strategy_limit: false,
      }];
      const materialExhausted = materialChecks >= (state.max_material_checks || 3);
      const delay = backoffMs[Math.min(materialChecks - 1, backoffMs.length - 1)] || 0;
      return {
        ...state,
        status: DECISION_STATES.HOLD_FOR_EVIDENCE,
        attempts,
        exhausted: materialExhausted,
        updated_at: current.toISOString(),
        next_attempt_at: materialExhausted
          ? null
          : new Date(current.getTime() + delay).toISOString(),
        last_reason_code: materialExhausted
          ? REASON_CODES.RECOVERY_STRATEGY_EXHAUSTED
          : REASON_CODES.UPSTREAM_MATERIAL_MISSING,
      };
    }
    return {
      ...state,
      status: expired ? 'EXPIRED' : state.status,
      exhausted: exhausted || state.exhausted,
      updated_at: current.toISOString(),
      next_attempt_at: expired || exhausted ? null : state.next_attempt_at,
      last_reason_code: plan?.reason_code || state.last_reason_code,
    };
  }
  const duplicate = (state.attempts || []).some((attempt) => (
    attempt.strategy === plan.strategy
    && attempt.material_fingerprint === plan.material_fingerprint
  ));
  if (duplicate) throw new Error('recovery_strategy_repeated_without_material_change');
  const recovered = { ...(state.recovered_evidence || {}), ...(result.evidence || {}) };
  const remaining = state.missing_fields.filter((field) => !recovered[field]);
  const attempts = [...state.attempts, {
    attempt: state.attempts.length + 1,
    strategy: plan.strategy,
    material_fingerprint: plan.material_fingerprint,
    started_at: current.toISOString(),
    status: result.status,
    technical_error: Boolean(result.technical_error),
    error_type: result.error_type || null,
    recovered_fields: Object.keys(result.evidence || {}).sort(),
  }];
  if (remaining.length === 0) {
    return {
      ...state,
      status: 'READY_FOR_REEVALUATION',
      attempts,
      recovered_evidence: recovered,
      missing_fields: [],
      updated_at: current.toISOString(),
      next_attempt_at: null,
      last_reason_code: REASON_CODES.RECOVERY_EVIDENCE_FOUND,
    };
  }
  const strategyAttempts = attempts.filter((attempt) => RECOVERY_STRATEGIES.includes(attempt.strategy));
  const exhausted = strategyAttempts.length >= state.max_attempts;
  const delay = backoffMs[Math.min(strategyAttempts.length - 1, backoffMs.length - 1)] || 0;
  return {
    ...state,
    status: DECISION_STATES.HOLD_FOR_EVIDENCE,
    attempts,
    recovered_evidence: recovered,
    missing_fields: remaining,
    updated_at: current.toISOString(),
    next_attempt_at: exhausted ? null : new Date(current.getTime() + delay).toISOString(),
    last_reason_code: exhausted
      ? REASON_CODES.RECOVERY_STRATEGY_EXHAUSTED
      : REASON_CODES.RECOVERY_BACKOFF,
    exhausted,
  };
}

async function recoverHoldFromStoredMaterial({
  state,
  storedMaterial,
  now = new Date(),
  strategyHandlers,
  backoffMs,
} = {}) {
  const plan = planHoldRecovery({ state, storedMaterial, now });
  if (!plan.scheduled) {
    return {
      state: recordRecoveryAttempt({ state, plan, now, backoffMs }),
      plan,
      result: null,
    };
  }
  const result = await executeRecoveryPlan(plan, strategyHandlers);
  return {
    state: recordRecoveryAttempt({ state, plan, result, now, backoffMs }),
    plan,
    result,
  };
}

module.exports = {
  RECOVERY_STRATEGIES,
  DEFAULT_BACKOFF_MS,
  sanitizeStoredMaterial,
  materialFingerprint,
  canonicalMissingField,
  createHoldRecoveryState,
  planHoldRecovery,
  executeRecoveryPlan,
  recordRecoveryAttempt,
  recoverHoldFromStoredMaterial,
};
