const crypto = require('crypto');
const {
  DELIVERY_STATUS,
  normalizarDeliveryStatus,
  normalizarProviderStatus,
  deliveryStatusDesdeProveedor,
  resolverTransicionEntrega,
  parsearAckUltraMsg,
  crearEventHash,
  sanitizarPayloadEntrega,
  isoTimestamp,
} = require('./deliveryState');
const { actualizarDigestAttemptPorDigest } = require('../mia/digestAttempts');
const {
  construirMemoriaAtomica,
  guardarMemoriasAtomicas,
} = require('../aprendizaje/atomicMemory');

const LEARNING_QUESTION_EFFECT_VERSION = 'learning_question_delivery_v1';
const DEFAULT_LEARNING_QUESTION_LEASE_MS = 5 * 60 * 1000;
const SUCCESSFUL_DELIVERY_STATUSES = new Set([
  DELIVERY_STATUS.DELIVERED,
  DELIVERY_STATUS.READ,
]);

const OUTBOX_DELIVERY_SELECT = [
  'id',
  'digest_id',
  'user_id',
  'organization_id',
  'to_phone',
  'body',
  'status',
  'attempts',
  'metadata_json',
  'idempotency_key',
  'message_version',
  'delivery_status',
  'provider',
  'provider_message_id',
  'provider_status',
  'accepted_at',
  'sent_to_whatsapp_at',
  'delivered_at',
  'read_at',
  'failed_at',
  'delivery_updated_at',
  'reconcile_after',
  'reconciliation_attempts',
  'provider_error_code',
  'provider_error_reason',
  'sent_at',
  'next_attempt_at',
  'updated_at',
].join(', ');

function digestIdDeItem(item = {}) {
  const raw = item?.digest_id ?? item?.metadata_json?.digest_id;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function fechaReconciliacion(status, from = new Date()) {
  const normalized = normalizarDeliveryStatus(status);
  if ([DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ, DELIVERY_STATUS.FAILED, DELIVERY_STATUS.UNDELIVERED].includes(normalized)) {
    return null;
  }
  const parsedBase = from instanceof Date ? from.getTime() : new Date(from).getTime();
  const base = Number.isFinite(parsedBase) ? parsedBase : Date.now();
  const defaultDelay = normalized === DELIVERY_STATUS.SENT_TO_WHATSAPP
    ? 30 * 60 * 1000
    : 10 * 60 * 1000;
  const configuredDelay = Number(
    normalized === DELIVERY_STATUS.SENT_TO_WHATSAPP
      ? process.env.ULTRAMSG_RECONCILE_SENT_MS
      : process.env.ULTRAMSG_RECONCILE_ACCEPTED_MS
  );
  const delay = Number.isFinite(configuredDelay) && configuredDelay > 0
    ? configuredDelay
    : defaultDelay;
  return new Date(base + Math.max(60 * 1000, delay)).toISOString();
}

function timeoutReconciliacionMs() {
  const configured = Number(process.env.ULTRAMSG_RECONCILE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 1000
    ? Math.min(configured, 60 * 1000)
    : 15000;
}

function metadataDeItem(item = {}) {
  return item?.metadata_json && typeof item.metadata_json === 'object' && !Array.isArray(item.metadata_json)
    ? item.metadata_json
    : {};
}

function marcadorPreguntaAprendizaje(item = {}) {
  const marker = metadataDeItem(item)?.delivery_effects?.learning_question;
  return marker && typeof marker === 'object' && !Array.isArray(marker) ? marker : null;
}

function metadataConMarcadorPregunta(item, marker) {
  const metadata = metadataDeItem(item);
  const effects = metadata.delivery_effects && typeof metadata.delivery_effects === 'object'
    ? metadata.delivery_effects
    : {};
  return {
    ...metadata,
    delivery_effects: {
      ...effects,
      learning_question: marker,
    },
  };
}

function esPreguntaAprendizaje(item = {}) {
  return metadataDeItem(item).intent === 'learning_question';
}

function learningQuestionLeaseMs() {
  const configured = Number(process.env.MIA_LEARNING_POSTPROCESS_LEASE_MS);
  if (!Number.isFinite(configured)) return DEFAULT_LEARNING_QUESTION_LEASE_MS;
  return Math.max(30 * 1000, Math.min(60 * 60 * 1000, configured));
}

function leasePreguntaAprendizajeVencido(marker, now = new Date()) {
  if (marker?.status !== 'processing') return false;
  const leaseExpiresAt = new Date(marker.lease_expires_at || '').getTime();
  if (Number.isFinite(leaseExpiresAt)) return now.getTime() >= leaseExpiresAt;
  const claimedAt = new Date(marker.claimed_at || '').getTime();
  if (!Number.isFinite(claimedAt)) return true;
  return now.getTime() - claimedAt >= learningQuestionLeaseMs();
}

function crearClaimTokenPreguntaAprendizaje() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function patchParaEstado(item, requestedStatus, {
  eventAt = new Date().toISOString(),
  providerMessageId = null,
  providerStatus = null,
  providerErrorCode = null,
  providerErrorReason = null,
} = {}) {
  const transition = resolverTransicionEntrega(item?.delivery_status, requestedStatus);
  if (!transition.apply) return { transition, patch: null };

  const status = transition.status;
  const patch = {
    delivery_status: status,
    delivery_updated_at: eventAt,
    reconcile_after: fechaReconciliacion(status, eventAt),
  };
  if (providerMessageId) patch.provider_message_id = providerMessageId;
  if (providerStatus) patch.provider_status = providerStatus;

  const ensureTimestamp = (column) => {
    if (!item?.[column]) patch[column] = eventAt;
  };

  if ([
    DELIVERY_STATUS.PROVIDER_ACCEPTED,
    DELIVERY_STATUS.SENT_TO_WHATSAPP,
    DELIVERY_STATUS.DELIVERED,
    DELIVERY_STATUS.READ,
  ].includes(status)) {
    ensureTimestamp('accepted_at');
    patch.status = 'sent';
    patch.sent_at = item?.sent_at || eventAt;
    patch.last_error = null;
    patch.provider_error_code = null;
    patch.provider_error_reason = null;
  }
  if ([DELIVERY_STATUS.SENT_TO_WHATSAPP, DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(status)) {
    ensureTimestamp('sent_to_whatsapp_at');
  }
  if ([DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(status)) {
    ensureTimestamp('delivered_at');
  }
  if (status === DELIVERY_STATUS.READ) ensureTimestamp('read_at');

  const currentStatus = normalizarDeliveryStatus(item?.delivery_status);
  if (
    SUCCESSFUL_DELIVERY_STATUSES.has(status)
    && !SUCCESSFUL_DELIVERY_STATUSES.has(currentStatus)
    && esPreguntaAprendizaje(item)
    && marcadorPreguntaAprendizaje(item)?.status !== 'done'
  ) {
    patch.metadata_json = metadataConMarcadorPregunta(item, {
      version: LEARNING_QUESTION_EFFECT_VERSION,
      status: 'pending',
      first_delivery_status: status,
      event_at: eventAt,
    });
  }

  if ([DELIVERY_STATUS.FAILED, DELIVERY_STATUS.UNDELIVERED].includes(status)) {
    ensureTimestamp('failed_at');
    patch.status = 'failed';
    patch.next_attempt_at = null;
    patch.last_error = String(providerErrorReason || providerErrorCode || status).slice(0, 1000);
    patch.provider_error_code = providerErrorCode || status.toLowerCase();
    patch.provider_error_reason = String(providerErrorReason || status).slice(0, 1000);
  }

  return { transition, patch };
}

async function cargarOutboxPorId(supabase, id) {
  const { data, error } = await supabase
    .from('mia_outbox')
    .select(OUTBOX_DELIVERY_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function cargarOutboxPorProviderMessageId(supabase, providerMessageId) {
  const { data, error } = await supabase
    .from('mia_outbox')
    .select(OUTBOX_DELIVERY_SELECT)
    .eq('provider_message_id', providerMessageId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function actualizarEstadoOutbox(supabase, initialItem, requestedStatus, options = {}) {
  let current = initialItem;
  if (!current?.id) throw new Error('delivery_outbox_missing');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { transition, patch } = patchParaEstado(current, requestedStatus, options);
    if (!patch) return { changed: false, item: current, transition };

    patch.updated_at = options.eventAt || new Date().toISOString();
    let update = supabase.from('mia_outbox').update(patch).eq('id', current.id);
    if (current.delivery_status) update = update.eq('delivery_status', current.delivery_status);
    else if (typeof update.is === 'function') update = update.is('delivery_status', null);

    const { data, error } = await update.select(OUTBOX_DELIVERY_SELECT).maybeSingle();
    if (error) throw error;
    if (data) return { changed: true, item: data, transition, patch };

    current = await cargarOutboxPorId(supabase, current.id);
    if (!current) throw new Error('delivery_outbox_disappeared');
  }

  throw new Error('delivery_transition_concurrency_exhausted');
}

async function actualizarDigestYAttempt(supabase, item, deliveryStatus, eventAt, providerMessageId = null, error = null) {
  const digestId = digestIdDeItem(item);
  if (!digestId) return { digest: false };

  const status = normalizarDeliveryStatus(deliveryStatus);
  const digestPatch = {
    delivery_status: status,
  };
  if (item.idempotency_key) digestPatch.idempotency_key = item.idempotency_key;
  if (item.message_version) digestPatch.message_version = item.message_version;
  if (providerMessageId) digestPatch.provider_message_id = providerMessageId;

  if ([DELIVERY_STATUS.PROVIDER_ACCEPTED, DELIVERY_STATUS.SENT_TO_WHATSAPP, DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(status)) {
    if (!item.accepted_at || status === DELIVERY_STATUS.PROVIDER_ACCEPTED) digestPatch.accepted_at = item.accepted_at || eventAt;
    digestPatch.error_msg = null;
  }
  if ([DELIVERY_STATUS.SENT_TO_WHATSAPP, DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(status)) {
    digestPatch.sent_to_whatsapp_at = item.sent_to_whatsapp_at || eventAt;
  }
  if ([DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(status)) {
    digestPatch.delivered_at = item.delivered_at || eventAt;
    digestPatch.enviado = true;
    digestPatch.enviado_at = item.delivered_at || eventAt;
  }
  if (status === DELIVERY_STATUS.READ) digestPatch.read_at = item.read_at || eventAt;
  if ([DELIVERY_STATUS.FAILED, DELIVERY_STATUS.UNDELIVERED].includes(status)) {
    digestPatch.failed_at = item.failed_at || eventAt;
    digestPatch.error_msg = String(error?.message || error?.reason || status).slice(0, 500);
  }

  const { error: digestError } = await supabase.from('digests').update(digestPatch).eq('id', digestId);
  if (digestError) throw digestError;

  const attemptPatch = {
    deliveryStatus: status,
    errorMsg: [DELIVERY_STATUS.FAILED, DELIVERY_STATUS.UNDELIVERED].includes(status)
      ? String(error?.message || error?.reason || status).slice(0, 500)
      : null,
  };
  if ([DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(status)) {
    attemptPatch.status = 'sent';
    attemptPatch.deliveredCount = 1;
    attemptPatch.motivoNoEnvio = null;
  } else if ([DELIVERY_STATUS.FAILED, DELIVERY_STATUS.UNDELIVERED].includes(status)) {
    attemptPatch.status = 'failed';
    attemptPatch.motivoNoEnvio = 'fallo_entrega_whatsapp';
  }
  await actualizarDigestAttemptPorDigest(supabase, digestId, attemptPatch);
  return { digest: true, digestId };
}

function logPatchParaEstado(item, deliveryStatus, providerStatus, eventAt, error = null) {
  const status = normalizarDeliveryStatus(deliveryStatus);
  const patch = {
    delivery_status: status,
    provider_status: providerStatus || null,
    updated_at: new Date().toISOString(),
  };
  if (item.idempotency_key) patch.idempotency_key = item.idempotency_key;
  if (item.message_version) patch.message_version = item.message_version;
  if (item.provider_message_id) patch.provider_message_id = item.provider_message_id;
  if (item.id) patch.outbox_id = item.id;
  const digestId = digestIdDeItem(item);
  if (digestId) patch.digest_id = digestId;
  if (item.user_id) patch.user_id = item.user_id;

  if (status === DELIVERY_STATUS.PROVIDER_ACCEPTED) patch.accepted_at = item.accepted_at || eventAt;
  if (status === DELIVERY_STATUS.SENT_TO_WHATSAPP) {
    patch.sent_to_whatsapp_at = item.sent_to_whatsapp_at || eventAt;
  }
  if (status === DELIVERY_STATUS.DELIVERED) patch.delivered_at = item.delivered_at || eventAt;
  if (status === DELIVERY_STATUS.READ) patch.read_at = item.read_at || eventAt;
  if ([DELIVERY_STATUS.FAILED, DELIVERY_STATUS.UNDELIVERED].includes(status)) {
    patch.failed_at = eventAt;
    patch.status = status === DELIVERY_STATUS.UNDELIVERED ? 'undelivered' : 'failed';
    patch.provider_error_code = error?.code || status.toLowerCase();
    patch.provider_error_reason = String(error?.message || error?.reason || status).slice(0, 1000);
    patch.error_msg = patch.provider_error_reason;
  } else if ([DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(status)) {
    patch.status = status.toLowerCase();
    patch.error_msg = null;
    patch.provider_error_code = null;
    patch.provider_error_reason = null;
  }
  return patch;
}

async function actualizarLogWhatsApp(supabase, item, deliveryStatus, providerStatus, eventAt, error = null) {
  if (!item?.provider_message_id && !item?.id) return { updated: false };
  const patch = logPatchParaEstado(item, deliveryStatus, providerStatus, eventAt, error);
  let query = supabase.from('whatsapp_logs').update(patch);
  if (item.provider_message_id) query = query.eq('provider_message_id', item.provider_message_id);
  else query = query.eq('outbox_id', item.id);
  const { error: updateError } = await query;
  if (updateError) throw updateError;
  return { updated: true };
}

async function registrarEventoEntrega(supabase, item, event = {}) {
  const digestId = digestIdDeItem(item);
  const row = {
    event_hash: event.eventHash,
    outbox_id: item?.id || null,
    digest_id: digestId,
    user_id: item?.user_id || null,
    provider: 'ultramsg',
    provider_message_id: event.providerMessageId || item?.provider_message_id || null,
    provider_status: event.providerStatus || null,
    delivery_status: event.deliveryStatus,
    event_at: event.eventAt,
    idempotency_key: item?.idempotency_key || null,
    message_version: item?.message_version || null,
    payload_json: event.payloadJson || {},
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // UltraMsg reenvía el mismo ACK varias veces. `event_hash` es único, así que
  // se le pide a Postgres que ignore el duplicado en lugar de provocar un 23505:
  // el efecto es el mismo pero deja de escribir un ERROR en el log de la base
  // por cada reenvío legítimo. La fila devuelta distingue insertado de ignorado.
  const tabla = supabase.from('whatsapp_delivery_events');
  if (typeof tabla.upsert !== 'function') {
    const { error } = await tabla.insert(row);
    if (error?.code === '23505') return { inserted: false, duplicate: true };
    if (error) throw error;
    return { inserted: true, duplicate: false };
  }

  const consulta = tabla.upsert(row, { onConflict: 'event_hash', ignoreDuplicates: true });
  const { data, error } = typeof consulta.select === 'function'
    ? await consulta.select('id')
    : await consulta;
  if (error?.code === '23505') return { inserted: false, duplicate: true };
  if (error) throw error;
  const insertado = Array.isArray(data) ? data.length > 0 : data !== null && data !== undefined;
  return { inserted: insertado, duplicate: !insertado };
}

async function reclamarPostprocesoPreguntaAprendizaje(supabase, item) {
  if (!esPreguntaAprendizaje(item) || !SUCCESSFUL_DELIVERY_STATUSES.has(item?.delivery_status)) {
    return { claimed: false, reason: 'not_learning_delivery' };
  }
  const marker = marcadorPreguntaAprendizaje(item);
  if (!marker || marker.version !== LEARNING_QUESTION_EFFECT_VERSION) {
    return { claimed: false, reason: 'marker_missing' };
  }
  const nowDate = new Date();
  const reclaimingStaleLease = marker.status === 'processing'
    && leasePreguntaAprendizajeVencido(marker, nowDate);
  if (marker.status === 'processing' && !reclaimingStaleLease) {
    return { claimed: false, reason: 'lease_active' };
  }
  if (!['pending', 'failed'].includes(marker.status) && !reclaimingStaleLease) {
    return { claimed: false, reason: marker.status || 'marker_invalid' };
  }

  const now = nowDate.toISOString();
  const claimToken = crearClaimTokenPreguntaAprendizaje();
  const nextMarker = {
    ...marker,
    status: 'processing',
    attempts: Number(marker.attempts || 0) + 1,
    claimed_at: now,
    lease_expires_at: new Date(nowDate.getTime() + learningQuestionLeaseMs()).toISOString(),
    claim_token: claimToken,
    stale_reclaims: Number(marker.stale_reclaims || 0) + (reclaimingStaleLease ? 1 : 0),
    error_code: null,
  };
  const nextMetadata = metadataConMarcadorPregunta(item, nextMarker);
  const expectedMarker = {
    version: LEARNING_QUESTION_EFFECT_VERSION,
    status: marker.status,
  };
  if (marker.status === 'processing') {
    if (marker.claimed_at) expectedMarker.claimed_at = marker.claimed_at;
    if (marker.claim_token) expectedMarker.claim_token = marker.claim_token;
  }
  let update = supabase
    .from('mia_outbox')
    .update({ metadata_json: nextMetadata, updated_at: now })
    .eq('id', item.id)
    .eq('delivery_status', item.delivery_status)
    .contains('metadata_json', {
      delivery_effects: {
        learning_question: expectedMarker,
      },
    });
  if (item.updated_at) update = update.eq('updated_at', item.updated_at);
  const { data, error } = await update
    .select(OUTBOX_DELIVERY_SELECT)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { claimed: false, reason: 'claim_raced' };
  return { claimed: true, item: data };
}

async function finalizarPostprocesoPreguntaAprendizaje(supabase, item, status, details = {}) {
  const marker = marcadorPreguntaAprendizaje(item);
  const now = new Date().toISOString();
  const nextMarker = {
    ...marker,
    ...details,
    version: LEARNING_QUESTION_EFFECT_VERSION,
    status,
    processed_at: status === 'done' ? now : marker?.processed_at || null,
    failed_at: status === 'failed' ? now : null,
    lease_expires_at: null,
  };
  const nextMetadata = metadataConMarcadorPregunta(item, nextMarker);
  const expectedMarker = {
    version: LEARNING_QUESTION_EFFECT_VERSION,
    status: 'processing',
  };
  if (marker?.claim_token) expectedMarker.claim_token = marker.claim_token;
  const { data, error } = await supabase
    .from('mia_outbox')
    .update({ metadata_json: nextMetadata, updated_at: now })
    .eq('id', item.id)
    .contains('metadata_json', {
      delivery_effects: {
        learning_question: expectedMarker,
      },
    })
    .select(OUTBOX_DELIVERY_SELECT)
    .maybeSingle();
  if (error) throw error;
  return data || item;
}

async function postprocesarPreguntaAprendizajeEntregada(supabase, item, event = {}) {
  const claim = await reclamarPostprocesoPreguntaAprendizaje(supabase, item);
  if (!claim.claimed) return { processed: false, reason: claim.reason };

  const claimedItem = claim.item;
  const metadata = metadataDeItem(claimedItem);
  const userId = Number(claimedItem.user_id);
  const body = String(claimedItem.body || '').trim();
  const topic = String(metadata.topic || 'general').trim().slice(0, 180) || 'general';
  const confidence = Number(metadata.confidence ?? metadata.zona_incertidumbre?.confidence ?? 0.5);
  const memoryKey = `learning_question_delivery:${claimedItem.id}`;

  try {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !body) {
      throw new Error('learning_question_delivery_context_missing');
    }

    const { data: existingMemory, error: memoryReadError } = await supabase
      .from('user_memory')
      .select('id, memory_key')
      .eq('user_id', userId)
      .eq('memory_key', memoryKey)
      .maybeSingle();
    if (memoryReadError) throw memoryReadError;

    let memory = existingMemory || null;
    if (!memory) {
      const memoryResult = await guardarMemoriasAtomicas(supabase, [construirMemoriaAtomica({
        userId,
        tipo: 'pregunta_sistema',
        contenido: body,
        scopeType: 'topic',
        scopeValue: topic,
        polarity: 'neutral',
        source: 'system',
        strength: 0.5,
        confidence: Number.isFinite(confidence) ? confidence : 0.5,
        organizationId: claimedItem.organization_id || null,
        digestId: digestIdDeItem(claimedItem),
        memoryKey,
        metadata: {
          exploration_question: true,
          outbox_id: claimedItem.id,
          digest_id: digestIdDeItem(claimedItem),
          delivery_status: claimedItem.delivery_status,
          delivered_at: event.eventAt || claimedItem.delivered_at || new Date().toISOString(),
        },
      })]);
      memory = memoryResult.rows[0] || null;
    }

    const { data: existingConversation, error: conversationReadError } = await supabase
      .from('user_conversations')
      .select('id, contexto_json')
      .eq('user_id', userId)
      .eq('tipo', 'pregunta_exploracion')
      .contains('contexto_json', { outbox_id: claimedItem.id })
      .limit(1)
      .maybeSingle();
    if (conversationReadError) throw conversationReadError;

    let conversation = existingConversation || null;
    if (!conversation) {
      const { data, error } = await supabase
        .from('user_conversations')
        .insert({
          user_id: userId,
          digest_id: digestIdDeItem(claimedItem),
          estado: 'activa',
          tipo: 'pregunta_exploracion',
          contexto_json: {
            pregunta_pendiente: body,
            outbox_id: claimedItem.id,
            digest_id: digestIdDeItem(claimedItem),
            zona_incertidumbre: metadata.zona_incertidumbre || {
              topic,
              confidence: Number.isFinite(confidence) ? confidence : 0.5,
            },
            memoria_id: memory?.id || null,
            delivery_status: claimedItem.delivery_status,
          },
          expira_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          organization_id: claimedItem.organization_id || null,
        })
        .select('id')
        .single();
      if (error) throw error;
      conversation = data || null;
    }

    const finishedItem = await finalizarPostprocesoPreguntaAprendizaje(supabase, claimedItem, 'done', {
      memory_id: memory?.id || null,
      conversation_id: conversation?.id || null,
    });
    return {
      processed: true,
      memory_id: memory?.id || null,
      conversation_id: conversation?.id || null,
      item: finishedItem,
    };
  } catch (error) {
    try {
      await finalizarPostprocesoPreguntaAprendizaje(supabase, claimedItem, 'failed', {
        error_code: String(error?.code || error?.name || 'learning_postprocess_failed').slice(0, 120),
      });
    } catch (markerError) {
      console.warn('[delivery:learning] No se pudo marcar el postproceso fallido:', markerError?.code || markerError?.name || 'unknown');
    }
    console.warn('[delivery:learning] Postproceso pendiente de reintento:', error?.code || error?.name || 'unknown');
    return { processed: false, reason: 'postprocess_failed' };
  }
}

async function aplicarEventoEntrega(supabase, item, event) {
  const stateResult = await actualizarEstadoOutbox(supabase, item, event.deliveryStatus, {
    eventAt: event.eventAt,
    providerMessageId: event.providerMessageId,
    providerStatus: event.providerStatus,
    providerErrorCode: event.error?.code || null,
    providerErrorReason: event.error?.message || event.error?.reason || null,
  });
  const effectiveItem = stateResult.item || item;

  // Se sincronizan también los ACK duplicados o desordenados. Si el primer
  // intento guardó el estado del outbox pero falló al actualizar digest/log,
  // el reintento converge sin volver a ejecutar el efecto de aprendizaje.
  await actualizarDigestYAttempt(
    supabase,
    effectiveItem,
    effectiveItem.delivery_status,
    event.eventAt,
    event.providerMessageId,
    event.error
  );
  await actualizarLogWhatsApp(
    supabase,
    effectiveItem,
    effectiveItem.delivery_status,
    event.providerStatus,
    event.eventAt,
    event.error
  );

  const audit = await registrarEventoEntrega(supabase, effectiveItem, event);
  const learningPostprocess = await postprocesarPreguntaAprendizajeEntregada(
    supabase,
    effectiveItem,
    event
  );
  return {
    changed: stateResult.changed,
    transition: stateResult.transition,
    item: effectiveItem,
    duplicate: audit.duplicate,
    learningPostprocess,
  };
}

async function procesarAckUltraMsg(supabase, body, options = {}) {
  const ack = parsearAckUltraMsg(body, options);
  if (!ack.isAck) return { ok: true, handled: false, ignored: true, reason: ack.reason };
  if (!ack.valid) return { ok: true, handled: true, ignored: true, reason: ack.reason };

  const item = await cargarOutboxPorProviderMessageId(supabase, ack.providerMessageId);
  if (!item) {
    const audit = await registrarEventoEntrega(supabase, null, ack);
    return {
      ok: true,
      handled: true,
      matched: false,
      duplicate: audit.duplicate,
      delivery_status: ack.deliveryStatus,
    };
  }

  const effectiveAck = {
    ...ack,
    deliveryStatus: deliveryStatusDesdeProveedor(ack.providerStatus, item.delivery_status) || ack.deliveryStatus,
  };
  const result = await aplicarEventoEntrega(supabase, item, effectiveAck);
  return {
    ok: true,
    handled: true,
    matched: true,
    duplicate: result.duplicate || result.transition?.reason === 'duplicate',
    changed: result.changed,
    transition_reason: result.transition?.reason || null,
    delivery_status: result.item.delivery_status,
    outbox_id: item.id,
  };
}

async function registrarAceptacionProveedor(supabase, item, providerResult = {}, options = {}) {
  const eventAt = options.eventAt || new Date().toISOString();
  const providerMessageId = providerResult.providerMessageId || providerResult.provider_message_id || null;
  const providerStatus = normalizarProviderStatus(providerResult.providerStatus || providerResult.provider_status || 'pending');
  const deliveryStatus = deliveryStatusDesdeProveedor(providerStatus, item.delivery_status)
    || DELIVERY_STATUS.PROVIDER_ACCEPTED;
  const event = {
    eventType: 'provider_response',
    providerMessageId,
    providerStatus,
    deliveryStatus,
    eventAt,
    eventHash: crearEventHash({
      providerMessageId: providerMessageId || item.idempotency_key || String(item.id),
      providerStatus,
      eventType: 'provider_response',
    }),
    payloadJson: sanitizarPayloadEntrega({
      event_type: 'provider_response',
      id: providerMessageId,
      status: providerStatus,
      tracked: Boolean(providerMessageId),
    }),
  };

  const result = await aplicarEventoEntrega(supabase, item, event);
  return {
    ok: true,
    status: 'provider_accepted',
    delivery_status: result.item.delivery_status,
    provider_message_id: providerMessageId,
    provider_status: providerStatus,
    tracked: Boolean(providerMessageId),
    duplicate: result.duplicate,
  };
}

async function registrarFalloProveedor(supabase, item, error, {
  attempts = 1,
  maxAttempts = 5,
  nextAttemptAt = null,
} = {}) {
  const retryable = error?.retryable === true && !error?.ambiguous && attempts < maxAttempts;
  const definitive = !retryable && !error?.ambiguous;
  const now = new Date().toISOString();
  const patch = {
    status: 'failed',
    attempts,
    last_error: String(error?.message || 'fallo_ultramsg').slice(0, 1000),
    next_attempt_at: retryable ? nextAttemptAt : null,
    provider_error_code: error?.providerCode || error?.code || 'provider_error',
    provider_error_reason: String(error?.message || 'fallo_ultramsg').slice(0, 1000),
    provider_status: 'failed',
    delivery_updated_at: now,
    updated_at: now,
    reconcile_after: error?.ambiguous ? now : null,
  };
  if (definitive) {
    patch.delivery_status = DELIVERY_STATUS.FAILED;
    patch.failed_at = now;
  }

  const { data, error: updateError } = await supabase
    .from('mia_outbox')
    .update(patch)
    .eq('id', item.id)
    .select(OUTBOX_DELIVERY_SELECT)
    .maybeSingle();
  if (updateError) throw updateError;
  const effectiveItem = data || { ...item, ...patch };

  if (definitive) {
    await actualizarDigestYAttempt(supabase, effectiveItem, DELIVERY_STATUS.FAILED, now, item.provider_message_id, {
      code: patch.provider_error_code,
      message: patch.provider_error_reason,
    });
  }
  await actualizarLogWhatsApp(supabase, effectiveItem, effectiveItem.delivery_status, 'failed', now, {
    code: patch.provider_error_code,
    message: patch.provider_error_reason,
  });
  await registrarEventoEntrega(supabase, effectiveItem, {
    eventType: `provider_error_attempt_${attempts}`,
    providerMessageId: effectiveItem.provider_message_id || null,
    providerStatus: 'failed',
    deliveryStatus: effectiveItem.delivery_status || DELIVERY_STATUS.QUEUED,
    eventAt: now,
    eventHash: crearEventHash({
      providerMessageId: effectiveItem.provider_message_id || effectiveItem.idempotency_key || String(item.id),
      providerStatus: `failed_${attempts}`,
      eventType: 'provider_error',
    }),
    payloadJson: sanitizarPayloadEntrega({
      event_type: 'provider_error',
      attempt: attempts,
      code: patch.provider_error_code,
      ambiguous: Boolean(error?.ambiguous),
      retryable,
    }),
  });

  return {
    id: item.id,
    ok: false,
    status: 'failed',
    delivery_status: effectiveItem.delivery_status,
    attempts,
    retryable,
    ambiguous: Boolean(error?.ambiguous),
    requires_reconciliation: Boolean(error?.ambiguous),
    error_code: patch.provider_error_code,
    error: patch.provider_error_reason,
  };
}

function extraerMensajesRespuestaProveedor(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.messages)) return json.messages;
  if (json?.message && typeof json.message === 'object') return [json.message];
  if (json?.id || json?.message_id || json?.messageId) return [json];
  return [];
}

function providerMessageIdDeFila(row = {}) {
  return String(row.id || row.message_id || row.messageId || '').trim();
}

async function programarSiguienteConciliacion(supabase, item, { errorCode = null, errorReason = null } = {}) {
  const attempts = Number(item.reconciliation_attempts || 0) + 1;
  const delay = Math.min(24 * 60 * 60 * 1000, 10 * 60 * 1000 * (2 ** Math.min(attempts - 1, 7)));
  const patch = {
    reconciliation_attempts: attempts,
    reconcile_after: new Date(Date.now() + delay).toISOString(),
    delivery_updated_at: new Date().toISOString(),
  };
  if (errorCode) patch.provider_error_code = String(errorCode).slice(0, 120);
  if (errorReason) patch.provider_error_reason = String(errorReason).slice(0, 1000);
  const { error } = await supabase.from('mia_outbox').update(patch).eq('id', item.id);
  if (error) throw error;
  return patch;
}

async function conciliarEntregasUltraMsg(supabase, {
  fetchImpl = globalThis.fetch,
  instanceId = process.env.ULTRAMSG_INSTANCE_ID,
  token = process.env.ULTRAMSG_TOKEN,
  limit = 50,
  dryRun = false,
  now = new Date(),
} = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const { data, error } = await supabase
    .from('mia_outbox')
    .select(OUTBOX_DELIVERY_SELECT)
    .in('delivery_status', [DELIVERY_STATUS.PROVIDER_ACCEPTED, DELIVERY_STATUS.SENT_TO_WHATSAPP])
    .not('provider_message_id', 'is', null)
    .lte('reconcile_after', nowIso)
    .order('reconcile_after', { ascending: true })
    .limit(safeLimit);
  if (error) throw error;
  const items = data || [];

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      candidates: items.length,
      items: items.map((item) => ({ id: item.id, delivery_status: item.delivery_status })),
    };
  }
  if (!instanceId || !token) {
    return { ok: false, available: false, reason: 'ultramsg_credentials_missing', candidates: items.length, results: [] };
  }
  if (typeof fetchImpl !== 'function') throw new Error('ultramsg_reconcile_fetch_missing');

  const results = [];
  for (const item of items) {
    try {
      const url = new URL(`https://api.ultramsg.com/${encodeURIComponent(instanceId)}/messages`);
      url.searchParams.set('token', token);
      url.searchParams.set('status', 'all');
      url.searchParams.set('limit', '10');
      url.searchParams.set('id', item.provider_message_id);
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutReconciliacionMs()),
      });
      if (!response.ok) throw new Error(`provider_http_${response.status}`);
      const json = await response.json();
      const providerRow = extraerMensajesRespuestaProveedor(json)
        .find((row) => providerMessageIdDeFila(row) === String(item.provider_message_id));
      if (!providerRow) {
        await programarSiguienteConciliacion(supabase, item, {
          errorCode: 'provider_message_not_found',
          errorReason: 'El proveedor no devolvio el mensaje solicitado',
        });
        results.push({ id: item.id, ok: false, status: 'not_found' });
        continue;
      }

      const providerStatus = normalizarProviderStatus(providerRow.ack || providerRow.status);
      const deliveryStatus = deliveryStatusDesdeProveedor(providerStatus, item.delivery_status);
      if (!deliveryStatus) {
        await programarSiguienteConciliacion(supabase, item, {
          errorCode: 'provider_status_unknown',
          errorReason: `Estado no reconocido: ${providerStatus || 'vacio'}`,
        });
        results.push({ id: item.id, ok: false, status: 'unknown' });
        continue;
      }

      const eventAt = providerRow.updated_at || providerRow.sent_at || providerRow.created_at || nowIso;
      const event = {
        eventType: 'reconciliation',
        providerMessageId: item.provider_message_id,
        providerStatus,
        deliveryStatus,
        eventAt: isoTimestamp(eventAt, now),
        eventHash: crearEventHash({
          providerMessageId: item.provider_message_id,
          providerStatus,
          eventType: 'reconciliation',
        }),
        payloadJson: sanitizarPayloadEntrega({
          event_type: 'reconciliation',
          id: item.provider_message_id,
          status: providerRow.status || null,
          ack: providerRow.ack || null,
        }),
      };
      const applied = await aplicarEventoEntrega(supabase, item, event);
      results.push({
        id: item.id,
        ok: true,
        changed: applied.changed,
        duplicate: applied.duplicate,
        delivery_status: applied.item.delivery_status,
      });
    } catch (reconcileError) {
      await programarSiguienteConciliacion(supabase, item, {
        errorCode: 'reconciliation_error',
        errorReason: reconcileError.message,
      });
      results.push({ id: item.id, ok: false, status: 'error', error: String(reconcileError.message).slice(0, 240) });
    }
  }

  return {
    ok: results.every((item) => item.ok),
    available: true,
    dry_run: false,
    candidates: items.length,
    reconciled: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}

module.exports = {
  OUTBOX_DELIVERY_SELECT,
  digestIdDeItem,
  fechaReconciliacion,
  patchParaEstado,
  cargarOutboxPorId,
  cargarOutboxPorProviderMessageId,
  actualizarEstadoOutbox,
  aplicarEventoEntrega,
  postprocesarPreguntaAprendizajeEntregada,
  procesarAckUltraMsg,
  registrarEventoEntrega,
  registrarAceptacionProveedor,
  registrarFalloProveedor,
  conciliarEntregasUltraMsg,
  extraerMensajesRespuestaProveedor,
};
