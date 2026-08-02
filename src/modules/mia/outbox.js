const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRY_MS = 60 * 60 * 1000;
const DEFAULT_SENDING_TIMEOUT_MS = 10 * 60 * 1000;
const {
  limpiarRespuestaMIA,
  evaluarRespuestaMIA,
  formatearRespuestaWhatsAppMIA,
} = require('./replyGuard');
const { conOrganizationId, obtenerMiaBranding } = require('./organizationContext');
const {
  DELIVERY_STATUS,
  crearMessageVersion,
  crearIdempotencyKey,
  puedeIntentarEnvio,
  esEstadoAceptadoOSuperior,
} = require('../delivery/deliveryState');
const {
  registrarAceptacionProveedor,
  registrarFalloProveedor,
} = require('../delivery/deliveryService');
const {
  digestIdDeOutboxItem,
  filtrarDigestsPorAutoridadFinal,
} = require('../digest/digestOutbox');
const { clasificarFalloUltraMsg } = require('../../platform/whatsapp/errorClassification');

function getMaxAttempts() {
  const value = Number(process.env.MIA_OUTBOX_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS);
  return Number.isFinite(value) && value > 0 ? Math.min(20, Math.floor(value)) : DEFAULT_MAX_ATTEMPTS;
}

function getSendingTimeoutMs() {
  const value = Number(process.env.MIA_OUTBOX_SENDING_TIMEOUT_MS || DEFAULT_SENDING_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 60 * 1000
    ? Math.min(60 * 60 * 1000, Math.floor(value))
    : DEFAULT_SENDING_TIMEOUT_MS;
}

function calcularNextAttemptAt(attempts, nowMs = Date.now()) {
  const intentos = Math.max(1, Number(attempts) || 1);
  const delay = Math.min(DEFAULT_MAX_RETRY_MS, DEFAULT_BASE_RETRY_MS * (2 ** (intentos - 1)));
  return new Date(nowMs + delay).toISOString();
}

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

function normalizarSourceWhatsApp(source) {
  return String(source || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function normalizarDigestId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function resultadoOutboxExistente(item, row) {
  return {
    ok: true,
    available: true,
    queued: false,
    existing: true,
    id: item.id,
    status: item.status,
    delivery_status: item.delivery_status || null,
    provider_message_id: item.provider_message_id || null,
    provider_status: item.provider_status || null,
    idempotency_key: item.idempotency_key || row.idempotency_key,
    message_version: item.message_version || row.message_version,
    attempts: item.attempts || 0,
    body: item.body || row.body,
  };
}

async function encolarComunicacionWhatsApp(supabase, {
  source,
  sourceId = null,
  userId = null,
  toPhone,
  body,
  organizationId = null,
  metadata = {},
} = {}) {
  const normalizedSource = normalizarSourceWhatsApp(source);
  const normalizedBody = String(body || '').trim();
  const normalizedPhone = String(toPhone || '').trim();
  if (!normalizedSource || !normalizedBody || !normalizedPhone) {
    return {
      ok: false,
      available: true,
      queued: false,
      reason: !normalizedSource
        ? 'whatsapp_source_required'
        : (!normalizedPhone ? 'whatsapp_phone_required' : 'whatsapp_body_required'),
    };
  }

  const messageVersion = crearMessageVersion(normalizedBody, `${normalizedSource}_v1`);
  const idempotencyKey = crearIdempotencyKey({
    source: normalizedSource,
    sourceId,
    messageVersion,
    fallback: `${userId || ''}|${normalizedBody}`,
  });
  const metadataJson = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};
  const digestId = normalizarDigestId(metadataJson.digest_id);
  const row = conOrganizationId({
    user_id: userId,
    channel: 'whatsapp',
    to_phone: normalizedPhone,
    body: normalizedBody,
    status: 'queued',
    delivery_status: DELIVERY_STATUS.QUEUED,
    message_version: messageVersion,
    idempotency_key: idempotencyKey,
    attempts: 0,
    next_attempt_at: new Date().toISOString(),
    ...(digestId ? { digest_id: digestId } : {}),
    metadata_json: {
      ...metadataJson,
      source: normalizedSource,
      source_id: sourceId ?? null,
      message_version: messageVersion,
    },
  }, organizationId);

  try {
    const { data, error } = await supabase
      .from('mia_outbox')
      .insert(row)
      .select('id')
      .single();
    if (error) throw error;
    return {
      ok: true,
      available: true,
      queued: true,
      existing: false,
      id: data?.id || null,
      status: row.status,
      delivery_status: row.delivery_status,
      idempotency_key: row.idempotency_key,
      message_version: row.message_version,
      attempts: 0,
      body: row.body,
    };
  } catch (error) {
    if (error?.code === '23505') {
      let { data: existing, error: readError } = await supabase
        .from('mia_outbox')
        .select('id, status, attempts, body, delivery_status, provider_message_id, provider_status, idempotency_key, message_version')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (readError) {
        console.warn('[mia:outbox] No se pudo recuperar comunicacion duplicada:', readError.message);
        return { ok: false, available: false, queued: false, error: readError.message };
      }
      if (!existing?.id
        && metadataJson.intent === 'learning_question'
        && digestId
        && userId) {
        ({ data: existing, error: readError } = await supabase
          .from('mia_outbox')
          .select('id, status, attempts, body, delivery_status, provider_message_id, provider_status, idempotency_key, message_version')
          .eq('user_id', userId)
          .eq('digest_id', digestId)
          .contains('metadata_json', { intent: 'learning_question' })
          .limit(1)
          .maybeSingle());
        if (readError) {
          console.warn('[mia:outbox] No se pudo recuperar pregunta duplicada:', readError.message);
          return { ok: false, available: false, queued: false, error: readError.message };
        }
      }
      if (existing?.id) return resultadoOutboxExistente(existing, row);
    }

    console.warn('[mia:outbox] No se pudo encolar comunicacion WhatsApp:', error.message);
    return { ok: false, available: false, queued: false, error: error.message };
  }
}

function construirOutboxDesdeDecision({
  decision = {},
  inboundId = null,
  decisionId = null,
  userId,
  toPhone,
  organizationId = null,
}) {
  const reply = decision.reply_action;
  if (!reply?.texto || reply.canal !== 'whatsapp') return null;
  const branding = obtenerMiaBranding(decision.organization_context || null);
  const guarded = limpiarRespuestaMIA(reply.texto, {
    maxChars: 4000,
    senderName: branding.reply_sender,
    supportLabel: branding.support_label,
  });
  if (!guarded.text) return null;
  const formatted = formatearRespuestaWhatsAppMIA(guarded.text, {
    maxChars: 4000,
    assistantName: branding.assistant_name,
    senderName: branding.reply_sender,
    supportLabel: branding.agent_label,
  });
  if (!formatted.text) return null;
  const evaluation = evaluarRespuestaMIA(formatted.text, {
    decision,
    senderName: branding.reply_sender,
    supportLabel: branding.support_label,
  });

  const messageVersion = crearMessageVersion(formatted.text, 'mia_reply_v1');
  const identitySource = decisionId || inboundId || null;
  const idempotencyKey = crearIdempotencyKey({
    source: decisionId ? 'mia_decision' : inboundId ? 'mia_inbound' : 'mia_reply',
    sourceId: identitySource,
    messageVersion,
    fallback: `${userId || ''}|${formatted.text}`,
  });

  return conOrganizationId({
    decision_id: decisionId,
    inbound_id: inboundId,
    user_id: userId,
    channel: 'whatsapp',
    to_phone: toPhone,
    body: formatted.text,
    status: 'queued',
    delivery_status: DELIVERY_STATUS.QUEUED,
    message_version: messageVersion,
    idempotency_key: idempotencyKey,
    attempts: 0,
    next_attempt_at: new Date().toISOString(),
    metadata_json: {
      intent: decision.intent || null,
      confidence: decision.confidence ?? null,
      decision_version: decision.version || null,
      risk_flags: decision.risk_flags || [],
      knowledge_context: decision.knowledge_context || null,
      organization_context: decision.organization_context || null,
      message_version: messageVersion,
      reply_guard: {
        flags: [...new Set([...(guarded.flags || []), ...(formatted.flags || []), ...(evaluation.flags || [])])],
        changed: guarded.changed || formatted.changed,
      },
    },
  }, organizationId);
}

async function buscarOutboxExistenteMIA(supabase, row) {
  if (!row?.decision_id && !row?.inbound_id) return { ok: true, available: true, item: null };

  try {
    let query = supabase
      .from('mia_outbox')
      .select('id, status, attempts, body, to_phone, delivery_status, provider_message_id, provider_status, idempotency_key, message_version, created_at')
      .eq('channel', row.channel)
      .eq('to_phone', row.to_phone)
      .order('created_at', { ascending: false })
      .limit(1);

    if (row.decision_id) query = query.eq('decision_id', row.decision_id);
    else query = query.eq('inbound_id', row.inbound_id);

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return { ok: true, available: true, item: data || null };
  } catch (error) {
    console.warn('[mia:outbox] No se pudo buscar outbox existente:', error.message);
    return { ok: false, available: false, item: null, error: error.message };
  }
}

async function encolarRespuestaMIA(supabase, options = {}) {
  const row = construirOutboxDesdeDecision(options);
  if (!row) return { ok: true, available: true, queued: false, id: null };

  try {
    const existente = await buscarOutboxExistenteMIA(supabase, row);
    if (!existente.available) {
      return {
        ok: existente.ok,
        available: false,
        queued: false,
        reason: existente.reason || 'mia_outbox_no_disponible',
        error: existente.error || null,
        body: row.body,
      };
    }
    if (existente.item?.id) {
      return resultadoOutboxExistente(existente.item, row);
    }

    const { data, error } = await supabase
      .from('mia_outbox')
      .insert(row)
      .select('id')
      .single();

    if (error) throw error;
    return {
      ok: true,
      available: true,
      queued: true,
      id: data?.id || null,
      body: row.body,
      status: row.status,
      delivery_status: row.delivery_status,
      idempotency_key: row.idempotency_key,
      message_version: row.message_version,
    };
  } catch (error) {
    console.warn('[mia:outbox] No se pudo encolar respuesta:', error.message);
    return { ok: false, available: false, queued: false, error: error.message, body: row.body };
  }
}

async function reclamarOutboxParaEnvio(supabase, id) {
  if (!id) return false;
  const now = new Date().toISOString();
  const maxAttempts = getMaxAttempts();

  try {
    const { data, error } = await supabase
      .from('mia_outbox')
      .update({
        status: 'sending',
        updated_at: now,
      })
      .eq('id', id)
      .in('status', ['queued', 'failed'])
      .or(`delivery_status.is.null,delivery_status.in.(${[
        DELIVERY_STATUS.DRAFT,
        DELIVERY_STATUS.APPROVED,
        DELIVERY_STATUS.QUEUED,
      ].join(',')})`)
      .lte('next_attempt_at', now)
      .lt('attempts', maxAttempts)
      .select('id, digest_id, decision_id, inbound_id, user_id, channel, to_phone, body, status, attempts, metadata_json, idempotency_key, message_version, delivery_status, provider_message_id, provider_status, created_at')
      .maybeSingle();

    if (error) throw error;
    if (!data) return { ok: true, available: true, claimed: false, reason: 'outbox_no_reclamable' };
    return { ok: true, available: true, claimed: true, item: data };
  } catch (error) {
    console.warn('[mia:outbox] No se pudo marcar sending:', error.message);
    return { ok: false, available: false, claimed: false, error: error.message };
  }
}

async function recuperarOutboxSendingAtascadoMIA(supabase, { timeoutMs = getSendingTimeoutMs(), limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));

  try {
    const { data: stuck, error: selectError } = await supabase
      .from('mia_outbox')
      .select('id, attempts, delivery_status, provider_message_id')
      .eq('status', 'sending')
      .lt('updated_at', cutoff)
      .order('updated_at', { ascending: true })
      .limit(safeLimit);

    if (selectError) throw selectError;
    const items = stuck || [];
    if (items.length === 0) {
      return { ok: true, available: true, recovered: 0, ids: [] };
    }

    const now = new Date().toISOString();
    const updates = [];
    for (const item of items) {
      const attempts = Number(item.attempts || 0) + 1;
      const providerTracked = Boolean(item.provider_message_id);
      const { error } = await supabase
        .from('mia_outbox')
        .update({
          status: 'failed',
          attempts,
          last_error: 'sending_timeout_requires_reconciliation',
          next_attempt_at: null,
          provider_error_code: 'sending_timeout_ambiguous',
          provider_error_reason: 'El proceso se reinicio durante el envio; no se reenvia para evitar duplicados',
          reconcile_after: now,
          delivery_updated_at: now,
          ...(providerTracked && !esEstadoAceptadoOSuperior(item.delivery_status) ? {
            delivery_status: DELIVERY_STATUS.PROVIDER_ACCEPTED,
            accepted_at: now,
          } : {}),
          updated_at: now,
        })
        .eq('id', item.id)
        .eq('status', 'sending');

      if (!error) updates.push(item.id);
      else console.warn('[mia:outbox] No se pudo recuperar sending atascado:', error.message);
    }

    return { ok: true, available: true, recovered: updates.length, ids: updates };
  } catch (error) {
    console.warn('[mia:outbox] No se pudieron recuperar envios atascados:', error.message);
    return { ok: false, available: false, recovered: 0, ids: [], error: error.message };
  }
}

async function cargarOutboxPendiente(supabase, limit = 20) {
  try {
    await recuperarOutboxSendingAtascadoMIA(supabase, { limit: 100 });
    const maxAttempts = getMaxAttempts();
    const { data, error } = await supabase
      .from('mia_outbox')
      .select('id, digest_id, decision_id, inbound_id, user_id, channel, to_phone, body, status, attempts, last_error, next_attempt_at, created_at, metadata_json, idempotency_key, message_version, delivery_status, provider_message_id, provider_status, accepted_at, sent_to_whatsapp_at, delivered_at, read_at, reconcile_after, reconciliation_attempts')
      .in('status', ['queued', 'failed'])
      .lte('next_attempt_at', new Date().toISOString())
      .lt('attempts', maxAttempts)
      .order('created_at', { ascending: true })
      .limit(Math.max(1, Math.min(100, Number(limit) || 20)));

    if (error) throw error;
    return { ok: true, available: true, items: data || [] };
  } catch (error) {
    return { ok: false, available: false, items: [], error: error.message };
  }
}

async function procesarOutboxItemMIA(supabase, item, enviarFn) {
  if (!item?.id) return { id: null, ok: false, status: 'invalid', error: 'outbox_id_missing' };
  if (typeof enviarFn !== 'function') return { id: item.id, ok: false, status: 'invalid', error: 'send_fn_missing' };

  if (esEstadoAceptadoOSuperior(item.delivery_status) || !puedeIntentarEnvio(item.delivery_status)) {
    return {
      id: item.id,
      ok: true,
      skipped: true,
      status: 'requires_reconciliation',
      delivery_status: item.delivery_status,
      reason: 'delivery_already_accepted_or_terminal',
    };
  }

  const digestId = digestIdDeOutboxItem(item);
  if (digestId) {
    const authority = await filtrarDigestsPorAutoridadFinal(supabase, [{ id: digestId }]);
    const blocked = authority.bloqueados[0] || null;
    if (blocked) {
      const gateError = new Error(blocked.reason);
      gateError.providerCode = 'final_send_gate_blocked';
      gateError.retryable = false;
      gateError.permanent = true;
      return registrarFalloProveedor(supabase, item, gateError, {
        attempts: getMaxAttempts(),
        maxAttempts: getMaxAttempts(),
        nextAttemptAt: null,
      });
    }
  }

  const claim = await reclamarOutboxParaEnvio(supabase, item.id);
  if (!claim.claimed) {
    return {
      id: item.id,
      ok: claim.ok !== false,
      skipped: true,
      status: 'not_claimed',
      reason: claim.reason || claim.error || 'outbox_no_reclamable',
    };
  }

  const claimedItem = { ...item, ...(claim.item || {}) };
  if (esEstadoAceptadoOSuperior(claimedItem.delivery_status) || !puedeIntentarEnvio(claimedItem.delivery_status)) {
    return {
      id: claimedItem.id,
      ok: true,
      skipped: true,
      status: 'requires_reconciliation',
      delivery_status: claimedItem.delivery_status,
      reason: 'delivery_changed_before_send',
    };
  }

  let providerResult;
  try {
    providerResult = await enviarFn(claimedItem.to_phone, claimedItem.body, {
      outboxId: claimedItem.id,
      digestId,
      userId: claimedItem.user_id || null,
      idempotencyKey: claimedItem.idempotency_key || null,
      messageVersion: claimedItem.message_version || null,
      messageType: digestId ? 'digest_pro' : 'mia_reply',
    });
  } catch (errEnvio) {
    if (typeof errEnvio.retryable !== 'boolean') {
      const classification = clasificarFalloUltraMsg({
        httpStatus: errEnvio.httpStatus || errEnvio.status || null,
        code: errEnvio.providerCode || errEnvio.code || '',
        message: errEnvio.message,
      });
      errEnvio.retryable = classification.retryable;
      errEnvio.permanent = classification.permanent;
      errEnvio.ambiguous = classification.ambiguous;
      errEnvio.providerCode = classification.code;
    }
    const attempts = Number(claimedItem.attempts || 0) + 1;
    return registrarFalloProveedor(supabase, claimedItem, errEnvio, {
      attempts,
      maxAttempts: getMaxAttempts(),
      nextAttemptAt: calcularNextAttemptAt(attempts),
    });
  }

  try {
    return await registrarAceptacionProveedor(supabase, claimedItem, providerResult || {});
  } catch (persistError) {
    // UltraMsg ya contesto. Nunca se reenvia por un fallo posterior de Supabase:
    // el item queda para conciliacion/operacion, no para un segundo transporte.
    return {
      id: claimedItem.id,
      ok: false,
      status: 'provider_accepted_unpersisted',
      delivery_status: DELIVERY_STATUS.PROVIDER_ACCEPTED,
      provider_message_id: providerResult?.providerMessageId || null,
      retryable: false,
      ambiguous: true,
      requires_reconciliation: true,
      error: String(persistError.message || 'delivery_persistence_failed').slice(0, 500),
    };
  }
}

function calcularOutboxHealthMIA(items = [], {
  now = new Date(),
  maxAttempts = getMaxAttempts(),
  sendingTimeoutMs = getSendingTimeoutMs(),
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const byStatus = contarPor(list, (item) => item.status);
  const byDeliveryStatus = contarPor(list, (item) => item.delivery_status || 'UNKNOWN');
  const due = [];
  const deadLetter = [];
  const stuckSending = [];
  const reconciliationRequired = [];
  const manualReconciliationRequired = [];
  const pending = [];
  const nowMs = now.getTime();

  for (const item of list) {
    const attempts = Number(item.attempts || 0);
    const status = item.status || 'unknown';
    const nextAttemptMs = item.next_attempt_at ? new Date(item.next_attempt_at).getTime() : null;
    const updatedMs = item.updated_at ? new Date(item.updated_at).getTime() : null;

    if (['queued', 'failed', 'sending'].includes(status)) pending.push(item);
    if (
      attempts < maxAttempts &&
      ((status === 'queued' && (!nextAttemptMs || nextAttemptMs <= nowMs)) ||
        (status === 'failed' && nextAttemptMs && nextAttemptMs <= nowMs))
    ) {
      due.push(item);
    }
    if (item.reconcile_after && !item.next_attempt_at && !['DELIVERED', 'READ'].includes(item.delivery_status)) {
      reconciliationRequired.push(item);
      if (!item.provider_message_id) manualReconciliationRequired.push(item);
    }
    if (status === 'failed' && attempts >= maxAttempts) deadLetter.push(item);
    if (status === 'sending' && (!updatedMs || nowMs - updatedMs > sendingTimeoutMs)) stuckSending.push(item);
  }

  const oldestPending = pending
    .map((item) => item.created_at)
    .filter(Boolean)
    .sort()[0] || null;
  const pendingAgeMinutes = oldestPending
    ? redondear((nowMs - new Date(oldestPending).getTime()) / (60 * 1000), 1)
    : 0;

  let score = 100;
  score -= Math.min(35, deadLetter.length * 12);
  score -= Math.min(28, stuckSending.length * 10);
  score -= Math.min(30, reconciliationRequired.length * 12);
  score -= Math.min(20, (byStatus.failed || 0) * 4);
  score -= Math.min(12, Math.max(0, pendingAgeMinutes - 30) / 10);
  score = Math.max(0, Math.min(100, redondear(score, 1)));

  const recommendations = [];
  if (deadLetter.length > 0) {
    recommendations.push({
      priority: 'alta',
      area: 'outbox',
      title: 'Resolver respuestas agotadas',
      detail: 'Hay respuestas de MIA que superaron el maximo de intentos. Requieren revision manual o reencolado.',
    });
  }
  if (stuckSending.length > 0) {
    recommendations.push({
      priority: 'alta',
      area: 'outbox',
      title: 'Recuperar envios atascados',
      detail: 'Hay mensajes en sending demasiado tiempo. El recuperador los bloquea para conciliacion, sin reenviarlos a ciegas.',
    });
  }
  if (reconciliationRequired.length > 0) {
    recommendations.push({
      priority: 'alta',
      area: 'delivery',
      title: 'Conciliar entregas ambiguas',
      detail: manualReconciliationRequired.length > 0
        ? 'Hay mensajes ambiguos sin ID del proveedor. No deben reenviarse: requieren revision operativa manual.'
        : 'Hay mensajes que no deben reenviarse a ciegas. Ejecuta la conciliacion de WhatsApp.',
    });
  }
  if (due.length > 10) {
    recommendations.push({
      priority: 'media',
      area: 'outbox',
      title: 'Procesar cola pendiente',
      detail: 'Hay bastantes respuestas listas para enviar. Ejecuta send-pending o activa el worker recurrente.',
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'baja',
      area: 'outbox',
      title: 'Outbox estable',
      detail: 'No se ven respuestas atascadas ni agotadas en la muestra analizada.',
    });
  }

  return {
    ok: score >= 85
      && deadLetter.length === 0
      && stuckSending.length === 0
      && reconciliationRequired.length === 0,
    score,
    grade: score >= 90 ? 'enterprise_ready' : score >= 75 ? 'production_ready' : score >= 60 ? 'needs_attention' : 'blocked',
    metrics: {
      total: list.length,
      pending: pending.length,
      due_now: due.length,
      dead_letter: deadLetter.length,
      stuck_sending: stuckSending.length,
      pending_age_minutes: pendingAgeMinutes,
      failed_rate: porcentaje(byStatus.failed || 0, list.length),
      provider_accepted: byDeliveryStatus[DELIVERY_STATUS.PROVIDER_ACCEPTED] || 0,
      sent_to_whatsapp: byDeliveryStatus[DELIVERY_STATUS.SENT_TO_WHATSAPP] || 0,
      delivered: byDeliveryStatus[DELIVERY_STATUS.DELIVERED] || 0,
      read: byDeliveryStatus[DELIVERY_STATUS.READ] || 0,
      undelivered: byDeliveryStatus[DELIVERY_STATUS.UNDELIVERED] || 0,
      delivery_failed: byDeliveryStatus[DELIVERY_STATUS.FAILED] || 0,
      delivery_unknown: byDeliveryStatus.UNKNOWN || 0,
      reconciliation_required: reconciliationRequired.length,
      manual_reconciliation_required: manualReconciliationRequired.length,
    },
    breakdown: {
      by_status: byStatus,
      by_delivery_status: byDeliveryStatus,
    },
    samples: {
      due_now: due.slice(0, 20).map((item) => ({ id: item.id, status: item.status, delivery_status: item.delivery_status })),
      dead_letter: deadLetter.slice(0, 20).map((item) => ({ id: item.id, status: item.status, delivery_status: item.delivery_status })),
      stuck_sending: stuckSending.slice(0, 20).map((item) => ({ id: item.id, status: item.status, delivery_status: item.delivery_status })),
      reconciliation_required: reconciliationRequired.slice(0, 20).map((item) => ({
        id: item.id,
        status: item.status,
        delivery_status: item.delivery_status,
        provider_message_tracked: Boolean(item.provider_message_id),
      })),
    },
    recommendations,
  };
}

async function generarOutboxHealthMIA(supabase, { hours = 72, limit = 1000 } = {}) {
  const safeHours = Math.max(1, Math.min(720, Number(hours) || 72));
  const safeLimit = Math.max(50, Math.min(5000, Number(limit) || 1000));
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();

  const recovery = await recuperarOutboxSendingAtascadoMIA(supabase, { limit: 200 });
  const select = 'id, decision_id, inbound_id, user_id, channel, status, delivery_status, provider_message_id, provider_status, attempts, last_error, next_attempt_at, sent_at, accepted_at, sent_to_whatsapp_at, delivered_at, read_at, failed_at, reconcile_after, reconciliation_attempts, created_at, updated_at';
  const [pendingResult, recentResult] = await Promise.all([
    supabase
      .from('mia_outbox')
      .select(select)
      .in('status', ['queued', 'failed', 'sending'])
      .order('created_at', { ascending: true })
      .limit(safeLimit),
    supabase
      .from('mia_outbox')
      .select(select)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(safeLimit),
  ]);

  if (pendingResult.error) throw pendingResult.error;
  if (recentResult.error) throw recentResult.error;

  const byId = new Map();
  for (const item of [...(pendingResult.data || []), ...(recentResult.data || [])]) {
    byId.set(item.id, item);
  }

  return {
    available: true,
    since,
    recovered_stuck: recovery.recovered || 0,
    ...calcularOutboxHealthMIA([...byId.values()]),
  };
}

module.exports = {
  normalizarDigestId,
  encolarComunicacionWhatsApp,
  construirOutboxDesdeDecision,
  buscarOutboxExistenteMIA,
  encolarRespuestaMIA,
  reclamarOutboxParaEnvio,
  recuperarOutboxSendingAtascadoMIA,
  cargarOutboxPendiente,
  procesarOutboxItemMIA,
  calcularOutboxHealthMIA,
  generarOutboxHealthMIA,
  calcularNextAttemptAt,
  getMaxAttempts,
  getSendingTimeoutMs,
};
