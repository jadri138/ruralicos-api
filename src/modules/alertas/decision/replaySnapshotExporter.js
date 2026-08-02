const crypto = require('crypto');
const { REASON_CODES } = require('./contracts');

const HISTORICAL_SNAPSHOT_VERSION = 'alert_decision_historical_snapshot_v1';
const DIRECT_PII_PATTERNS = Object.freeze([
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\b(?:ES\d{2}[\s-]?(?:\d{4}[\s-]?){5}|[A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])\b/i,
  /(?:\+34[\s().-]*)?[6789](?:[\s().-]*\d){8}\b/,
  /\+\d{1,3}(?:[\s().-]*\d){7,14}\b/,
]);
const SAFE_PREFERENCE_KEYS = new Set([
  'provincias',
  'municipios',
  'comunidades',
  'sectores',
  'subsectores',
  'cultivos',
  'especies',
  'tipos',
  'tipos_alerta',
  'intereses',
  'excluir_temas',
  'excluir_sectores',
  'excluir_subsectores',
  'excluir_tipos',
  'exclusiones',
  'frecuencia',
  'frequency',
  'quiet_hours',
  'timezone',
  'max_digest_items',
  'idioma',
  'canal',
  'channel',
]);
const KNOWN_REASON_CODES = new Set(Object.values(REASON_CODES));
const SELECTS = Object.freeze({
  decisions: [
    'id', 'user_id', 'alerta_id', 'fecha', 'stage', 'action', 'digest_id',
    'decision_state', 'reason_codes', 'decision_json', 'llm_calls', 'created_at',
  ].join(', '),
  users: 'id, subscription, preferences, created_at',
  alerts: [
    'id', 'titulo', 'resumen', 'resumen_borrador', 'resumen_final', 'url', 'fecha',
    'region', 'provincias', 'sectores', 'subsectores', 'tipos_alerta', 'fuente',
    'taxonomy_tags', 'created_at',
  ].join(', '),
  factSheets: [
    'id', 'alerta_id', 'schema_version', 'builder_version', 'status', 'fact_sheet',
    'flags', 'reasons', 'generated_at',
  ].join(', '),
  digests: 'id, user_id, fecha, created_at',
  feedback: [
    'user_id', 'alerta_id', 'valor', 'feedback_category',
    'feedback_confidence', 'created_at',
  ].join(', '),
  clicks: 'user_id, alerta_id, created_at',
  memories: [
    'id', 'user_id', 'alerta_id', 'memory_key', 'scope_type', 'scope_value', 'polarity',
    'source', 'strength', 'confidence', 'status', 'expires_at', 'created_at',
  ].join(', '),
});

function isoDay(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function pseudonym(value, salt, prefix) {
  return `${prefix}_${crypto.createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 24)}`;
}

function sanitizeText(value, maxLength = 600) {
  if (value == null) return null;
  const withoutControls = [...String(value)].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && ![9, 10, 13].includes(code) ? ' ' : character;
  }).join('');
  return withoutControls
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\bES\d{2}[\s-]?(?:\d{4}[\s-]?){5}\b/gi, '[iban]')
    .replace(/\b(?:[XYZ]\d{7}[A-Z]|\d{8}[A-Z])\b/gi, '[documento]')
    .replace(/(?:\+34[\s().-]*)?[6789](?:[\s().-]*\d){8}\b/g, '[telefono]')
    .replace(/\+\d{1,3}(?:[\s().-]*\d){7,14}\b/g, '[telefono]')
    .replace(/\b(?:don|doña|dña\.?|interesad[oa]|solicitante|titular)\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+){1,4}/giu, '[persona]')
    .replace(/\b(?:calle|avenida|paseo|plaza|camino|carretera)\s+[^,;\n]{2,80}(?:,|\s+n[úu]m(?:ero)?\.?\s*)\d+[A-Za-z]?/giu, '[direccion]')
    .replace(/\bHola\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+)?\b/giu, 'Hola [persona]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const pathname = url.pathname
      .split('/')
      .map((part) => (part.length > 48 ? '[segmento]' : part))
      .join('/');
    return `${url.origin}${pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}

function sanitizePreferences(preferences = {}) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(preferences)) {
    if (!SAFE_PREFERENCE_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      safe[key] = value.map((item) => sanitizeText(item, 100)).filter(Boolean).slice(0, 100);
    } else if (value && typeof value === 'object') {
      safe[key] = Object.fromEntries(
        Object.entries(value)
          .filter(([, nested]) => ['string', 'number', 'boolean'].includes(typeof nested))
          .map(([nestedKey, nested]) => [
            sanitizeText(nestedKey, 50),
            typeof nested === 'string' ? sanitizeText(nested, 100) : nested,
          ])
      );
    } else if (['string', 'number', 'boolean'].includes(typeof value)) {
      safe[key] = typeof value === 'string' ? sanitizeText(value, 100) : value;
    }
  }
  return safe;
}

function evidenceValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(evidenceValue).filter(Boolean);
  if (typeof value !== 'object') return value;
  return value.valor ?? value.value ?? value.text ?? value.content ?? null;
}

function safeList(value, maxItems = 50) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map((item) => sanitizeText(evidenceValue(item), 120)).filter(Boolean).slice(0, maxItems);
}

function safeScalar(value, maxLength = 600) {
  const extracted = evidenceValue(value);
  if (Array.isArray(extracted)) return extracted.map((item) => sanitizeText(item, maxLength)).filter(Boolean).join(', ');
  return sanitizeText(extracted, maxLength);
}

function mapDecisionState(row = {}) {
  const direct = row.decision_state || row.decision_json?.decision || row.decision_json?.state;
  if (['SEND_NOW', 'ADD_TO_DIGEST', 'HOLD_FOR_EVIDENCE', 'DROP', 'BLOCKED'].includes(direct)) {
    return direct;
  }
  const action = String(row.action || '').toLowerCase();
  if (['include', 'selected', 'send', 'approved'].includes(action)) return 'ADD_TO_DIGEST';
  if (['blocked', 'block'].includes(action)) return 'BLOCKED';
  if (['review_only', 'hold', 'pending'].includes(action)) return 'HOLD_FOR_EVIDENCE';
  return 'DROP';
}

function decisionPriority(row = {}) {
  const ranks = {
    effective_send_gate: 70,
    final_validation: 60,
    auto_send_gate: 50,
    personal_relevance_judge: 40,
    selection: 30,
    user_filter: 20,
    fact_sheet_preselection: 10,
    quality_gate: 5,
  };
  return ranks[row.stage] || 0;
}

function authoritativeDecisions(rows = []) {
  const selected = new Map();
  for (const row of rows) {
    const day = isoDay(row.fecha);
    if (!day || row.user_id == null || row.alerta_id == null) continue;
    const key = `${row.user_id}:${row.alerta_id}:${day}`;
    const previous = selected.get(key);
    if (!previous
      || decisionPriority(row) > decisionPriority(previous)
      || (decisionPriority(row) === decisionPriority(previous)
        && String(row.created_at || '') > String(previous.created_at || ''))) {
      selected.set(key, row);
    }
  }
  return [...selected.values()].sort((a, b) => (
    String(a.fecha).localeCompare(String(b.fecha))
    || Number(a.id || 0) - Number(b.id || 0)
  ));
}

function factSheetForDate(rows = [], alertId, date) {
  const cutoff = `${date}T23:59:59.999Z`;
  return rows
    .filter((row) => String(row.alerta_id) === String(alertId)
      && String(row.generated_at || row.created_at || '') <= cutoff)
    .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')))[0]
    || null;
}

function buildAlertSnapshot(alert = {}, factRow = {}, salt) {
  const fact = factRow.fact_sheet || {};
  const provinces = safeList(alert.provincias || fact.territorio);
  const regions = safeList(fact.resumen_estructurado?.comunidades || alert.region);
  const municipalities = safeList(fact.resumen_estructurado?.municipios);
  const national = safeList(fact.territorio).some((item) => /nacional|españa/i.test(item));
  return {
    id: pseudonym(alert.id, salt, 'alert'),
    title: sanitizeText(alert.titulo || safeScalar(fact.titulo) || 'Alerta historica sanitizada', 240),
    source: sanitizeText(alert.fuente, 80) || 'HISTORICAL_SNAPSHOT',
    type: safeList(alert.tipos_alerta || fact.tipo_documento, 5)[0] || 'informacion',
    topic: safeScalar(fact.tema_principal, 180)
      || safeList(alert.taxonomy_tags, 5)[0]
      || safeList(alert.tipos_alerta, 5)[0]
      || 'sin tema estructurado',
    summary: sanitizeText(
      alert.resumen_final || alert.resumen || alert.resumen_borrador || safeScalar(fact.resumen_neutro),
      600
    ),
    territory: {
      level: national ? 'national' : regions.length > 0 && provinces.length === 0 ? 'regional' : 'provincial',
      provinces,
      regions,
      municipalities,
      individual_case: Boolean(fact.resumen_estructurado?.expediente_individual),
    },
    sectors: safeList(alert.sectores || fact.sectores),
    subsectors: safeList(alert.subsectores || fact.subsectores),
    beneficiaries: safeScalar(fact.beneficiarios, 400),
    action: safeScalar(fact.accion_requerida, 400),
    action_code: safeScalar(fact.accion_codigo, 80),
    deadline: safeScalar(fact.application_deadline || fact.plazo, 80),
    amount: safeScalar(fact.importe, 120),
    requirements: safeList(fact.requisitos),
    official_url: sanitizeUrl(alert.url || safeScalar(fact.url_oficial, 500)),
    status: sanitizeText(factRow.status || fact.status, 80) || 'unknown',
    flags: safeList(factRow.flags || fact.flags),
  };
}

function buildMemorySnapshot(memory = {}, salt) {
  const scope = sanitizeText(memory.scope_type, 40) || 'topic';
  const key = sanitizeText(memory.scope_value || memory.memory_key, 180) || 'sanitized-memory';
  return {
    id: pseudonym(memory.id, salt, 'memory'),
    content: key,
    key,
    scope,
    polarity: ['positive', 'negative', 'neutral'].includes(memory.polarity) ? memory.polarity : 'neutral',
    source: sanitizeText(memory.source, 80) || 'historical_snapshot',
    strength: Math.max(0, Math.min(1, Number(memory.strength ?? 0.5))),
    confidence: Math.max(0, Math.min(1, Number(memory.confidence ?? 0.5))),
    status: sanitizeText(memory.status, 40) || 'active',
    recorded_at: memory.created_at || null,
    expires_at: memory.expires_at || null,
    alert_id: memory.alerta_id == null ? null : pseudonym(memory.alerta_id, salt, 'alert'),
  };
}

function profileKind(preferences = {}) {
  const territory = [...(preferences.provincias || []), ...(preferences.municipios || [])];
  const topics = [...(preferences.sectores || []), ...(preferences.subsectores || [])];
  if (territory.length === 0 && topics.length === 0) return 'new';
  if (topics.length === 0) return 'open';
  return 'specialized';
}

function polarityFromFeedback(feedback = {}) {
  if (Number(feedback.valor) > 0 || feedback.feedback_category === 'useful') return 'positive';
  if (Number(feedback.valor) < 0) return 'negative';
  return 'neutral';
}

function buildHistoricalReplayCorpus(rows = {}, options = {}) {
  const salt = options.salt || crypto.randomBytes(32).toString('hex');
  if (typeof salt !== 'string' || salt.length < 24) {
    throw new TypeError('La sal HMAC del snapshot debe tener al menos 24 caracteres');
  }
  const decisions = authoritativeDecisions(rows.decisions || []);
  const users = new Map((rows.users || []).map((row) => [String(row.id), row]));
  const alerts = new Map((rows.alerts || []).map((row) => [String(row.id), row]));
  const digests = new Map((rows.digests || []).map((row) => [String(row.id), row]));
  const profileIds = [...new Set(decisions.map((row) => String(row.user_id)))];
  const profiles = profileIds.map((rawId) => {
    const user = users.get(rawId) || {};
    const preferences = sanitizePreferences(user.preferences);
    return {
      id: pseudonym(rawId, salt, 'profile'),
      kind: profileKind(preferences),
      user: {
        subscription: sanitizeText(user.subscription, 40) || 'historical',
        preferences,
      },
      memories: [],
      exposures: [],
    };
  });

  const memories = rows.memories || [];
  const snapshotKeys = new Set();
  const profileSnapshots = [];
  for (const decision of decisions) {
    const date = isoDay(decision.fecha);
    const key = `${decision.user_id}:${date}`;
    if (snapshotKeys.has(key)) continue;
    snapshotKeys.add(key);
    const endOfDay = `${date}T23:59:59.999Z`;
    profileSnapshots.push({
      date,
      profile_id: pseudonym(decision.user_id, salt, 'profile'),
      user: {
        subscription: sanitizeText(users.get(String(decision.user_id))?.subscription, 40) || 'historical',
        preferences: sanitizePreferences(users.get(String(decision.user_id))?.preferences),
      },
      memories: memories
        .filter((memory) => String(memory.user_id) === String(decision.user_id)
          && String(memory.created_at || '') <= endOfDay)
        .map((memory) => buildMemorySnapshot(memory, salt)),
      exposures: [],
      snapshot_metadata: {
        preferences_source: 'current_safe_columns_proxy',
        memories_cutoff: endOfDay,
      },
    });
  }

  const feedbackByPair = new Map();
  for (const feedback of rows.feedback || []) {
    const key = `${feedback.user_id}:${feedback.alerta_id}`;
    if (!feedbackByPair.has(key)) feedbackByPair.set(key, []);
    feedbackByPair.get(key).push(feedback);
  }
  const clicksByPair = new Map();
  for (const click of rows.clicks || []) {
    const key = `${click.user_id}:${click.alerta_id}`;
    if (!clicksByPair.has(key)) clicksByPair.set(key, []);
    clicksByPair.get(key).push(click);
  }

  const nextDecisionDates = new Array(decisions.length).fill(null);
  const nextByPair = new Map();
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index];
    const pair = `${decision.user_id}:${decision.alerta_id}`;
    nextDecisionDates[index] = nextByPair.get(pair) || null;
    nextByPair.set(pair, isoDay(decision.fecha));
  }

  const cases = decisions.map((decision, decisionIndex) => {
    const date = isoDay(decision.fecha);
    const rawAlert = alerts.get(String(decision.alerta_id)) || { id: decision.alerta_id };
    const state = mapDecisionState(decision);
    const pair = `${decision.user_id}:${decision.alerta_id}`;
    const afterStart = `${date}T00:00:00.000Z`;
    const beforeNext = nextDecisionDates[decisionIndex]
      ? `${nextDecisionDates[decisionIndex]}T00:00:00.000Z`
      : null;
    const feedback = (feedbackByPair.get(pair) || [])
      .filter((item) => String(item.created_at || '') >= afterStart
        && (!beforeNext || String(item.created_at || '') < beforeNext))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    const click = (clicksByPair.get(pair) || [])
      .filter((item) => String(item.created_at || '') >= afterStart
        && (!beforeNext || String(item.created_at || '') < beforeNext))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    const digest = decision.digest_id == null ? null : digests.get(String(decision.digest_id));
    const reasonCodes = Array.isArray(decision.reason_codes)
      ? decision.reason_codes
        .map((item) => sanitizeText(item, 80))
        .filter((item) => KNOWN_REASON_CODES.has(item))
        .slice(0, 12)
      : [];
    const observed = {};
    if (feedback) {
      observed.feedback = {
        polarity: polarityFromFeedback(feedback),
        scope: 'alert',
        confidence: Number(feedback.feedback_confidence) || 0.7,
        recorded_at: feedback.created_at,
      };
    }
    if (click) {
      observed.clicked = true;
      observed.clicked_at = click.created_at;
    }
    return {
      id: pseudonym(decision.id || `${pair}:${date}:${decision.stage}`, salt, 'case'),
      date,
      profile_id: pseudonym(decision.user_id, salt, 'profile'),
      categories: ['historical_export'],
      generators: ['exact'],
      alert: buildAlertSnapshot(
        rawAlert,
        factSheetForDate(rows.factSheets || [], decision.alerta_id, date) || {},
        salt
      ),
      current: {
        decision: state,
        message: digest ? `[mensaje_historico:${pseudonym(digest.id, salt, 'digest')}]` : null,
        message_available: Boolean(digest),
        model_calls: Math.max(0, Number(decision.llm_calls || 0)),
      },
      judge: {
        decision: state,
        ...(reasonCodes.length > 0 ? { reason_codes: reasonCodes } : {}),
      },
      observed,
      snapshot_metadata: {
        source_stage: sanitizeText(decision.stage, 80),
        message_content_redacted: true,
        alert_row_source: 'current_safe_columns_proxy',
        fact_sheet_cutoff: `${date}T23:59:59.999Z`,
      },
    };
  });

  const corpus = {
    version: HISTORICAL_SNAPSHOT_VERSION,
    description: 'Instantaneas historicas locales, seudonimizadas y sin contenido directo de mensajes.',
    generated_at: options.generatedAt || null,
    source_window: {
      from: options.from || (cases[0]?.date ?? null),
      to: options.to || (cases[cases.length - 1]?.date ?? null),
      signal_through: options.signalThrough || null,
    },
    privacy: {
      direct_identifiers: false,
      raw_messages: false,
      raw_feedback: false,
      pseudonymization: options.salt ? 'caller_supplied_hmac' : 'ephemeral_hmac',
    },
    profiles,
    profile_snapshots: profileSnapshots,
    cases,
  };
  assertSanitizedCorpus(corpus);
  return corpus;
}

function assertSanitizedCorpus(corpus) {
  const serialized = JSON.stringify(corpus);
  const direct = DIRECT_PII_PATTERNS.find((pattern) => pattern.test(serialized));
  if (direct) {
    const error = new Error('El snapshot contiene un identificador directo no sanitizado');
    error.code = 'REPLAY_SNAPSHOT_PII_DETECTED';
    throw error;
  }
  const forbiddenKeys = /"(?:phone|telefono|email|name|nombre|raw_text|token|user_agent|referer|ip_hash|contenido|mensaje)"\s*:/i;
  if (forbiddenKeys.test(serialized)) {
    const error = new Error('El snapshot contiene una clave sensible no permitida');
    error.code = 'REPLAY_SNAPSHOT_FORBIDDEN_FIELD';
    throw error;
  }
  return true;
}

async function execute(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`No se pudo leer ${label}: ${error.message || error.code || 'error desconocido'}`);
  return data || [];
}

async function readWindow(client, table, select, {
  dateColumn,
  from,
  to,
  pageSize,
  maxRows,
  filters = [],
}) {
  const rows = [];
  for (let offset = 0; offset <= maxRows; offset += pageSize) {
    const requested = Math.min(pageSize, (maxRows + 1) - offset);
    if (requested <= 0) break;
    let query = client.from(table).select(select);
    if (from) query = query.gte(dateColumn, from);
    if (to) query = query.lte(dateColumn, to);
    for (const filter of filters) query = query.in(filter.column, filter.values);
    query = query.order(dateColumn, { ascending: true }).range(offset, offset + requested - 1);
    const page = await execute(query, table);
    rows.push(...page);
    if (rows.length > maxRows) throw new Error(`${table} supera el limite local de ${maxRows} filas`);
    if (page.length < requested) break;
  }
  return rows;
}

function chunks(values, size = 200) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function readByIds(client, table, select, column, values, options = {}) {
  const rows = [];
  for (const group of chunks([...new Set(values)].filter((value) => value != null))) {
    rows.push(...await readWindow(client, table, select, {
      dateColumn: options.dateColumn || 'created_at',
      from: options.from || null,
      to: options.to || null,
      pageSize: options.pageSize,
      maxRows: options.maxRows,
      filters: [{ column, values: group }],
    }));
    if (rows.length > options.maxRows) {
      throw new Error(`${table} supera el limite local de ${options.maxRows} filas`);
    }
  }
  return rows;
}

async function collectHistoricalReplayRows({
  client,
  from,
  to,
  signalThrough = `${to}T23:59:59.999Z`,
  pageSize = 500,
  maxRows = 20000,
} = {}) {
  if (!client || typeof client.from !== 'function') throw new TypeError('Cliente Supabase inyectado obligatorio');
  if (!isoDay(from) || !isoDay(to) || from > to) throw new TypeError('Ventana historica invalida');
  const decisions = await readWindow(client, 'digest_candidate_decisions', SELECTS.decisions, {
    dateColumn: 'fecha',
    from: isoDay(from),
    to: isoDay(to),
    pageSize,
    maxRows,
  });
  const userIds = [...new Set(decisions.map((row) => row.user_id))];
  const alertIds = [...new Set(decisions.map((row) => row.alerta_id))];
  if (decisions.length === 0) {
    return { decisions, users: [], alerts: [], factSheets: [], digests: [], feedback: [], clicks: [], memories: [] };
  }
  const shared = { pageSize, maxRows };
  const [users, alerts, factSheets, digests, feedback, clicks, memories] = await Promise.all([
    readByIds(client, 'users', SELECTS.users, 'id', userIds, {
      ...shared, dateColumn: 'created_at', to: `${isoDay(to)}T23:59:59.999Z`,
    }),
    readByIds(client, 'alertas', SELECTS.alerts, 'id', alertIds, shared),
    readByIds(client, 'alert_fact_sheets', SELECTS.factSheets, 'alerta_id', alertIds, shared),
    readByIds(client, 'digests', SELECTS.digests, 'user_id', userIds, {
      dateColumn: 'fecha', from: isoDay(from), to: isoDay(to), ...shared,
    }),
    readByIds(client, 'alerta_feedback', SELECTS.feedback, 'user_id', userIds, {
      ...shared, dateColumn: 'created_at', from: `${isoDay(from)}T00:00:00.000Z`, to: signalThrough,
    }),
    readByIds(client, 'alerta_clicks', SELECTS.clicks, 'user_id', userIds, {
      ...shared, dateColumn: 'created_at', from: `${isoDay(from)}T00:00:00.000Z`, to: signalThrough,
    }),
    readByIds(client, 'user_memory', SELECTS.memories, 'user_id', userIds, {
      ...shared, dateColumn: 'created_at', to: `${isoDay(to)}T23:59:59.999Z`,
    }),
  ]);
  const alertIdSet = new Set(alertIds.map(String));
  return {
    decisions,
    users,
    alerts,
    factSheets,
    digests,
    feedback: feedback.filter((row) => alertIdSet.has(String(row.alerta_id))),
    clicks: clicks.filter((row) => alertIdSet.has(String(row.alerta_id))),
    memories,
  };
}

function inspectHistoricalExporterSource(source) {
  const text = String(source || '');
  const mutations = [
    ...[...text.matchAll(/\.\s*(insert|upsert|delete|rpc)\s*\(/g)].map((match) => match[1]),
    ...[...text.matchAll(/\.\s*update\s*\(\s*\{/g)].map(() => 'update'),
  ];
  const sensitiveSelects = [...text.matchAll(/select\(([^)]*)\)/g)]
    .map((match) => match[1])
    .filter((selection) => /raw_text|token|user_agent|referer|ip_hash|phone|email|name|contenido|mensaje/i.test(selection));
  return {
    safe: mutations.length === 0 && sensitiveSelects.length === 0,
    mutations,
    sensitive_selects: sensitiveSelects,
  };
}

module.exports = {
  HISTORICAL_SNAPSHOT_VERSION,
  SELECTS,
  assertSanitizedCorpus,
  authoritativeDecisions,
  buildHistoricalReplayCorpus,
  collectHistoricalReplayRows,
  inspectHistoricalExporterSource,
  mapDecisionState,
  pseudonym,
  sanitizePreferences,
  sanitizeText,
  sanitizeUrl,
};
