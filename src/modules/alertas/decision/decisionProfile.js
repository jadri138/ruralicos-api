const crypto = require('crypto');
const { CONTRACT_VERSIONS } = require('./contracts');
const { compactText, normalizeText, uniqueStrings } = require('./truthCard');

const SIGNAL_AUTHORITY = Object.freeze({
  legal_or_territorial: 800,
  explicit_current_exclusion: 700,
  explicit_alert_response: 600,
  explicit_memory: 500,
  declared_initial: 400,
  strong_action: 300,
  click: 200,
  inference: 100,
});

const DEFAULT_HALF_LIFE_DAYS = Object.freeze({
  legal_or_territorial: Infinity,
  explicit_current_exclusion: Infinity,
  explicit_alert_response: 180,
  explicit_memory: 120,
  declared_initial: Infinity,
  strong_action: 60,
  click: 14,
  inference: 30,
});

const EXPLICIT_PREFERENCE_SCOPES = new Set([
  'topic',
  'subtopic',
  'sector',
  'subsector',
  'crop',
  'species',
  'activity',
  'alert_type',
  'territory',
]);

function pseudo(value, salt = 'ruralicos-decision-profile-v1', prefix = 'u') {
  const source = String(value ?? 'new-profile');
  return `${prefix}_${crypto.createHash('sha256').update(`${salt}:${source}`).digest('hex').slice(0, 20)}`;
}

function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizePolarity(value) {
  const normalized = normalizeText(value);
  if (['negative', 'negativa', 'no', 'exclude', 'exclusion'].includes(normalized)) return 'negative';
  if (['positive', 'positiva', 'si', 'include', 'interest'].includes(normalized)) return 'positive';
  return 'neutral';
}

function redactSensitiveText(value) {
  return compactText(value, 240)
    ?.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[telefono]')
    || null;
}

function inferAuthority(memory = {}) {
  if (memory.authority && SIGNAL_AUTHORITY[memory.authority]) return memory.authority;
  const source = normalizeText(memory.source || memory.fuente || memory.tipo);
  const sourceKey = source.replace(/\s+/g, '_');
  const scope = normalizeText(
    memory.scope_type || memory.scope || memory.ambito || memory.memory_type
  ).replace(/\s+/g, '_');
  const polarity = normalizePolarity(memory.polarity || memory.polaridad);
  const explicitSource = /respuesta|response|reply|feedback|preference[_ ]?edit|conversation|conversacion/.test(source);
  if (SIGNAL_AUTHORITY[sourceKey]) return sourceKey;
  if (/legal|territor/.test(source)) return 'legal_or_territorial';
  if (/exclusion.*actual|preferencia.*actual/.test(source)
    || (explicitSource
      && polarity === 'negative'
      && EXPLICIT_PREFERENCE_SCOPES.has(scope))) {
    return 'explicit_current_exclusion';
  }
  if (/respuesta|response|reply|feedback/.test(source) && (memory.alert_id || memory.alerta_id)) {
    return 'explicit_alert_response';
  }
  if (/respuesta|response|reply|feedback|preference[_ ]?edit|memoria|conversation|conversacion/.test(source)) {
    return 'explicit_memory';
  }
  if (/registro|registration|declared|declarad|onboarding/.test(source)) return 'declared_initial';
  if (/guardar|solicitar|strong_action|pedir mas/.test(source)) return 'strong_action';
  if (/click|clic/.test(source)) return 'click';
  return 'inference';
}

function decayFactor(authority, recordedAt, now, halfLives = {}) {
  const halfLife = halfLives[authority] ?? DEFAULT_HALF_LIFE_DAYS[authority] ?? 30;
  if (halfLife === Infinity) return 1;
  const date = safeDate(recordedAt);
  if (!date) return 0.5;
  const ageDays = Math.max(0, (now.getTime() - date.getTime()) / 86400000);
  return 2 ** (-ageDays / Math.max(1, halfLife));
}

function normalizeAtomicMemory(memory = {}, options = {}) {
  const now = safeDate(options.now) || new Date();
  const recordedAt = safeDate(memory.recorded_at || memory.fecha || memory.created_at) || now;
  const expiresAt = safeDate(memory.expires_at || memory.caducidad);
  const authority = inferAuthority(memory);
  const scope = normalizeText(
    memory.scope_type || memory.scope || memory.ambito || memory.memory_type || memory.tipo || 'topic'
  )
    .replace(/\s+/g, '_');
  const content = redactSensitiveText(memory.content || memory.contenido || memory.detail || memory.topic);
  const key = normalizeText(
    memory.scope_value || memory.key || memory.topic || memory.tag || content
  ).replace(/\s+/g, '_');
  const baseStrength = Math.max(0, Math.min(1, Number(memory.strength ?? memory.fuerza ?? memory.confidence ?? 0.6)));
  const status = normalizeText(memory.status);
  const active = (!status || ['active', 'activo'].includes(status))
    && !memory.deleted_at
    && !memory.corrected_at
    && (!expiresAt || expiresAt > now)
    && Boolean(content || key);
  const effectiveStrength = active
    ? baseStrength * decayFactor(authority, recordedAt, now, options.halfLives)
    : 0;
  const originAlert = memory.alert_id ?? memory.alerta_id ?? null;

  return {
    memory_ref: pseudo(memory.id || `${scope}:${key}:${recordedAt.toISOString()}`, options.pseudonymSalt, 'm'),
    content,
    polarity: normalizePolarity(memory.polarity || memory.polaridad),
    scope,
    key,
    strength: Number(baseStrength.toFixed(4)),
    effective_strength: Number(effectiveStrength.toFixed(4)),
    source: authority,
    authority: SIGNAL_AUTHORITY[authority],
    recorded_at: recordedAt.toISOString(),
    expires_at: expiresAt?.toISOString() || null,
    origin_alert_ref: originAlert == null ? null : pseudo(originAlert, options.pseudonymSalt, 'a'),
    confidence: Math.max(0, Math.min(1, Number(memory.confidence ?? baseStrength))),
    correctable: memory.correctable !== false,
    active,
  };
}

function explicitPreferenceMemories(user = {}, now = new Date()) {
  const preferences = user.preferences || user.preferencias || {};
  const positiveGroups = {
    sector: preferences.sectores || user.sectores,
    subsector: preferences.subsectores || user.subsectores,
    alert_type: preferences.tipos || preferences.tipos_alerta,
    topic: preferences.intereses,
  };
  const negativeGroups = {
    sector: preferences.excluir_sectores,
    subsector: preferences.excluir_subsectores,
    alert_type: preferences.excluir_tipos || preferences.exclusiones,
    topic: preferences.excluir_temas,
  };
  const memories = [];
  for (const [scope, values] of Object.entries(positiveGroups)) {
    for (const value of uniqueStrings(values)) {
      memories.push({
        content: value,
        key: value,
        scope,
        polarity: 'positive',
        strength: 1,
        source: 'declared_initial',
        recorded_at: now,
      });
    }
  }
  for (const [scope, values] of Object.entries(negativeGroups)) {
    for (const value of uniqueStrings(values)) {
      memories.push({
        content: value,
        key: value,
        scope,
        polarity: 'negative',
        strength: 1,
        source: 'explicit_current_exclusion',
        recorded_at: now,
      });
    }
  }
  return memories;
}

function resolveMemoryConflicts(memories = []) {
  const groups = new Map();
  for (const memory of memories.filter((item) => item.active)) {
    const groupKey = `${memory.scope}:${memory.key}`;
    const current = groups.get(groupKey);
    const explicitPreferenceConflict = current
      && current.polarity !== memory.polarity
      && EXPLICIT_PREFERENCE_SCOPES.has(memory.scope)
      && memory.scope === current.scope
      && ['explicit_current_exclusion', 'explicit_memory'].includes(memory.source)
      && ['explicit_current_exclusion', 'explicit_memory'].includes(current.source);
    const shouldReplace = explicitPreferenceConflict
      ? memory.recorded_at > current.recorded_at
        || (memory.recorded_at === current.recorded_at && memory.polarity === 'negative')
      : !current
        || memory.authority > current.authority
        || (memory.authority === current.authority && memory.recorded_at > current.recorded_at)
        || (memory.authority === current.authority
          && memory.recorded_at === current.recorded_at
          && memory.polarity === 'negative');
    if (shouldReplace) {
      groups.set(groupKey, memory);
    }
  }
  return [...groups.values()].sort((a, b) => (
    b.authority - a.authority
    || b.effective_strength - a.effective_strength
    || `${a.scope}:${a.key}`.localeCompare(`${b.scope}:${b.key}`)
  ));
}

function normalizeExposure(exposure = {}, options = {}) {
  const alertId = exposure.alert_id ?? exposure.alerta_id ?? exposure.id;
  return {
    alert_ref: pseudo(alertId, options.pseudonymSalt, 'a'),
    topic: compactText(exposure.topic || exposure.tema, 100),
    material_version: compactText(exposure.material_version || exposure.content_hash || 'initial', 100),
    shown_at: safeDate(exposure.shown_at || exposure.mostrado_at)?.toISOString() || null,
    sent_at: safeDate(exposure.sent_at || exposure.enviado_at)?.toISOString() || null,
    delivered_at: safeDate(exposure.delivered_at || exposure.entregado_at)?.toISOString() || null,
    read_at: safeDate(exposure.read_at || exposure.leido_at)?.toISOString() || null,
    failed: Boolean(exposure.failed || exposure.fallido),
  };
}

function buildDecisionProfile({
  user = {},
  memories = [],
  exposures = [],
  now = new Date(),
  pseudonymSalt,
  halfLives,
} = {}) {
  const currentTime = safeDate(now) || new Date();
  const preferences = user.preferences || user.preferencias || {};
  const rawMemories = [
    ...explicitPreferenceMemories(user, currentTime),
    ...(Array.isArray(memories) ? memories : []),
  ];
  const normalizedMemories = rawMemories.map((memory) => normalizeAtomicMemory(memory, {
    now: currentTime,
    pseudonymSalt,
    halfLives,
  }));
  const resolved = resolveMemoryConflicts(normalizedMemories);
  const positive = resolved.filter((item) => item.polarity === 'positive');
  const negative = resolved.filter((item) => item.polarity === 'negative');
  const provinces = uniqueStrings(preferences.provincias || user.provincias || user.provincia);
  const municipalities = uniqueStrings(preferences.municipios || user.municipios || user.municipio);
  const regions = uniqueStrings(preferences.comunidades || preferences.ccaa || user.comunidad);
  const sectors = uniqueStrings(preferences.sectores || user.sectores || user.sector);
  const subsectors = uniqueStrings(preferences.subsectores || user.subsectores || user.subsector);
  const crops = uniqueStrings(preferences.cultivos || user.cultivos);
  const species = uniqueStrings(preferences.especies || user.especies);

  return {
    contract_version: CONTRACT_VERSIONS.profile,
    subject_id: pseudo(user.id ?? user.user_id, pseudonymSalt, 'u'),
    generated_at: currentTime.toISOString(),
    operational: {
      territory: { provinces, municipalities, regions },
      activity: { sectors, subsectors, crops, species },
      plan: compactText(user.subscription || user.plan || 'unknown', 40),
      channel: compactText(preferences.channel || preferences.canal || 'whatsapp', 30),
    },
    preferences: {
      frequency: compactText(preferences.frequency || preferences.frecuencia || 'daily', 30),
      timezone: compactText(preferences.timezone || 'Europe/Madrid', 60),
      quiet_hours: {
        start: Number(preferences.quiet_hours?.start ?? preferences.hora_silencio_inicio ?? 22),
        end: Number(preferences.quiet_hours?.end ?? preferences.hora_silencio_fin ?? 8),
      },
      max_digest_items: Math.max(1, Math.min(5, Number(preferences.max_digest_items || 5))),
    },
    memories: {
      positive,
      negative,
      inactive: normalizedMemories.filter((item) => !item.active).map((item) => item.memory_ref),
    },
    exposures: (Array.isArray(exposures) ? exposures : [])
      .map((exposure) => normalizeExposure(exposure, { pseudonymSalt }))
      .sort((a, b) => String(b.delivered_at || b.sent_at || '').localeCompare(String(a.delivered_at || a.sent_at || ''))),
    is_new_profile: provinces.length === 0
      && municipalities.length === 0
      && sectors.length === 0
      && subsectors.length === 0
      && resolved.length === 0,
    signal_hierarchy_version: 'signal_authority_v1',
  };
}

function projectProfileForJudge(profile = {}) {
  return {
    contract_version: profile.contract_version,
    subject_id: profile.subject_id,
    territory: profile.operational?.territory || { provinces: [], municipalities: [], regions: [] },
    activity: profile.operational?.activity || { sectors: [], subsectors: [], crops: [], species: [] },
    preferences: profile.preferences || {},
    memories: {
      positive: (profile.memories?.positive || []).map(({ scope, key, effective_strength, source }) => ({
        scope,
        key,
        effective_strength,
        source,
      })),
      negative: (profile.memories?.negative || []).map(({ scope, key, effective_strength, source }) => ({
        scope,
        key,
        effective_strength,
        source,
      })),
    },
    recent_exposures: (profile.exposures || []).slice(0, 20),
    is_new_profile: Boolean(profile.is_new_profile),
  };
}

module.exports = {
  SIGNAL_AUTHORITY,
  DEFAULT_HALF_LIFE_DAYS,
  pseudo,
  normalizeAtomicMemory,
  redactSensitiveText,
  resolveMemoryConflicts,
  buildDecisionProfile,
  projectProfileForJudge,
};
