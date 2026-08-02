const {
  CONTRACT_VERSIONS,
  DECISION_STATES,
  DEFAULT_BACKOFF_MS,
  REASON_CODES,
  canonicalMissingField,
  createHoldRecoveryState,
  mapWithConcurrency,
  materialFingerprint,
  recoverHoldFromStoredMaterial,
} = require('../alertas/decision');

const STRATEGY_ORDER = [
  'structured_reparse',
  'evidence_window_scan',
  'legacy_field_reconcile',
];

const DEFAULT_RECOVERY_LIMIT = 25;
const DEFAULT_RECOVERY_CONCURRENCY = 2;
const DEFAULT_STALE_PROCESSING_MS = 60 * 60 * 1000;
const RECOVERABLE_FACT_SHEET_FIELDS = Object.freeze([
  'territory',
  'beneficiaries',
  'action',
  'deadline',
  'amount',
  'official_url',
]);
const RECOVERABLE_HOLD_REASON_FIELDS = Object.freeze({
  [REASON_CODES.TERRITORY_EVIDENCE_MISSING]: 'territory',
  [REASON_CODES.BENEFICIARY_EVIDENCE_MISSING]: 'beneficiaries',
  [REASON_CODES.ACTION_EVIDENCE_MISSING]: 'action',
  [REASON_CODES.DEADLINE_EVIDENCE_MISSING]: 'deadline',
  [REASON_CODES.OFFICIAL_URL_MISSING]: 'official_url',
  [REASON_CODES.INSUFFICIENT_EVIDENCE]: null,
});
const RECOVERY_ROW_SELECT = [
  'id',
  'alerta_id',
  'organization_id',
  'status',
  'fact_sheet',
  'source_trace',
  'shadow_decision',
  'content_hash',
  'recovery_status',
  'recovery_attempts',
  'recovery_next_at',
  'recovery_last_at',
  'recovery_strategy',
  'recovery_missing_fields',
  'recovery_error',
].join(', ');

function alertId(value = {}) {
  return value.id ?? value.alerta_id ?? value.alert_id ?? null;
}

function holdCandidate(entry = {}) {
  return entry.candidate || entry.authorized?.candidate || entry;
}

function holdMissingFields(entry = {}) {
  const candidate = holdCandidate(entry);
  return entry.judged?.decision?.missing_information
    || entry.authorized?.decision?.missing_information
    || candidate.eligibility?.trace?.missing_evidence
    || [];
}

function recoverableFactSheetFields(values = []) {
  const allowed = new Set(RECOVERABLE_FACT_SHEET_FIELDS);
  return [...new Set((Array.isArray(values) ? values : [])
    .map(canonicalMissingField)
    .filter((field) => allowed.has(field)))];
}

function globalFactSheetHoldFields(entry = {}) {
  const candidate = holdCandidate(entry);
  const eligibility = candidate?.eligibility || {};
  if (eligibility.state !== DECISION_STATES.HOLD_FOR_EVIDENCE) return [];

  const reasonCodes = Array.isArray(eligibility.reason_codes)
    ? eligibility.reason_codes
    : [];
  if (
    reasonCodes.length === 0
    || reasonCodes.some((code) => !Object.hasOwn(RECOVERABLE_HOLD_REASON_FIELDS, code))
  ) {
    return [];
  }

  return recoverableFactSheetFields([
    ...(eligibility.trace?.missing_evidence || []),
    ...reasonCodes.map((code) => RECOVERABLE_HOLD_REASON_FIELDS[code]).filter(Boolean),
  ]);
}

function uniqueTextBlocks(values = []) {
  const seen = new Set();
  const blocks = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    blocks.push(text);
  }
  return blocks;
}

function storedMaterial(alerta = {}, candidate = {}, rawDocument = null, row = null) {
  const storedDocumentId = rawDocument?.id
    || row?.stored_document_id
    || row?.fact_sheet?.raw_document_id
    || candidate.truth_card?.identity?.raw_document_id
    || candidate.truth_card?.identity?.document_id
    || alerta.fact_sheet?.raw_document_id
    || null;
  return {
    text: uniqueTextBlocks([
      rawDocument?.texto_raw,
      alerta.contenido,
      alerta.texto_raw,
      alerta.resumen_final,
      alerta.resumen,
      alerta.titulo,
    ]).join('\n\n'),
    alert: alerta,
    content_hash: rawDocument?.contenido_hash
      || row?.content_hash
      || row?.fact_sheet?.content_hash
      || candidate.truth_card?.identity?.content_hash
      || alerta.fact_sheet?.content_hash
      || null,
    stored_document_id: storedDocumentId,
  };
}

function evidenceField(value = {}) {
  return {
    valor: value.value,
    evidencia: value.fragment,
    source: value.source,
    confidence: value.confidence,
    evidence_level: 'supported',
    status: 'supported',
  };
}

function applyRecoveredEvidence(factSheet = {}, recovered = {}) {
  const next = { ...(factSheet || {}) };
  if (recovered.territory) next.territorio = [evidenceField(recovered.territory)];
  if (recovered.beneficiaries) next.beneficiarios = evidenceField(recovered.beneficiaries);
  if (recovered.action) next.accion_requerida = evidenceField(recovered.action);
  if (recovered.deadline) next.application_deadline = evidenceField(recovered.deadline);
  if (recovered.amount) next.importe = evidenceField(recovered.amount);
  if (recovered.official_url) next.url_oficial = evidenceField(recovered.official_url);
  return next;
}

async function loadRecoveryRow(supabase, alertaId) {
  const { data, error } = await supabase
    .from('alert_fact_sheets')
    .select(RECOVERY_ROW_SELECT)
    .eq('alerta_id', alertaId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function persistRecoveryRow(supabase, rowId, patch) {
  if (!rowId) return { ok: false, reason: 'fact_sheet_row_missing' };
  const { error } = await supabase
    .from('alert_fact_sheets')
    .update(patch)
    .eq('id', rowId);
  if (error) throw error;
  return { ok: true };
}

function hydrateRecoveryState({ candidate, entry, row, material, now, missingFields = null }) {
  const requestedFields = Array.isArray(missingFields)
    ? recoverableFactSheetFields(missingFields)
    : null;
  const base = createHoldRecoveryState({
    candidate,
    decision: entry.judged?.decision || entry.authorized?.decision,
    missingFields: requestedFields?.length
      ? requestedFields
      : (row?.recovery_missing_fields?.length
        ? row.recovery_missing_fields
        : holdMissingFields(entry)),
    now,
  });
  const persistedState = row?.shadow_decision?.hold_recovery;
  if (
    persistedState?.contract_version === CONTRACT_VERSIONS.recovery
    && String(persistedState.alert_id) === String(candidate?.alert_id)
  ) {
    return {
      ...base,
      ...persistedState,
      status: DECISION_STATES.HOLD_FOR_EVIDENCE,
      attempts: Array.isArray(persistedState.attempts) ? persistedState.attempts : [],
      missing_fields: requestedFields?.length
        ? requestedFields
        : (row?.recovery_missing_fields?.length
          ? row.recovery_missing_fields
          : (persistedState.missing_fields || base.missing_fields)),
      next_attempt_at: row?.recovery_next_at ?? persistedState.next_attempt_at ?? base.next_attempt_at,
      updated_at: new Date(now).toISOString(),
    };
  }
  const attempts = Math.max(0, Math.min(STRATEGY_ORDER.length, Number(row?.recovery_attempts) || 0));
  const fingerprint = materialFingerprint(material);
  const legacyStrategies = row?.recovery_strategy === 'stored_material_lookup'
    ? Array.from({ length: attempts }, () => 'stored_material_lookup')
    : STRATEGY_ORDER.slice(0, attempts);
  return {
    ...base,
    status: DECISION_STATES.HOLD_FOR_EVIDENCE,
    attempts: legacyStrategies.map((strategy, index) => ({
      attempt: index + 1,
      strategy,
      material_fingerprint: fingerprint,
      status: 'persisted_previous_attempt',
      counts_toward_strategy_limit: strategy !== 'stored_material_lookup',
    })),
    next_attempt_at: row?.recovery_next_at || base.next_attempt_at,
  };
}

function persistedStatus(state, result) {
  if (state.status === 'READY_FOR_REEVALUATION') return 'RECOVERED';
  if (state.status === 'EXPIRED') return 'EXPIRED';
  if (state.exhausted) return 'EXHAUSTED';
  if (result?.technical_error) return 'FAILED';
  return 'PENDING';
}

function buildRecoveryPersistence({ row = {}, baseFactSheet = {}, material, stateBefore, recovery, now }) {
  const evidence = recovery.result?.evidence || {};
  const evidenceFound = Object.keys(evidence).length > 0;
  const ready = recovery.state.status === 'READY_FOR_REEVALUATION';
  const nextFactSheet = applyRecoveredEvidence(row.fact_sheet || baseFactSheet || {}, evidence);
  nextFactSheet.recovery_state = ready
    ? 'READY_FOR_REEVALUATION'
    : (recovery.state.exhausted ? 'EXHAUSTED' : recovery.state.status);
  if (ready) nextFactSheet.status = 'ready_for_digest';

  const attemptsBefore = stateBefore?.attempts?.length || 0;
  const attemptsAfter = recovery.state.attempts?.length || 0;
  const attemptedNow = attemptsAfter > attemptsBefore;
  const lastAttempt = recovery.state.attempts?.[attemptsAfter - 1] || null;
  const recoveryError = recovery.result?.technical_error
    ? (recovery.result.error_type || 'technical_error')
    : (!recovery.plan?.scheduled && recovery.plan?.reason_code === REASON_CODES.UPSTREAM_MATERIAL_MISSING
      ? REASON_CODES.UPSTREAM_MATERIAL_MISSING
      : null);

  return {
    patch: {
      recovery_status: persistedStatus(recovery.state, recovery.result),
      recovery_attempts: attemptsAfter,
      recovery_next_at: recovery.state.next_attempt_at || null,
      recovery_last_at: attemptedNow ? new Date(now).toISOString() : (row.recovery_last_at || null),
      recovery_strategy: lastAttempt?.strategy || recovery.plan?.strategy || row.recovery_strategy || null,
      recovery_missing_fields: recovery.state.missing_fields || [],
      recovery_error: recoveryError,
      content_hash: material.content_hash || row.content_hash || null,
      fact_sheet: nextFactSheet,
      shadow_decision: {
        ...(row.shadow_decision || {}),
        hold_recovery: recovery.state,
      },
      updated_at: new Date(now).toISOString(),
      ...(ready ? { status: 'ready_for_digest' } : {}),
    },
    factSheet: nextFactSheet,
    ready,
    evidenceFound,
  };
}

async function recoverDecisionHolds({
  supabase,
  result,
  alertas = [],
  now = new Date(),
  loadRowFn = loadRecoveryRow,
  persistRowFn = persistRecoveryRow,
  recoverFn = recoverHoldFromStoredMaterial,
} = {}) {
  const byId = new Map((alertas || []).map((alerta) => [String(alertId(alerta)), alerta]));
  const uniqueHolds = new Map();
  for (const entry of result?.holds || []) {
    const candidate = holdCandidate(entry);
    if (candidate?.alert_id !== null && candidate?.alert_id !== undefined) {
      uniqueHolds.set(String(candidate.alert_id), entry);
    }
  }

  const replacements = new Map();
  const diagnostics = [];
  for (const [key, entry] of uniqueHolds) {
    const candidate = holdCandidate(entry);
    const alerta = byId.get(key);
    if (!alerta) continue;
    const missingFields = globalFactSheetHoldFields(entry);
    if (missingFields.length === 0) {
      diagnostics.push({
        alert_id: candidate.alert_id,
        status: 'SKIPPED',
        skipped: true,
        reason: 'hold_not_global_fact_sheet_evidence',
      });
      continue;
    }
    let row = null;
    try {
      row = await loadRowFn(supabase, candidate.alert_id);
      if (!row?.id) {
        diagnostics.push({
          alert_id: candidate.alert_id,
          status: 'PENDING',
          skipped: true,
          reason: 'fact_sheet_row_missing',
        });
        continue;
      }
      if (['RECOVERED', 'EXHAUSTED', 'EXPIRED'].includes(row?.recovery_status)) {
        diagnostics.push({ alert_id: candidate.alert_id, status: row.recovery_status, skipped: true });
        continue;
      }
      if (row.recovery_status === 'PROCESSING') {
        diagnostics.push({
          alert_id: candidate.alert_id,
          status: 'PROCESSING',
          skipped: true,
          reason: 'recovery_claimed_by_worker',
        });
        continue;
      }
      const material = storedMaterial(alerta, candidate, null, row);
      const state = hydrateRecoveryState({
        candidate,
        entry,
        row,
        material,
        now,
        missingFields,
      });
      const recovery = await recoverFn({ state, storedMaterial: material, now });
      const persistence = buildRecoveryPersistence({
        row,
        baseFactSheet: alerta.fact_sheet,
        material,
        stateBefore: state,
        recovery,
        now,
      });
      const status = persistence.patch.recovery_status;
      if (persistence.ready) {
        replacements.set(key, {
          ...alerta,
          fact_sheet: persistence.factSheet,
          fact_sheet_status: persistence.factSheet.status,
        });
      }
      await persistRowFn(supabase, row?.id, persistence.patch);
      diagnostics.push({
        alert_id: candidate.alert_id,
        status,
        strategy: persistence.patch.recovery_strategy,
        recovered_fields: Object.keys(recovery.result?.evidence || {}).sort(),
        next_attempt_at: recovery.state.next_attempt_at || null,
      });
    } catch (error) {
      diagnostics.push({
        alert_id: candidate.alert_id,
        status: 'FAILED',
        error: error.message,
      });
    }
  }

  return {
    alertas: (alertas || []).map((alerta) => replacements.get(String(alertId(alerta))) || alerta),
    reevaluate: replacements.size > 0,
    recovered: replacements.size,
    diagnostics,
  };
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

async function loadDueRecoveryRows(supabase, {
  now = new Date(),
  limit = DEFAULT_RECOVERY_LIMIT,
} = {}) {
  const safeLimit = boundedInteger(limit, DEFAULT_RECOVERY_LIMIT, 1, 50);
  const { data, error } = await supabase
    .from('alert_fact_sheets')
    .select(RECOVERY_ROW_SELECT)
    .in('recovery_status', ['PENDING', 'FAILED'])
    .lte('recovery_next_at', new Date(now).toISOString())
    .order('recovery_next_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(safeLimit);
  if (error) throw error;
  return data || [];
}

async function claimRecoveryRow(supabase, row, { now = new Date() } = {}) {
  const nowIso = new Date(now).toISOString();
  const { data, error } = await supabase
    .from('alert_fact_sheets')
    .update({
      recovery_status: 'PROCESSING',
      recovery_last_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', row.id)
    .in('recovery_status', ['PENDING', 'FAILED'])
    .lte('recovery_next_at', nowIso)
    .select(RECOVERY_ROW_SELECT)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function requeueStaleRecoveryRows(supabase, {
  now = new Date(),
  staleAfterMs = DEFAULT_STALE_PROCESSING_MS,
} = {}) {
  const nowDate = new Date(now);
  const staleBefore = new Date(nowDate.getTime() - Math.max(60_000, Number(staleAfterMs) || DEFAULT_STALE_PROCESSING_MS));
  const { data, error } = await supabase
    .from('alert_fact_sheets')
    .update({
      recovery_status: 'FAILED',
      recovery_next_at: nowDate.toISOString(),
      recovery_error: 'stale_processing_requeued',
      updated_at: nowDate.toISOString(),
    })
    .eq('recovery_status', 'PROCESSING')
    .lt('recovery_last_at', staleBefore.toISOString())
    .select('id');
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

function rawDocumentIdFromRecoveryRow(row = {}) {
  return row.stored_document_id
    || row.fact_sheet?.raw_document_id
    || row.source_trace?.raw_document_id
    || null;
}

function rawDocumentMatchesAlert(rawDocument, alertaId, explicitId = null) {
  if (!rawDocument) return false;
  if (explicitId && String(rawDocument.id) !== String(explicitId)) return false;
  return rawDocument.inserted_alerta_id === null
    || rawDocument.inserted_alerta_id === undefined
    || String(rawDocument.inserted_alerta_id) === String(alertaId);
}

async function loadStoredRawDocument(supabase, row) {
  const warnings = [];
  const storedDocumentId = rawDocumentIdFromRecoveryRow(row);
  if (storedDocumentId) {
    const { data, error } = await supabase
      .from('raw_documents')
      .select('*')
      .eq('id', storedDocumentId)
      .maybeSingle();
    if (error) {
      const lookupError = new Error('stored_document_lookup_failed');
      lookupError.name = error.name || 'RawDocumentLookupError';
      throw lookupError;
    } else if (rawDocumentMatchesAlert(data, row.alerta_id, storedDocumentId)) {
      return { rawDocument: data, warnings, lookup: 'stored_document_id' };
    } else if (data) {
      warnings.push({ code: 'stored_document_alert_mismatch' });
    }
  }

  const { data, error } = await supabase
    .from('raw_documents')
    .select('*')
    .eq('inserted_alerta_id', row.alerta_id)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    const lookupError = new Error('inserted_alert_lookup_failed');
    lookupError.name = error.name || 'RawDocumentLookupError';
    throw lookupError;
  }
  return {
    rawDocument: rawDocumentMatchesAlert(data, row.alerta_id) ? data : null,
    warnings,
    lookup: data ? 'inserted_alerta_id' : null,
  };
}

async function loadRecoveryContext(supabase, row) {
  const { data: alerta, error } = await supabase
    .from('alertas')
    .select('*')
    .eq('id', row.alerta_id)
    .maybeSingle();
  if (error) throw error;
  if (!alerta) throw new Error('recovery_alert_not_found');

  const raw = await loadStoredRawDocument(supabase, row);
  const candidate = {
    alert_id: row.alerta_id,
    truth_card: {
      identity: {
        alert_id: row.alerta_id,
        document_id: raw.rawDocument?.id || rawDocumentIdFromRecoveryRow(row),
        content_hash: raw.rawDocument?.contenido_hash || row.content_hash || row.fact_sheet?.content_hash || null,
      },
    },
  };
  return {
    alerta: { ...alerta, fact_sheet: row.fact_sheet || null },
    candidate,
    rawDocument: raw.rawDocument,
    material: storedMaterial(alerta, candidate, raw.rawDocument, row),
    warnings: raw.warnings,
    raw_lookup: raw.lookup,
  };
}

function recoveryEntryFromRow(row, candidate) {
  return {
    candidate,
    judged: {
      decision: {
        missing_information: row.recovery_missing_fields || [],
      },
    },
  };
}

function workerFailureState(row, error, now) {
  const current = new Date(now);
  const persisted = row?.shadow_decision?.hold_recovery;
  const base = persisted?.contract_version === CONTRACT_VERSIONS.recovery
    ? persisted
    : createHoldRecoveryState({
      candidate: { alert_id: row.alerta_id },
      missingFields: row.recovery_missing_fields || [],
      now: current,
    });
  const contextFailures = (base.attempts || [])
    .filter((attempt) => attempt.strategy === 'worker_context_load').length + 1;
  const attempts = [...(base.attempts || []), {
    attempt: (base.attempts || []).length + 1,
    strategy: 'worker_context_load',
    material_fingerprint: null,
    started_at: current.toISOString(),
    status: 'technical_error',
    technical_error: true,
    error_type: error?.name || 'Error',
    recovered_fields: [],
    counts_toward_strategy_limit: false,
  }];
  const exhausted = contextFailures >= 3;
  const delay = DEFAULT_BACKOFF_MS[Math.min(contextFailures - 1, DEFAULT_BACKOFF_MS.length - 1)] || 0;
  return {
    ...base,
    attempts,
    exhausted,
    updated_at: current.toISOString(),
    next_attempt_at: exhausted ? null : new Date(current.getTime() + delay).toISOString(),
    last_reason_code: exhausted
      ? REASON_CODES.RECOVERY_STRATEGY_EXHAUSTED
      : REASON_CODES.RECOVERY_BACKOFF,
  };
}

async function persistWorkerFailure(supabase, row, error, now, persistRowFn = persistRecoveryRow) {
  const state = workerFailureState(row, error, now);
  await persistRowFn(supabase, row.id, {
    recovery_status: state.exhausted ? 'EXHAUSTED' : 'FAILED',
    recovery_attempts: state.attempts.length,
    recovery_next_at: state.next_attempt_at,
    recovery_last_at: new Date(now).toISOString(),
    recovery_strategy: 'worker_context_load',
    recovery_missing_fields: state.missing_fields || [],
    recovery_error: error?.name || 'Error',
    shadow_decision: {
      ...(row.shadow_decision || {}),
      hold_recovery: state,
    },
    updated_at: new Date(now).toISOString(),
  });
  return state;
}

async function processRecoveryQueueRow({
  supabase,
  row,
  now,
  claimRowFn = claimRecoveryRow,
  loadContextFn = loadRecoveryContext,
  persistRowFn = persistRecoveryRow,
  recoverFn = recoverHoldFromStoredMaterial,
} = {}) {
  let claimed = null;
  try {
    claimed = await claimRowFn(supabase, row, { now });
    if (!claimed) {
      return { alert_id: row.alerta_id, status: 'SKIPPED', skipped: true, reason: 'claim_lost' };
    }
    const context = await loadContextFn(supabase, claimed);
    const entry = recoveryEntryFromRow(claimed, context.candidate);
    const state = hydrateRecoveryState({
      candidate: context.candidate,
      entry,
      row: claimed,
      material: context.material,
      now,
    });
    const recovery = await recoverFn({
      state,
      storedMaterial: context.material,
      now,
    });
    const persistence = buildRecoveryPersistence({
      row: claimed,
      baseFactSheet: context.alerta.fact_sheet,
      material: context.material,
      stateBefore: state,
      recovery,
      now,
    });
    await persistRowFn(supabase, claimed.id, persistence.patch);
    return {
      alert_id: claimed.alerta_id,
      status: persistence.patch.recovery_status,
      strategy: persistence.patch.recovery_strategy,
      recovered_fields: Object.keys(recovery.result?.evidence || {}).sort(),
      next_attempt_at: persistence.patch.recovery_next_at,
      raw_lookup: context.raw_lookup,
      warnings: context.warnings,
    };
  } catch (error) {
    if (claimed) {
      try {
        const state = await persistWorkerFailure(supabase, claimed, error, now, persistRowFn);
        return {
          alert_id: claimed.alerta_id,
          status: state.exhausted ? 'EXHAUSTED' : 'FAILED',
          error: error?.name || 'Error',
          next_attempt_at: state.next_attempt_at,
        };
      } catch (persistError) {
        return {
          alert_id: claimed.alerta_id,
          status: 'FAILED',
          error: 'recovery_failure_not_persisted',
          detail: persistError?.name || 'Error',
        };
      }
    }
    return {
      alert_id: row?.alerta_id || null,
      status: 'FAILED',
      error: error?.name || 'Error',
    };
  }
}

async function processDueEvidenceRecovery({
  supabase,
  now = new Date(),
  limit = DEFAULT_RECOVERY_LIMIT,
  concurrency = DEFAULT_RECOVERY_CONCURRENCY,
  staleAfterMs = DEFAULT_STALE_PROCESSING_MS,
  loadRowsFn = loadDueRecoveryRows,
  requeueStaleFn = requeueStaleRecoveryRows,
  processRowFn = processRecoveryQueueRow,
  workerOptions = {},
} = {}) {
  const safeLimit = boundedInteger(limit, DEFAULT_RECOVERY_LIMIT, 1, 50);
  const safeConcurrency = boundedInteger(concurrency, DEFAULT_RECOVERY_CONCURRENCY, 1, 4);
  const staleRequeued = await requeueStaleFn(supabase, { now, staleAfterMs });
  const loadedRows = await loadRowsFn(supabase, { now, limit: safeLimit });
  const rows = (Array.isArray(loadedRows) ? loadedRows : []).slice(0, safeLimit);
  const results = await mapWithConcurrency(rows, safeConcurrency, (row) => processRowFn({
    supabase,
    row,
    now,
    ...workerOptions,
  }));
  const count = (status) => results.filter((item) => item.status === status).length;
  return {
    ok: true,
    processed: results.length,
    has_more: (Array.isArray(loadedRows) ? loadedRows.length : 0) >= safeLimit,
    recovered: count('RECOVERED'),
    pending: count('PENDING'),
    failed: count('FAILED'),
    exhausted: count('EXHAUSTED'),
    skipped: results.filter((item) => item.skipped).length,
    stale_requeued: staleRequeued,
    limit: safeLimit,
    concurrency: safeConcurrency,
    results,
  };
}

module.exports = {
  DEFAULT_RECOVERY_CONCURRENCY,
  DEFAULT_RECOVERY_LIMIT,
  DEFAULT_STALE_PROCESSING_MS,
  RECOVERABLE_FACT_SHEET_FIELDS,
  RECOVERY_ROW_SELECT,
  applyRecoveredEvidence,
  buildRecoveryPersistence,
  claimRecoveryRow,
  globalFactSheetHoldFields,
  hydrateRecoveryState,
  loadDueRecoveryRows,
  loadRecoveryContext,
  loadRecoveryRow,
  loadStoredRawDocument,
  persistRecoveryRow,
  processDueEvidenceRecovery,
  processRecoveryQueueRow,
  rawDocumentIdFromRecoveryRow,
  recoverDecisionHolds,
  requeueStaleRecoveryRows,
  storedMaterial,
  workerFailureState,
};
