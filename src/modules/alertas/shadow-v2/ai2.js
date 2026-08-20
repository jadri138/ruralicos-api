const { llamarIA, parsearJSON } = require('../../../platform/ia/llamarIA');
const { AI2_MODEL, VERSIONS } = require('./config');

const AI2_LEVELS = Object.freeze(['priority', 'related']);
const MAX_PRIORITY_SELECTED = 2;

const AI2_TEXT_FORMAT = Object.freeze({
  type: 'json_schema',
  name: 'shadow_v2_personal_digest',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['selected', 'message'],
    properties: {
      selected: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['alert_id', 'reason', 'level'],
          properties: {
            alert_id: { type: 'integer' },
            reason: { type: 'string' },
            level: { type: 'string', enum: AI2_LEVELS },
          },
        },
      },
      message: { type: 'string', maxLength: 240 },
    },
  },
});

const AI2_INSTRUCTIONS = [
  'Eres IA 2 del sistema shadow de Ruralicos y decides el digest personal.',
  'Recibes el perfil real de una persona y alertas rurales vigentes ya clasificadas por IA 1.',
  'Selecciona solo las alertas que sean realmente utiles para esa persona por territorio, actividad y tipo de beneficiario.',
  'Debe poder solicitarlas, cumplirlas, recurrirlas, participar en ellas o estar directamente afectada.',
  'Compartir provincia, una palabra o un sector rural amplio no basta si no existe un encaje personal concreto.',
  'Cada reason debe nombrar el encaje concreto con una actividad, territorio o condicion de beneficiario del perfil.',
  'Todas las candidatas ya han superado los bloqueos objetivos: si recibes una o mas, debes seleccionar al menos una.',
  'Selecciona como maximo cinco, ordenadas por utilidad. No inventes datos ni enumeres las descartadas.',
  'Asigna level=priority solo a las una o dos alertas mas utiles; las demas seleccionadas llevan level=related.',
  'Puede no haber ninguna priority si todas son solo relacionadas, pero nunca puede haber mas de dos.',
  'Ordena primero las priority y despues las related, manteniendo dentro de cada nivel el orden de utilidad.',
  'No devuelvas title: el servidor usa el titulo oficial vinculado a cada alert_id.',
  'En message habla siempre de tu y nunca de usted; manten el mismo tono cercano en todo el digest.',
  'No atribuyas al usuario concesiones, expedientes, parcelas, instalaciones ni otras circunstancias que su perfil no demuestre.',
  'message solo puede referirse a alertas incluidas en selected, nunca a candidatas descartadas.',
  'Si varias candidatas son cursos o tramites casi iguales, elige solo la mejor y evita un digest repetitivo.',
  'No devuelvas resumen, accion, plazo ni URL: el servidor los proyecta desde la ficha verificada de IA 1.',
  'Ordena las seleccionadas por utilidad y urgencia. message debe ser un gancho comercial de una sola frase, concreto y veraz, sin saludo, despedida ni pregunta.',
].join('\n');

function compactCard(candidate) {
  const card = candidate.card || candidate;
  return {
    alert_id: Number(candidate.alert_id),
    official_title: candidate.official_snapshot?.title || null,
    official_url: candidate.official_snapshot?.official_url || null,
    status: card.status,
    territories: card.territories,
    activities: card.activities,
    beneficiary_types: card.beneficiary_types,
    content_type: card.content_type,
    action: card.action,
    deadline: card.deadline,
    summary: card.summary,
    evidence: card.evidence,
  };
}

function buildAi2Prompt({ user, candidates, sentAlertIds, maxSelected }) {
  return [
    'Decide el digest de esta persona para esta fecha.',
    JSON.stringify({
      user_profile: {
        id: user.id,
        name: user.name || null,
        first_name: user.first_name || null,
        legal_name: user.legal_name || null,
        preferences: user.preferences || {},
        preferencias_extra: user.preferencias_extra || null,
      },
      candidate_cards: candidates.map(compactCard),
      already_sent_alert_ids: sentAlertIds.map(Number),
      max_selected: Math.min(5, maxSelected),
    }, null, 2),
  ].join('\n\n');
}

function stringValue(value, max, required, code) {
  const result = String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (required && !result) throw new Error(code);
  return result;
}

function verifiedCandidateTitle(candidate = {}) {
  return stringValue(
    candidate.official_snapshot?.title,
    120,
    true,
    'ai2_candidate_title_missing'
  );
}

function normalizeAi2Result(value, {
  candidates = [],
  maxSelected = 5,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ai2_invalid_object');
  }
  if (!Array.isArray(value.selected) || typeof value.message !== 'string') {
    throw new Error('ai2_invalid_contract');
  }
  if (value.selected.length === 0) throw new Error('ai2_empty_selection');
  if (value.selected.length > Math.min(5, maxSelected)) throw new Error('ai2_too_many_selected');
  const allowed = new Map(candidates.map((candidate) => [Number(candidate.alert_id), candidate]));
  const seen = new Set();
  const selected = value.selected.map((item) => {
    const alertId = Number(item?.alert_id);
    const candidate = allowed.get(alertId);
    if (!Number.isSafeInteger(alertId) || !candidate) throw new Error('ai2_unknown_alert_id');
    if (seen.has(alertId)) throw new Error('ai2_duplicate_alert_id');
    seen.add(alertId);
    const level = String(item?.level || '').trim();
    if (!AI2_LEVELS.includes(level)) throw new Error('ai2_invalid_level');
    return {
      alert_id: alertId,
      reason: stringValue(item.reason, 800, true, 'ai2_missing_reason'),
      level,
      title: verifiedCandidateTitle(candidate),
    };
  });
  let priorityCount = 0;
  const normalizedLevels = selected.map((item) => {
    if (item.level !== 'priority') return item;
    priorityCount += 1;
    return priorityCount <= MAX_PRIORITY_SELECTED
      ? item
      : { ...item, level: 'related' };
  });
  const orderedSelection = [
    ...normalizedLevels.filter((item) => item.level === 'priority'),
    ...normalizedLevels.filter((item) => item.level === 'related'),
  ];
  const message = stringValue(value.message, 240, true, 'ai2_missing_message');
  return { selected: orderedSelection, message };
}

async function decideDigestWithAi2({
  user,
  candidates,
  sentAlertIds = [],
  maxSelected = 5,
  maxPromptChars,
  callAi = llamarIA,
} = {}) {
  const prompt = buildAi2Prompt({ user, candidates, sentAlertIds, maxSelected });
  if (prompt.length > maxPromptChars) {
    return {
      status: 'ERROR',
      called: false,
      model: AI2_MODEL,
      prompt,
      rawResponse: null,
      normalizedResponse: null,
      usage: null,
      durationMs: 0,
      error: { code: 'personal_prompt_too_large', message: `Prompt IA 2: ${prompt.length} caracteres` },
    };
  }
  const startedAt = Date.now();
  let raw = null;
  try {
    const response = await callAi(prompt, AI2_INSTRUCTIONS, AI2_MODEL, {
      task: 'shadow_v2_ai2',
      textFormat: AI2_TEXT_FORMAT,
      maxOutputTokens: 5000,
      retries: 0,
      returnMetadata: true,
      skipAudit: true,
    });
    raw = typeof response === 'string' ? response : response?.text;
    const normalized = normalizeAi2Result(parsearJSON(raw), {
      candidates,
      maxSelected,
    });
    return {
      status: 'GENERATED',
      called: true,
      model: AI2_MODEL,
      prompt,
      rawResponse: raw,
      normalizedResponse: normalized,
      usage: response?.metadata?.usage || null,
      durationMs: response?.metadata?.duration_ms ?? Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      status: 'ERROR',
      called: true,
      model: AI2_MODEL,
      prompt,
      rawResponse: raw,
      normalizedResponse: null,
      usage: error?.metadata?.usage || null,
      durationMs: error?.metadata?.duration_ms ?? Date.now() - startedAt,
      error: {
        code: String(error?.message || 'ai2_error').slice(0, 120),
        message: String(error?.message || error).slice(0, 1000),
      },
    };
  }
}

module.exports = {
  AI2_MODEL,
  AI2_LEVELS,
  MAX_PRIORITY_SELECTED,
  AI2_TEXT_FORMAT,
  AI2_INSTRUCTIONS,
  AI2_CONTRACT_VERSION: VERSIONS.ai2Contract,
  AI2_PROMPT_VERSION: VERSIONS.ai2Prompt,
  compactCard,
  buildAi2Prompt,
  verifiedCandidateTitle,
  normalizeAi2Result,
  decideDigestWithAi2,
};
