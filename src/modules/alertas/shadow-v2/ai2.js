const { llamarIA, parsearJSON } = require('../../../platform/ia/llamarIA');
const { AI2_MODEL, VERSIONS } = require('./config');

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
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['alert_id', 'reason', 'title', 'summary', 'action', 'deadline'],
          properties: {
            alert_id: { type: 'integer' },
            reason: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            action: { type: 'string' },
            deadline: { type: ['string', 'null'] },
          },
        },
      },
      message: { type: 'string' },
    },
  },
});

const AI2_INSTRUCTIONS = [
  'Eres IA 2 del sistema shadow de Ruralicos y la unica autoridad de personalizacion.',
  'Recibes un perfil real y fichas breves ya clasificadas por IA 1.',
  'Selecciona como maximo cinco alertas. Puedes seleccionar ninguna.',
  'Incluye una alerta solo si la evidencia completa esta frase:',
  'Esto le sirve a esta persona porque puede solicitarlo, debe cumplirlo, puede participar o esta directamente afectada.',
  'No basta el mismo territorio, un tema rural generico, posible interes, relacion plausible, palabras compartidas o un sector amplio.',
  'Si el perfil no demuestra un requisito obligatorio de beneficiario, descarta la alerta.',
  'No enumeres excluidas. No inventes hechos. Redacta message solo desde selected.',
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

function normalizeAi2Result(value, { candidateIds, maxSelected = 5 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ai2_invalid_object');
  }
  if (!Array.isArray(value.selected) || typeof value.message !== 'string') {
    throw new Error('ai2_invalid_contract');
  }
  if (value.selected.length > Math.min(5, maxSelected)) throw new Error('ai2_too_many_selected');
  const allowed = new Set(candidateIds.map(Number));
  const seen = new Set();
  const selected = value.selected.map((item) => {
    const alertId = Number(item?.alert_id);
    if (!Number.isSafeInteger(alertId) || !allowed.has(alertId)) throw new Error('ai2_unknown_alert_id');
    if (seen.has(alertId)) throw new Error('ai2_duplicate_alert_id');
    seen.add(alertId);
    const deadline = item.deadline === null ? null : String(item.deadline || '');
    if (deadline !== null && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      throw new Error('ai2_invalid_deadline');
    }
    return {
      alert_id: alertId,
      reason: stringValue(item.reason, 800, true, 'ai2_missing_reason'),
      title: stringValue(item.title, 500, true, 'ai2_missing_title'),
      summary: stringValue(item.summary, 1200, true, 'ai2_missing_summary'),
      action: stringValue(item.action, 600, true, 'ai2_missing_action'),
      deadline,
    };
  });
  const message = stringValue(value.message, 12000, selected.length > 0, 'ai2_missing_message');
  if (selected.length === 0 && message) throw new Error('ai2_message_without_selection');
  return { selected, message };
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
      candidateIds: candidates.map((candidate) => candidate.alert_id),
      maxSelected,
    });
    return {
      status: normalized.selected.length > 0 ? 'GENERATED' : 'EMPTY',
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
  AI2_TEXT_FORMAT,
  AI2_INSTRUCTIONS,
  AI2_CONTRACT_VERSION: VERSIONS.ai2Contract,
  AI2_PROMPT_VERSION: VERSIONS.ai2Prompt,
  compactCard,
  buildAi2Prompt,
  normalizeAi2Result,
  decideDigestWithAi2,
};
