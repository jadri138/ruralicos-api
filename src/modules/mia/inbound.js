const crypto = require('crypto');

const DEFAULT_FALLBACK_DEDUPE_MS = 2 * 60 * 1000;

function normalizarTextoFingerprint(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 2000);
}

function parseTimestampMs(value) {
  if (value === undefined || value === null || value === '') return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function getFallbackDedupeMs() {
  const value = Number(process.env.MIA_INBOUND_FALLBACK_DEDUPE_MS || DEFAULT_FALLBACK_DEDUPE_MS);
  return Number.isFinite(value) && value >= 15 * 1000
    ? Math.min(10 * 60 * 1000, Math.floor(value))
    : DEFAULT_FALLBACK_DEDUPE_MS;
}

function sha256(texto) {
  return crypto.createHash('sha256').update(String(texto || '')).digest('hex');
}

function crearIdentidadMensajeMIA({ source = 'ultramsg', telefono, texto, ultra = {} }) {
  const externalMessageId = String(ultra.messageId || '').trim() || null;
  const timestampMs = parseTimestampMs(ultra.timestamp) || Date.now();
  const fallbackBucket = Math.floor(timestampMs / getFallbackDedupeMs());
  const textoNormalizado = normalizarTextoFingerprint(texto);

  const fingerprintBase = externalMessageId
    ? `${source}|id|${externalMessageId}`
    : `${source}|fallback|${telefono || ''}|${textoNormalizado}|${fallbackBucket}`;

  return {
    source,
    external_message_id: externalMessageId,
    message_fingerprint: sha256(fingerprintBase),
    text_hash: sha256(textoNormalizado),
    fingerprint_bucket: fallbackBucket,
  };
}

async function buscarInboundExistente(supabase, identity) {
  let query = supabase
    .from('mia_inbound_messages')
    .select('id, duplicate_count, status, source, external_message_id, message_fingerprint')
    .eq('source', identity.source)
    .limit(1);

  if (identity.external_message_id) {
    query = query.eq('external_message_id', identity.external_message_id);
  } else {
    query = query.eq('message_fingerprint', identity.message_fingerprint);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

async function incrementarDuplicado(supabase, inbound) {
  const nextCount = Number(inbound?.duplicate_count || 0) + 1;
  await supabase
    .from('mia_inbound_messages')
    .update({
      duplicate_count: nextCount,
      last_seen_at: new Date().toISOString(),
    })
    .eq('id', inbound.id);

  return nextCount;
}

async function registrarInboundMIA(supabase, {
  source = 'ultramsg',
  ultra = {},
  telefono,
  texto,
  body = {},
  organizationId = null,
}) {
  const identity = crearIdentidadMensajeMIA({ source, telefono, texto, ultra });
  const now = new Date().toISOString();

  const row = {
    source,
    external_message_id: identity.external_message_id,
    message_fingerprint: identity.message_fingerprint,
    text_hash: identity.text_hash,
    from_phone: telefono || null,
    from_raw: ultra.telefonoRaw || null,
    chat_id: ultra.chatId || null,
    sender_kind: ultra.senderKind || 'user',
    event_type: ultra.eventType || null,
    text_body: String(texto || '').slice(0, 4000),
    body_json: body || {},
    status: 'received',
    first_seen_at: now,
    last_seen_at: now,
  };
  if (organizationId) row.organization_id = organizationId;

  try {
    const existentePrevio = await buscarInboundExistente(supabase, identity);
    if (existentePrevio?.id) {
      let duplicateCount = Number(existentePrevio.duplicate_count || 0) + 1;
      try {
        duplicateCount = await incrementarDuplicado(supabase, existentePrevio);
      } catch (err) {
        console.warn('[mia:inbound] Duplicado detectado, pero no se pudo incrementar contador:', err.message);
      }

      return {
        ok: true,
        available: true,
        duplicate: true,
        id: existentePrevio.id,
        duplicate_count: duplicateCount,
        identity,
      };
    }

    const { data, error } = await supabase
      .from('mia_inbound_messages')
      .insert(row)
      .select('id, status')
      .single();

    if (!error) {
      return {
        ok: true,
        available: true,
        duplicate: false,
        id: data?.id || null,
        identity,
      };
    }

    if (error.code !== '23505') throw error;

    const existente = await buscarInboundExistente(supabase, identity);
    if (!existente) {
      return {
        ok: true,
        available: true,
        duplicate: true,
        id: null,
        identity,
      };
    }

    let duplicateCount = Number(existente.duplicate_count || 0) + 1;
    try {
      duplicateCount = await incrementarDuplicado(supabase, existente);
    } catch (err) {
      console.warn('[mia:inbound] Duplicado detectado, pero no se pudo incrementar contador:', err.message);
    }

    return {
      ok: true,
      available: true,
      duplicate: true,
      id: existente.id,
      duplicate_count: duplicateCount,
      identity,
    };
  } catch (error) {
    console.warn('[mia:inbound] No se pudo registrar mensaje entrante:', error.message);
    return {
      ok: false,
      available: false,
      duplicate: false,
      error: error.message,
      identity,
    };
  }
}

async function actualizarInboundMIA(supabase, inboundId, patch = {}) {
  if (!inboundId) return false;

  const update = {
    ...patch,
    last_seen_at: new Date().toISOString(),
  };

  if (patch.status === 'processed' && !patch.processed_at) {
    update.processed_at = new Date().toISOString();
  }

  try {
    const { error } = await supabase
      .from('mia_inbound_messages')
      .update(update)
      .eq('id', inboundId);

    if (error) throw error;
    return true;
  } catch (error) {
    console.warn('[mia:inbound] No se pudo actualizar mensaje entrante:', error.message);
    return false;
  }
}

module.exports = {
  crearIdentidadMensajeMIA,
  registrarInboundMIA,
  actualizarInboundMIA,
  normalizarTextoFingerprint,
  getFallbackDedupeMs,
};
