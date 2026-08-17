const { VERSIONS } = require('../alertas/shadow-v2/config');
const { SEND_GATE_VERSION, evaluateSendGate } = require('../alertas/shadow-v2/sendGate');
const { registrarDigestItemsMIA } = require('../mia/digestItems');
const { registrarDigestAttempt } = require('../mia/digestAttempts');
const {
  abrirConversacionFeedbackDigest,
  prepararMensajeConLinksTracking,
} = require('./digest.service');
const {
  DELIVERY_STATUS,
  crearIdempotencyKey,
  crearMessageVersion,
} = require('../delivery/deliveryState');

const PRODUCTIVE_V2_ENGINE = VERSIONS.engine;
const PRODUCTIVE_V2_GATE_VERSION = 'shadow-v2-production-gate-1';
const FINAL_SEND_GATE_VERSION = 'final_send_gate_v1';
const PAID_SUBSCRIPTIONS = new Set(['corral', 'agricultor', 'cooperativa']);
const UNIQUE_VIOLATION = '23505';

function assertWorkflowDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error('fecha debe tener formato YYYY-MM-DD');
  }
}

function assertRunKey(value) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(value || '')
    )
  ) {
    throw new Error('run_key debe ser un UUID valido');
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function paidRun(run = {}) {
  return PAID_SUBSCRIPTIONS.has(
    String(objectValue(run.profile_snapshot).subscription || '').toLowerCase()
  );
}

function normalizedItems(items = []) {
  return [...items].sort(
    (left, right) => Number(left.final_position) - Number(right.final_position)
  );
}

function candidateMap(run = {}) {
  return new Map(
    (Array.isArray(run.candidate_cards) ? run.candidate_cards : []).map((candidate) => [
      Number(candidate?.alert_id),
      candidate,
    ])
  );
}

function validateRunForPromotion(run = {}, items = [], workflowDate) {
  const reasons = [];
  if (run.status !== 'GENERATED') reasons.push(`run_status_${run.status || 'missing'}`);
  if (run.engine_version !== PRODUCTIVE_V2_ENGINE) reasons.push('engine_version_mismatch');
  if (run.workflow_date !== workflowDate) reasons.push('workflow_date_mismatch');
  if (!String(run.digest_preview || '').trim()) reasons.push('digest_preview_missing');
  if (!paidRun(run)) reasons.push('subscription_not_paid');

  const ordered = normalizedItems(items);
  if (ordered.length === 0) reasons.push('digest_items_missing');
  if (ordered.length > 5) reasons.push('digest_items_overflow');
  const candidates = candidateMap(run);
  const seenAlerts = new Set();
  const diagnostics = [];

  ordered.forEach((item, index) => {
    const alertId = Number(item.alert_id);
    const candidate = candidates.get(alertId);
    const expectedPosition = index + 1;
    const itemReasons = [];
    if (!Number.isSafeInteger(alertId) || alertId <= 0) itemReasons.push('invalid_alert_id');
    if (Number(item.final_position) !== expectedPosition) itemReasons.push('invalid_position');
    if (seenAlerts.has(alertId)) itemReasons.push('duplicate_alert');
    seenAlerts.add(alertId);
    if (!candidate) {
      itemReasons.push('candidate_missing');
    } else {
      const persistedGate = objectValue(candidate.send_gate);
      const currentGate = evaluateSendGate({
        officialSnapshot: objectValue(candidate.official_snapshot),
        card: objectValue(candidate.card),
        workflowDate,
      });
      if (persistedGate.version !== SEND_GATE_VERSION || persistedGate.allowed !== true) {
        itemReasons.push('persisted_send_gate_invalid');
      }
      if (currentGate.version !== SEND_GATE_VERSION || currentGate.allowed !== true) {
        itemReasons.push(...currentGate.reasons.map((reason) => `current_send_gate_${reason}`));
      }
      const card = objectValue(candidate.card);
      if (String(item.summary_used || '') !== String(card.summary || ''))
        itemReasons.push('summary_projection_mismatch');
      if (String(item.action_used || '') !== String(card.action || ''))
        itemReasons.push('action_projection_mismatch');
      if (String(item.deadline_used || '') !== String(card.deadline || ''))
        itemReasons.push('deadline_projection_mismatch');
      if (!/^https?:\/\/\S+$/i.test(String(candidate.official_snapshot?.official_url || ''))) {
        itemReasons.push('official_url_missing');
      }
    }
    if (!String(item.personal_reason || '').trim()) itemReasons.push('personal_reason_missing');
    if (!String(item.rendered_block || '').trim()) itemReasons.push('rendered_block_missing');
    diagnostics.push({
      alert_id: Number.isSafeInteger(alertId) ? alertId : null,
      reasons: [...new Set(itemReasons)],
    });
    reasons.push(...itemReasons.map((reason) => `item_${expectedPosition}_${reason}`));
  });

  return {
    allowed: reasons.length === 0,
    version: PRODUCTIVE_V2_GATE_VERSION,
    reasons: [...new Set(reasons)],
    items: ordered,
    diagnostics,
  };
}

function buildProductAlert(item, candidate, run, gate) {
  const finalValidationDecision = {
    status: 'send',
    flags: [],
    reasons: [],
    source: 'shadow_v2_send_gate',
    validator_version: SEND_GATE_VERSION,
  };
  const decision = {
    action: 'include',
    incluir: true,
    motivo: String(item.personal_reason || '').slice(0, 240),
    riesgo: 'low',
    score: null,
    engine: PRODUCTIVE_V2_ENGINE,
  };
  return {
    id: Number(item.alert_id),
    titulo: item.title_used,
    resumen_final: item.summary_used,
    url: candidate.official_snapshot.official_url,
    fuente: candidate.official_snapshot.source || null,
    motivo_seleccion_mia: item.personal_reason,
    decision_digest: decision,
    shadow_decision: {
      future_decision: 'include',
      engine_version: PRODUCTIVE_V2_ENGINE,
      source_run_id: run.id,
      workflow_run_key: run.workflow_run_key,
      send_gate: gate,
    },
    effective_send_gate: {
      final_validation_decision: finalValidationDecision,
      effective_send_decision: 'send',
      effective_reason: 'shadow_v2_production_gate_allowed',
      gate_version: FINAL_SEND_GATE_VERSION,
      automatic_send_allowed: true,
    },
    final_validation: finalValidationDecision,
    final_validation_status: 'send',
    final_validation_flags: [],
    final_validation_reasons: [],
  };
}

function buildProductAlerts(run, validation) {
  const candidates = candidateMap(run);
  return validation.items.map((item) => {
    const candidate = candidates.get(Number(item.alert_id));
    const gate = evaluateSendGate({
      officialSnapshot: candidate.official_snapshot,
      card: candidate.card,
      workflowDate: run.workflow_date,
    });
    return buildProductAlert(item, candidate, run, gate);
  });
}

function buildDigestRow(run, message = run.digest_preview) {
  const body = String(message || '').trim();
  const messageVersion = crearMessageVersion(body, 'shadow_v2_message_v1');
  return {
    user_id: Number(run.user_id),
    fecha: run.workflow_date,
    mensaje: body,
    alerta_ids: [],
    enviado: false,
    delivery_status: DELIVERY_STATUS.DRAFT,
    message_version: messageVersion,
    idempotency_key: crearIdempotencyKey({
      source: 'digest_daily_v2',
      sourceId: run.id,
      messageVersion,
    }),
    organization_id: objectValue(run.profile_snapshot).organization_id || null,
  };
}

function sameProductiveRun(digest, run) {
  return String(digest?.idempotency_key || '').startsWith(`digest_daily_v2:${run?.id || ''}:`);
}

const promotionRepository = {
  async loadRuns(supabase, workflowDate, workflowRunKey) {
    const result = await supabase
      .from('shadow_v2_digest_runs')
      .select(
        'id, workflow_run_key, workflow_date, user_id, profile_snapshot, candidate_cards, engine_version, digest_preview, status, error_code, error_message'
      )
      .eq('workflow_date', workflowDate)
      .eq('workflow_run_key', workflowRunKey)
      .order('user_id', { ascending: true });
    if (result.error) throw result.error;
    return result.data || [];
  },
  async loadItems(supabase, runIds) {
    if (runIds.length === 0) return [];
    const result = await supabase
      .from('shadow_v2_digest_items')
      .select(
        'id, shadow_digest_run_id, alert_id, final_position, classification_snapshot, personal_reason, title_used, summary_used, action_used, deadline_used, rendered_block'
      )
      .in('shadow_digest_run_id', runIds)
      .order('final_position', { ascending: true });
    if (result.error) throw result.error;
    return result.data || [];
  },
  async findDigest(supabase, run) {
    const result = await supabase
      .from('digests')
      .select('id, user_id, fecha, enviado, delivery_status, idempotency_key, message_version')
      .eq('user_id', run.user_id)
      .eq('fecha', run.workflow_date)
      .maybeSingle();
    if (result.error) throw result.error;
    return result.data || null;
  },
  async insertDigest(supabase, row) {
    const result = await supabase.from('digests').insert(row).select('id').single();
    if (result.error) throw result.error;
    return { ...row, id: result.data.id };
  },
  async approveDigest(supabase, digestId, patch) {
    const result = await supabase
      .from('digests')
      .update(patch)
      .eq('id', digestId)
      .eq('enviado', false)
      .in('delivery_status', [DELIVERY_STATUS.DRAFT, DELIVERY_STATUS.APPROVED])
      .select('id')
      .single();
    if (result.error) throw result.error;
    return result.data;
  },
};

async function recordAttempt(recordAttempt, supabase, run, input) {
  const result = await recordAttempt(supabase, {
    userId: run.user_id,
    organizationId: objectValue(run.profile_snapshot).organization_id || null,
    fecha: run.workflow_date,
    kind: 'daily',
    ...input,
    metadata: {
      ...(input.metadata || {}),
      engine: PRODUCTIVE_V2_ENGINE,
      source_run_id: run.id,
      workflow_run_key: run.workflow_run_key,
      promotion_gate_version: PRODUCTIVE_V2_GATE_VERSION,
    },
  });
  if (!result?.ok) {
    throw new Error(
      `No se pudo registrar digest_attempt V2 para run ${run.id}: ${result?.error || result?.reason || 'error desconocido'}`
    );
  }
  return result;
}

async function promoteGeneratedRun({
  supabase,
  run,
  items,
  repo,
  registerItems,
  trackMessage,
  openFeedback,
  recordAttemptFn,
}) {
  const validation = validateRunForPromotion(run, items, run.workflow_date);
  if (!validation.allowed) {
    await recordAttempt(recordAttemptFn, supabase, run, {
      status: 'no_send',
      totalAlertasDia: 0,
      trasFiltroUsuario: Array.isArray(run.candidate_cards) ? run.candidate_cards.length : 0,
      trasScoring: validation.items.length,
      alertasFinales: 0,
      motivoNoEnvio: 'v2_promotion_gate_blocked',
      metadata: { validation },
    });
    return { status: 'blocked', run_id: run.id, user_id: run.user_id, reasons: validation.reasons };
  }

  let existing = await repo.findDigest(supabase, run);
  if (existing && !sameProductiveRun(existing, run)) {
    await recordAttempt(recordAttemptFn, supabase, run, {
      status: 'skipped_existing',
      alertasFinales: 0,
      motivoNoEnvio: 'digest_existing_other_engine',
      metadata: {
        existing_digest_id: existing.id,
        existing_engine: String(existing.idempotency_key || '').startsWith('digest_daily_v2:')
          ? 'v2'
          : 'v1',
      },
    });
    return {
      status: 'skipped_existing',
      run_id: run.id,
      user_id: run.user_id,
      digest_id: existing.id,
    };
  }
  if (existing && existing.delivery_status !== DELIVERY_STATUS.DRAFT) {
    await recordAttempt(recordAttemptFn, supabase, run, {
      status: 'generated',
      alertasFinales: validation.items.length,
      approvedCount: validation.items.length,
      digestId: existing.id,
      deliveryStatus: existing.delivery_status || DELIVERY_STATUS.APPROVED,
      metadata: { resumed: true },
    });
    return {
      status: 'already_promoted',
      run_id: run.id,
      user_id: run.user_id,
      digest_id: existing.id,
    };
  }

  const baseRow = buildDigestRow(run);
  if (!existing) {
    try {
      existing = await repo.insertDigest(supabase, baseRow);
    } catch (error) {
      if (error?.code !== UNIQUE_VIOLATION) throw error;
      existing = await repo.findDigest(supabase, run);
      if (!sameProductiveRun(existing, run)) throw error;
    }
  }

  const productAlerts = buildProductAlerts(run, validation);
  const itemResult = await registerItems(supabase, {
    digestId: existing.id,
    userId: run.user_id,
    fecha: run.workflow_date,
    alertas: productAlerts,
    origen: PRODUCTIVE_V2_ENGINE,
    organizationId: objectValue(run.profile_snapshot).organization_id || null,
  });
  if (!itemResult?.ok || itemResult.inserted !== productAlerts.length) {
    throw new Error(`No se pudieron persistir todos los digest_items V2 para run ${run.id}`);
  }

  const tracking = await trackMessage(supabase, {
    mensaje: baseRow.mensaje,
    userId: run.user_id,
    digestId: existing.id,
    alertas: productAlerts,
    organizationId: baseRow.organization_id,
  });
  const approvedMessage = String(tracking?.mensaje || baseRow.mensaje).trim();
  const messageVersion = crearMessageVersion(approvedMessage, 'shadow_v2_message_v1');
  await repo.approveDigest(supabase, existing.id, {
    mensaje: approvedMessage,
    alerta_ids: productAlerts.map((alert) => alert.id),
    delivery_status: DELIVERY_STATUS.APPROVED,
    message_version: messageVersion,
    idempotency_key: crearIdempotencyKey({
      source: 'digest_daily_v2',
      sourceId: run.id,
      messageVersion,
    }),
  });

  await recordAttempt(recordAttemptFn, supabase, run, {
    status: 'generated',
    totalAlertasDia: 0,
    trasFiltroUsuario: Array.isArray(run.candidate_cards) ? run.candidate_cards.length : 0,
    trasScoring: validation.items.length,
    alertasFinales: validation.items.length,
    approvedCount: validation.items.length,
    digestId: existing.id,
    deliveryStatus: DELIVERY_STATUS.APPROVED,
    metadata: {
      validation,
      tracking_enabled: tracking?.enabled === true,
      tracking_links: Array.isArray(tracking?.links) ? tracking.links.length : 0,
    },
  });

  try {
    await openFeedback(supabase, {
      userId: run.user_id,
      digestId: existing.id,
      alertaIds: productAlerts.map((alert) => alert.id),
      fecha: run.workflow_date,
      organizationId: baseRow.organization_id,
    });
  } catch (error) {
    return {
      status: 'promoted',
      run_id: run.id,
      user_id: run.user_id,
      digest_id: existing.id,
      warnings: [`feedback_conversation:${error.message}`],
    };
  }

  return {
    status: 'promoted',
    run_id: run.id,
    user_id: run.user_id,
    digest_id: existing.id,
    warnings: [],
  };
}

async function promoteShadowV2Digests({
  supabase,
  workflowDate,
  workflowRunKey,
  repo = promotionRepository,
  registerItems = registrarDigestItemsMIA,
  trackMessage = prepararMensajeConLinksTracking,
  openFeedback = abrirConversacionFeedbackDigest,
  recordAttemptFn = registrarDigestAttempt,
} = {}) {
  assertWorkflowDate(workflowDate);
  assertRunKey(workflowRunKey);
  if (!supabase) throw new Error('Supabase es obligatorio');

  const runs = await repo.loadRuns(supabase, workflowDate, workflowRunKey);
  if (runs.length === 0) throw new Error('No existen resultados V2 para promover');
  const incomplete = runs.filter(
    (run) => run.workflow_date !== workflowDate || run.workflow_run_key !== workflowRunKey
  );
  if (incomplete.length > 0) throw new Error('La ejecucion V2 no coincide con fecha y run-key');

  const paidRuns = runs.filter(paidRun);
  const generatedRuns = paidRuns.filter((run) => run.status === 'GENERATED');
  const allItems = await repo.loadItems(
    supabase,
    generatedRuns.map((run) => run.id)
  );
  const itemsByRun = new Map();
  for (const item of allItems) {
    const key = String(item.shadow_digest_run_id);
    if (!itemsByRun.has(key)) itemsByRun.set(key, []);
    itemsByRun.get(key).push(item);
  }

  const results = [];
  const errors = [];
  for (const run of paidRuns) {
    if (run.status !== 'GENERATED') {
      const reason =
        run.status === 'EMPTY'
          ? 'v2_empty'
          : run.status === 'NO_CANDIDATES'
            ? 'v2_no_candidates'
            : 'v2_error';
      await recordAttempt(recordAttemptFn, supabase, run, {
        status: run.status === 'ERROR' ? 'failed' : 'no_send',
        alertasFinales: 0,
        motivoNoEnvio: reason,
        errorMsg: run.error_message || null,
        metadata: { shadow_status: run.status, error_code: run.error_code || null },
      });
      results.push({ status: 'no_send', run_id: run.id, user_id: run.user_id, reason });
      continue;
    }
    try {
      results.push(
        await promoteGeneratedRun({
          supabase,
          run,
          items: itemsByRun.get(String(run.id)) || [],
          repo,
          registerItems,
          trackMessage,
          openFeedback,
          recordAttemptFn,
        })
      );
    } catch (error) {
      errors.push({ run_id: run.id, user_id: run.user_id, error: error.message });
    }
  }

  const summary = {
    success: errors.length === 0,
    engine: PRODUCTIVE_V2_ENGINE,
    workflow_date: workflowDate,
    workflow_run_key: workflowRunKey,
    total_runs: runs.length,
    paid_runs: paidRuns.length,
    generated_runs: generatedRuns.length,
    promoted: results.filter((result) => result.status === 'promoted').length,
    already_promoted: results.filter((result) => result.status === 'already_promoted').length,
    skipped_existing: results.filter((result) => result.status === 'skipped_existing').length,
    blocked: results.filter((result) => result.status === 'blocked').length,
    no_send: results.filter((result) => result.status === 'no_send').length,
    warnings: results.flatMap((result) => result.warnings || []),
    results,
    errors,
  };
  if (errors.length > 0) {
    const error = new Error(`Promocion V2 incompleta: ${errors.length} errores`);
    error.summary = summary;
    throw error;
  }
  return summary;
}

module.exports = {
  PRODUCTIVE_V2_ENGINE,
  PRODUCTIVE_V2_GATE_VERSION,
  FINAL_SEND_GATE_VERSION,
  PAID_SUBSCRIPTIONS,
  paidRun,
  validateRunForPromotion,
  buildProductAlerts,
  buildDigestRow,
  sameProductiveRun,
  promotionRepository,
  promoteGeneratedRun,
  promoteShadowV2Digests,
};
