const crypto = require('crypto');

const MEMORY_CONTRACT_VERSION = 'atomic-memory-v1';

const TOPIC_RULES = [
  ['pac', /\b(pac|politica agraria comun|fega|feaga|feader|solicitud unica|sigpac|ecoregimen)\b/i],
  ['ayudas_maquinaria', /\b(tractor|tractores|maquinaria|maquina|maquinas|apero|aperos)\b/i],
  ['ayudas_subvenciones', /\b(ayuda|ayudas|subvencion|subvenciones|subsidio|convocatoria|pago|prima|indemnizacion)\b/i],
  ['agua_riego', /\b(agua|riego|regadio|pozo|pozos|concesion de aguas|comunidad de regantes)\b/i],
  ['olivar', /\b(olivar|olivo|olivos|aceituna|aceitunas)\b/i],
  ['porcino', /\b(porcino|cerdo|cerdos|cochino|cochinos)\b/i],
  ['vacuno', /\b(vacuno|vaca|vacas|bovino|bovinos)\b/i],
];

const POSITIVE_TYPES = new Set([
  'interes_detectado',
  'feedback_positivo',
  'respuesta_exploracion',
]);

const NEGATIVE_TYPES = new Set([
  'desinteres_detectado',
  'feedback_negativo',
]);

const SOURCE_AUTHORITY = {
  silence: 1,
  inference: 2,
  read: 3,
  click: 4,
  strong_action: 5,
  registration: 6,
  response: 7,
  preference_edit: 8,
};

const HALF_LIFE_DAYS = {
  silence: 7,
  read: 14,
  click: 21,
  inference: 60,
  strong_action: 180,
  legacy: 180,
  response: 365,
};

function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizarValorAmbito(valor) {
  return normalizarTexto(valor)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180);
}

function limitar01(valor, fallback = 0.5) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return fallback;
  return Math.max(0, Math.min(1, numero));
}

function inferirTopic(contenido) {
  const texto = normalizarTexto(contenido);
  for (const [topic, regex] of TOPIC_RULES) {
    if (regex.test(texto)) return topic;
  }
  return 'general';
}

function inferirPolarity(tipo) {
  if (POSITIVE_TYPES.has(tipo)) return 'positive';
  if (NEGATIVE_TYPES.has(tipo)) return 'negative';
  return 'neutral';
}

function normalizarSource(source) {
  const value = normalizarValorAmbito(source || 'response');
  if (['whatsapp', 'explicit_response', 'conversation'].includes(value)) return 'response';
  if (value === 'explicit_feedback') return 'response';
  return value || 'response';
}

function inferirAmbito({ tipo, contenido, alertaId }) {
  if (alertaId) return { scopeType: 'alert', scopeValue: String(alertaId) };

  const texto = normalizarTexto(contenido);
  if (tipo === 'dato_explotacion') {
    return { scopeType: 'activity', scopeValue: normalizarValorAmbito(contenido) || 'general' };
  }
  if (/\b(frecuencia|diario|semanal|menos mensajes|mas mensajes)\b/.test(texto)) {
    return { scopeType: 'frequency', scopeValue: normalizarValorAmbito(contenido) || 'general' };
  }
  if (/\b(whatsapp|correo|email|canal)\b/.test(texto)) {
    return { scopeType: 'channel', scopeValue: normalizarValorAmbito(contenido) || 'general' };
  }
  return { scopeType: 'topic', scopeValue: inferirTopic(contenido) };
}

function crearMemoryKey({
  userId,
  scopeType,
  scopeValue,
  polarity,
  contenido,
  suffix = '',
}) {
  const canonical = [
    MEMORY_CONTRACT_VERSION,
    String(userId),
    normalizarValorAmbito(scopeType),
    normalizarValorAmbito(scopeValue),
    normalizarValorAmbito(polarity),
    normalizarTexto(contenido).slice(0, 500),
    String(suffix || ''),
  ].join('|');

  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function construirMemoriaAtomica(options = {}) {
  const userId = Number(options.userId ?? options.user_id);
  const contenido = String(options.contenido || options.content || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  const alertaId = options.alertaId ?? options.alerta_id ?? null;
  const tipo = String(options.tipo || 'mensaje_libre');
  const inferredScope = inferirAmbito({ tipo, contenido, alertaId });
  const scopeType = String(options.scopeType || options.scope_type || inferredScope.scopeType);
  const scopeValue = normalizarValorAmbito(options.scopeValue || options.scope_value || inferredScope.scopeValue);
  const polarity = String(options.polarity || inferirPolarity(tipo));
  const source = normalizarSource(options.source);
  const strength = limitar01(options.strength ?? options.peso_inicial, 0.5);
  const confidence = limitar01(options.confidence, 0.5);
  const now = options.now || new Date().toISOString();

  if (!Number.isInteger(userId) || userId <= 0) throw new Error('userId inválido para memoria atómica');
  if (!contenido) throw new Error('contenido vacío para memoria atómica');
  if (!scopeValue) throw new Error('scopeValue vacío para memoria atómica');
  if (!['alert', 'topic', 'subsector', 'territory', 'frequency', 'channel', 'activity'].includes(scopeType)) {
    throw new Error(`scopeType no permitido: ${scopeType}`);
  }
  if (!['positive', 'negative', 'neutral'].includes(polarity)) {
    throw new Error(`polarity no permitida: ${polarity}`);
  }

  const memoryKey = options.memoryKey || options.memory_key || crearMemoryKey({
    userId,
    scopeType,
    scopeValue,
    polarity,
    contenido,
    suffix: options.keySuffix,
  });

  return {
    user_id: userId,
    tipo,
    contenido,
    alerta_id: alertaId,
    digest_id: options.digestId ?? options.digest_id ?? null,
    peso_inicial: strength,
    incorporado_a_embedding: false,
    organization_id: options.organizationId ?? options.organization_id ?? null,
    memory_key: memoryKey,
    scope_type: scopeType,
    scope_value: scopeValue,
    polarity,
    source,
    strength,
    confidence,
    status: 'active',
    expires_at: options.expiresAt ?? options.expires_at ?? null,
    correction_of: options.correctionOf ?? options.correction_of ?? null,
    metadata_json: {
      contract_version: MEMORY_CONTRACT_VERSION,
      ...(options.metadata || options.metadata_json || {}),
    },
    duplicate_count: Number(options.duplicateCount ?? options.duplicate_count ?? 0),
    last_seen_at: now,
    updated_at: now,
    decision_version: options.decisionVersion ?? options.decision_version ?? null,
    inbound_id: options.inboundId ?? options.inbound_id ?? null,
  };
}

function esYaSolicitadaPeroSimilares(texto) {
  const normalizado = normalizarTexto(texto);
  const yaSolicitada = /\b(ya\s+(la|lo|las|los)?\s*(pedi|solicite)|ya\s+(he|habia)\s+(pedido|solicitado)|la\s+tengo\s+pedida)\b/.test(normalizado);
  const similares = /\b(similares|parecidas|parecidos|del\s+mismo\s+tipo|otras\s+como\s+esta)\b/.test(normalizado);
  return yaSolicitada && similares;
}

function construirMemoriasYaSolicitadaPeroSimilares({
  userId,
  alerta,
  digestId = null,
  inboundId = null,
  organizationId = null,
  decisionVersion = null,
  confidence = 1,
} = {}) {
  if (!alerta?.id) return [];

  const topic = inferirTopic([
    alerta.titulo,
    ...(alerta.taxonomy_tags || []),
    ...(alerta.tipos_alerta || []),
    ...(alerta.subsectores || []),
  ].filter(Boolean).join(' '));

  const common = {
    userId,
    digestId,
    inboundId,
    organizationId,
    decisionVersion,
    source: 'response',
    confidence,
  };

  return [
    construirMemoriaAtomica({
      ...common,
      tipo: 'feedback_negativo',
      contenido: `Convocatoria ya solicitada: ${alerta.titulo || `alerta ${alerta.id}`}`,
      alertaId: alerta.id,
      scopeType: 'alert',
      scopeValue: String(alerta.id),
      polarity: 'negative',
      strength: 1,
      metadata: { reason_code: 'ALERT_ALREADY_REQUESTED', do_not_repeat: true },
    }),
    construirMemoriaAtomica({
      ...common,
      tipo: 'interes_detectado',
      contenido: `Quiere recibir oportunidades similares sobre ${topic}`,
      scopeType: 'topic',
      scopeValue: topic,
      polarity: 'positive',
      strength: 0.95,
      metadata: {
        reason_code: 'SIMILAR_ALERTS_WANTED',
        origin_alert_id: alerta.id,
      },
    }),
  ];
}

function construirMemoriasDesdeDecision({
  userId,
  digestId = null,
  inboundId = null,
  decision = {},
  textoOriginal = '',
  source = 'response',
  organizationId = null,
} = {}) {
  if (decision.policy?.should_store_memory === false) return [];

  // El ejecutor, que sí conoce el item exacto del digest, descompone este caso.
  // Aquí se evita guardar un negativo temático amplio y erróneo.
  if (esYaSolicitadaPeroSimilares(textoOriginal)) return [];

  return (decision.memory_actions || [])
    .map((memory) => {
      const contenido = String(memory.contenido || '').trim();
      if (!contenido) return null;
      const scope = inferirAmbito({ tipo: memory.tipo, contenido, alertaId: null });

      return construirMemoriaAtomica({
        userId,
        digestId,
        inboundId,
        organizationId,
        tipo: memory.tipo,
        contenido,
        scopeType: memory.scope_type || scope.scopeType,
        scopeValue: memory.scope_value || scope.scopeValue,
        polarity: memory.polarity || inferirPolarity(memory.tipo),
        source,
        strength: memory.peso_inicial,
        confidence: memory.confidence ?? decision.confidence,
        expiresAt: memory.expires_at,
        decisionVersion: decision.version,
        metadata: {
          intent: decision.intent || null,
          summary: decision.summary || null,
          channel: source,
        },
      });
    })
    .filter(Boolean);
}

function fuenteMasAutoritativa(existingSource, incomingSource) {
  const existingRank = SOURCE_AUTHORITY[existingSource] || 0;
  const incomingRank = SOURCE_AUTHORITY[incomingSource] || 0;
  return incomingRank >= existingRank ? incomingSource : existingSource;
}

async function buscarMemoriaPorClave(supabase, row) {
  const { data, error } = await supabase
    .from('user_memory')
    .select('id, source, strength, confidence, status, duplicate_count, metadata_json, expires_at, inbound_id')
    .eq('user_id', row.user_id)
    .eq('memory_key', row.memory_key)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function guardarMemoriasAtomicas(supabase, memories = []) {
  const rows = memories.filter(Boolean);
  if (rows.length === 0) return { ok: true, inserted: 0, merged: 0, replayed: 0, rows: [] };

  let inserted = 0;
  let merged = 0;
  let replayed = 0;
  const savedRows = [];

  for (const row of rows) {
    let existing = await buscarMemoriaPorClave(supabase, row);

    if (existing?.id) {
      if (row.inbound_id && Number(existing.inbound_id) === Number(row.inbound_id)) {
        replayed += 1;
        savedRows.push({ ...row, ...existing });
        continue;
      }
      const now = new Date().toISOString();
      const update = {
        tipo: row.tipo,
        contenido: row.contenido,
        alerta_id: row.alerta_id,
        digest_id: row.digest_id,
        peso_inicial: Math.max(Number(existing.strength || 0), Number(row.strength || 0)),
        organization_id: row.organization_id,
        scope_type: row.scope_type,
        scope_value: row.scope_value,
        polarity: row.polarity,
        source: fuenteMasAutoritativa(existing.source, row.source),
        strength: Math.max(Number(existing.strength || 0), Number(row.strength || 0)),
        confidence: Math.max(Number(existing.confidence || 0), Number(row.confidence || 0)),
        expires_at: row.expires_at || existing.expires_at,
        metadata_json: { ...(existing.metadata_json || {}), ...(row.metadata_json || {}) },
        duplicate_count: Number(existing.duplicate_count || 0) + 1,
        last_seen_at: now,
        updated_at: now,
        decision_version: row.decision_version,
        inbound_id: row.inbound_id,
      };

      const { data, error } = await supabase
        .from('user_memory')
        .update(update)
        .eq('id', existing.id)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      merged += 1;
      savedRows.push(data || { id: existing.id, ...row, ...update, status: existing.status });
      continue;
    }

    const { data, error } = await supabase
      .from('user_memory')
      .insert(row)
      .select('*')
      .maybeSingle();

    if (error?.code === '23505') {
      existing = await buscarMemoriaPorClave(supabase, row);
      if (!existing?.id) throw error;
      const now = new Date().toISOString();
      const { data: mergedRow, error: mergeError } = await supabase
        .from('user_memory')
        .update({
          duplicate_count: Number(existing.duplicate_count || 0) + 1,
          last_seen_at: now,
          updated_at: now,
        })
        .eq('id', existing.id)
        .select('*')
        .maybeSingle();
      if (mergeError) throw mergeError;
      merged += 1;
      savedRows.push(mergedRow || { id: existing.id, ...row });
      continue;
    }
    if (error) throw error;

    inserted += 1;
    savedRows.push(data || row);
  }

  return { ok: true, inserted, merged, replayed, rows: savedRows };
}

function aplicarDecayMemoria(memory, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const lastSeen = new Date(memory.last_seen_at || memory.updated_at || memory.created_at || current);
  const expiresAt = memory.expires_at ? new Date(memory.expires_at) : null;
  const strength = limitar01(memory.strength ?? memory.peso_inicial, 0.5);
  const source = normalizarSource(memory.source || 'legacy');

  if ((memory.status && memory.status !== 'active') || (expiresAt && expiresAt <= current)) {
    return { ...memory, effective_strength: 0, expired: true };
  }

  const stableExplicitSignal = (
    ['registration', 'preference_edit'].includes(source)
    || (source === 'response' && memory.polarity === 'negative')
    || (source === 'response' && ['territory', 'activity'].includes(memory.scope_type))
  );
  if (stableExplicitSignal) {
    return { ...memory, effective_strength: strength, expired: false };
  }

  const halfLife = HALF_LIFE_DAYS[source] || 120;
  const ageDays = Math.max(0, (current.getTime() - lastSeen.getTime()) / 86400000);
  const effective = strength * Math.pow(0.5, ageDays / halfLife);
  return {
    ...memory,
    effective_strength: Number(effective.toFixed(6)),
    expired: false,
  };
}

async function corregirMemoriaAtomica(supabase, {
  userId,
  memoryId,
  replacement,
} = {}) {
  const { data: current, error } = await supabase
    .from('user_memory')
    .select('*')
    .eq('id', memoryId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!current) return { ok: false, found: false, corrected: null };

  const replacementRow = construirMemoriaAtomica({
    userId,
    tipo: replacement?.tipo || current.tipo,
    contenido: replacement?.contenido || current.contenido,
    alertaId: replacement?.alertaId ?? current.alerta_id,
    digestId: replacement?.digestId ?? current.digest_id,
    organizationId: current.organization_id,
    scopeType: replacement?.scopeType || current.scope_type,
    scopeValue: replacement?.scopeValue || current.scope_value,
    polarity: replacement?.polarity || current.polarity,
    source: 'preference_edit',
    strength: replacement?.strength ?? current.strength,
    confidence: replacement?.confidence ?? 1,
    expiresAt: replacement?.expiresAt ?? current.expires_at,
    correctionOf: current.id,
    decisionVersion: replacement?.decisionVersion || MEMORY_CONTRACT_VERSION,
    metadata: { ...(current.metadata_json || {}), corrected_by_user: true },
    keySuffix: `correction:${current.id}`,
  });

  const saved = await guardarMemoriasAtomicas(supabase, [replacementRow]);
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from('user_memory')
    .update({ status: 'corrected', updated_at: now })
    .eq('id', current.id)
    .eq('user_id', userId);
  if (updateError) throw updateError;

  return { ok: true, found: true, corrected: saved.rows[0] || replacementRow };
}

async function borrarMemoriaAtomica(supabase, { userId, memoryId } = {}) {
  const { data, error } = await supabase
    .from('user_memory')
    .delete()
    .eq('id', memoryId)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return { ok: Boolean(data), found: Boolean(data), id: data?.id || null };
}

module.exports = {
  MEMORY_CONTRACT_VERSION,
  aplicarDecayMemoria,
  borrarMemoriaAtomica,
  construirMemoriaAtomica,
  construirMemoriasDesdeDecision,
  construirMemoriasYaSolicitadaPeroSimilares,
  corregirMemoriaAtomica,
  crearMemoryKey,
  esYaSolicitadaPeroSimilares,
  guardarMemoriasAtomicas,
  inferirPolarity,
  inferirTopic,
  normalizarTexto,
};
