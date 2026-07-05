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

  return conOrganizationId({
    decision_id: decisionId,
    inbound_id: inboundId,
    user_id: userId,
    channel: 'whatsapp',
    to_phone: toPhone,
    body: formatted.text,
    status: 'queued',
    attempts: 0,
    next_attempt_at: new Date().toISOString(),
    metadata_json: {
      intent: decision.intent || null,
      confidence: decision.confidence ?? null,
      decision_version: decision.version || null,
      risk_flags: decision.risk_flags || [],
      knowledge_context: decision.knowledge_context || null,
      organization_context: decision.organization_context || null,
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
      .select('id, status, attempts, body, to_phone, created_at')
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
      return {
        ok: true,
        available: true,
        queued: false,
        existing: true,
        id: existente.item.id,
        status: existente.item.status,
        attempts: existente.item.attempts || 0,
        body: existente.item.body || row.body,
      };
    }

    const { data, error } = await supabase
      .from('mia_outbox')
      .insert(row)
      .select('id')
      .single();

    if (error) throw error;
    return { ok: true, available: true, queued: true, id: data?.id || null, body: row.body };
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
      .lte('next_attempt_at', now)
      .lt('attempts', maxAttempts)
      .select('id, decision_id, inbound_id, user_id, channel, to_phone, body, status, attempts, created_at')
      .maybeSingle();

    if (error) throw error;
    if (!data) return { ok: true, available: true, claimed: false, reason: 'outbox_no_reclamable' };
    return { ok: true, available: true, claimed: true, item: data };
  } catch (error) {
    console.warn('[mia:outbox] No se pudo marcar sending:', error.message);
    return { ok: false, available: false, claimed: false, error: error.message };
  }
}

async function marcarOutboxSending(supabase, id) {
  const result = await reclamarOutboxParaEnvio(supabase, id);
  return Boolean(result.claimed);
}

async function marcarOutboxSent(supabase, id) {
  if (!id) return false;
  try {
    const { error } = await supabase
      .from('mia_outbox')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', id);

    if (error) throw error;
    return true;
  } catch (error) {
    console.warn('[mia:outbox] No se pudo marcar sent:', error.message);
    return false;
  }
}

async function marcarOutboxFailed(supabase, id, errorMessage, attempts = null) {
  if (!id) return false;
  const intentos = Number.isFinite(Number(attempts)) ? Number(attempts) : 1;
  const maxAttempts = getMaxAttempts();
  const patch = {
    status: 'failed',
    last_error: String(errorMessage || '').slice(0, 1000),
    next_attempt_at: intentos >= maxAttempts ? null : calcularNextAttemptAt(intentos),
    updated_at: new Date().toISOString(),
  };
  if (Number.isFinite(Number(attempts))) patch.attempts = intentos;

  try {
    const { error } = await supabase
      .from('mia_outbox')
      .update(patch)
      .eq('id', id);

    if (error) throw error;
    return true;
  } catch (error) {
    console.warn('[mia:outbox] No se pudo marcar failed:', error.message);
    return false;
  }
}

async function recuperarOutboxSendingAtascadoMIA(supabase, { timeoutMs = getSendingTimeoutMs(), limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));

  try {
    const { data: stuck, error: selectError } = await supabase
      .from('mia_outbox')
      .select('id, attempts')
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
      const nextAttemptAt = attempts >= getMaxAttempts() ? null : calcularNextAttemptAt(attempts);
      const { error } = await supabase
        .from('mia_outbox')
        .update({
          status: 'failed',
          attempts,
          last_error: 'sending_timeout_recovered',
          next_attempt_at: nextAttemptAt,
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
      .select('id, decision_id, inbound_id, user_id, channel, to_phone, body, status, attempts, last_error, next_attempt_at, created_at')
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
  try {
    await enviarFn(claimedItem.to_phone, claimedItem.body);
    await marcarOutboxSent(supabase, claimedItem.id);
    return { id: claimedItem.id, ok: true, status: 'sent' };
  } catch (errEnvio) {
    const attempts = Number(claimedItem.attempts || 0) + 1;
    await marcarOutboxFailed(supabase, claimedItem.id, errEnvio.message, attempts);
    return {
      id: claimedItem.id,
      ok: false,
      status: 'failed',
      attempts,
      retryable: attempts < getMaxAttempts(),
      error: errEnvio.message,
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
  const due = [];
  const deadLetter = [];
  const stuckSending = [];
  const pending = [];
  const nowMs = now.getTime();

  for (const item of list) {
    const attempts = Number(item.attempts || 0);
    const status = item.status || 'unknown';
    const nextAttemptMs = item.next_attempt_at ? new Date(item.next_attempt_at).getTime() : null;
    const updatedMs = item.updated_at ? new Date(item.updated_at).getTime() : null;

    if (['queued', 'failed', 'sending'].includes(status)) pending.push(item);
    if (['queued', 'failed'].includes(status) && attempts < maxAttempts && (!nextAttemptMs || nextAttemptMs <= nowMs)) {
      due.push(item);
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
      detail: 'Hay mensajes en sending demasiado tiempo. El recuperador los devolvera a failed para reintento.',
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
    ok: score >= 85 && deadLetter.length === 0 && stuckSending.length === 0,
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
    },
    breakdown: {
      by_status: byStatus,
    },
    samples: {
      due_now: due.slice(0, 20),
      dead_letter: deadLetter.slice(0, 20),
      stuck_sending: stuckSending.slice(0, 20),
    },
    recommendations,
  };
}

async function generarOutboxHealthMIA(supabase, { hours = 72, limit = 1000 } = {}) {
  const safeHours = Math.max(1, Math.min(720, Number(hours) || 72));
  const safeLimit = Math.max(50, Math.min(5000, Number(limit) || 1000));
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();

  const recovery = await recuperarOutboxSendingAtascadoMIA(supabase, { limit: 200 });
  const select = 'id, decision_id, inbound_id, user_id, channel, to_phone, body, status, attempts, last_error, next_attempt_at, sent_at, created_at, updated_at';
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
  construirOutboxDesdeDecision,
  buscarOutboxExistenteMIA,
  encolarRespuestaMIA,
  reclamarOutboxParaEnvio,
  marcarOutboxSending,
  marcarOutboxSent,
  marcarOutboxFailed,
  recuperarOutboxSendingAtascadoMIA,
  cargarOutboxPendiente,
  procesarOutboxItemMIA,
  calcularOutboxHealthMIA,
  generarOutboxHealthMIA,
  calcularNextAttemptAt,
  getMaxAttempts,
  getSendingTimeoutMs,
};
