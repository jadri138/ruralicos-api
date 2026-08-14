const { llamarIA, parsearJSON } = require('../../../platform/ia/llamarIA');
const { AI1_MODEL, AI1_STATUS, CONTENT_TYPES, VERSIONS } = require('./config');

const AI1_TEXT_FORMAT = Object.freeze({
  type: 'json_schema',
  name: 'shadow_v2_global_alert_classification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'relevant',
      'actionable',
      'status',
      'territories',
      'activities',
      'beneficiary_types',
      'content_type',
      'action',
      'deadline',
      'summary',
      'evidence',
    ],
    properties: {
      relevant: { type: 'boolean' },
      actionable: { type: 'boolean' },
      status: { type: 'string', enum: AI1_STATUS },
      territories: {
        type: 'object',
        additionalProperties: false,
        required: ['national', 'regions', 'provinces', 'municipalities'],
        properties: {
          national: { type: 'boolean' },
          regions: { type: 'array', items: { type: 'string' } },
          provinces: { type: 'array', items: { type: 'string' } },
          municipalities: { type: 'array', items: { type: 'string' } },
        },
      },
      activities: { type: 'array', maxItems: 3, items: { type: 'string' } },
      beneficiary_types: { type: 'array', maxItems: 5, items: { type: 'string' } },
      content_type: { type: 'string', enum: CONTENT_TYPES },
      action: { type: 'string' },
      deadline: {
        anyOf: [
          { type: 'string', format: 'date' },
          { type: 'null' },
        ],
      },
      summary: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
    },
  },
});

const AI1_INSTRUCTIONS = [
  'Eres IA 1 del sistema shadow de Ruralicos.',
  'Analiza una unica publicacion oficial y decide si es realmente util o afecta a personas o actividades del medio rural.',
  'Incluye agricultura, ganaderia, silvicultura, regadio, agroalimentacion y desarrollo rural.',
  'relevant=true solo si el asunto real de la publicacion es rural; una palabra aislada o el nombre de un organismo no bastan.',
  'actionable=true solo si todavia se puede solicitar, cumplir, recurrir, participar o actuar, o existe una afectacion concreta vigente.',
  'Clasifica territorio, actividades, beneficiarios, tipo, accion y plazo usando exclusivamente el documento actual.',
  'activities contiene como maximo tres actividades directamente afectadas; no anadas sectores rurales amplios por contexto.',
  'Usa aid para ayudas abiertas, opportunity para cursos o participacion abierta, obligation para deberes vigentes e information solo si no hay una accion mas concreta.',
  'deadline debe ser una fecha exacta YYYY-MM-DD respaldada por el documento. Si el plazo es relativo, depende de dias habiles o no puede calcularse con certeza, usa null.',
  'Una concesion, adjudicacion o convocatoria ya resuelta o cerrada no es una oportunidad abierta.',
  'No inventes ni completes por intuicion. Si falta informacion usa arrays vacios, null o unknown.',
  'evidence debe contener fragmentos breves y literales que sostengan la decision.',
].join('\n');

function cleanString(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanStringArray(value, maxItems = 30, maxChars = 300) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanString(item, maxChars)).filter(Boolean))].slice(0, maxItems);
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeAi1Result(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ai1_invalid_object');
  }
  if (typeof value.relevant !== 'boolean' || typeof value.actionable !== 'boolean') {
    throw new Error('ai1_invalid_booleans');
  }
  if (!AI1_STATUS.includes(value.status)) throw new Error('ai1_invalid_status');
  if (!CONTENT_TYPES.includes(value.content_type)) throw new Error('ai1_invalid_content_type');
  if (!value.territories || typeof value.territories !== 'object' || Array.isArray(value.territories)) {
    throw new Error('ai1_invalid_territories');
  }
  if (typeof value.territories.national !== 'boolean') throw new Error('ai1_invalid_national');

  const action = cleanString(value.action, 500);
  const summary = cleanString(value.summary, 1200);
  const evidence = cleanStringArray(value.evidence, 10, 500);
  if (!summary) throw new Error('ai1_missing_summary');
  if (evidence.length === 0) throw new Error('ai1_insufficient_evidence');
  if (value.actionable && !action) throw new Error('ai1_missing_action');
  const deadline = isIsoDate(value.deadline) ? String(value.deadline) : null;

  return {
    relevant: value.relevant,
    actionable: value.actionable,
    status: value.status,
    territories: {
      national: value.territories.national,
      regions: cleanStringArray(value.territories.regions),
      provinces: cleanStringArray(value.territories.provinces),
      municipalities: cleanStringArray(value.territories.municipalities),
    },
    activities: cleanStringArray(value.activities, 3),
    beneficiary_types: cleanStringArray(value.beneficiary_types, 5),
    content_type: value.content_type,
    action,
    deadline,
    summary,
    evidence,
  };
}

function buildAi1Prompt(officialSnapshot, maxOfficialChars) {
  const payload = {
    alert_id: officialSnapshot.alert_id,
    official_title: officialSnapshot.title || null,
    organization: officialSnapshot.organization || null,
    source: officialSnapshot.source || null,
    date: officialSnapshot.date || null,
    official_url: officialSnapshot.official_url || null,
    official_content: String(officialSnapshot.official_content || '').slice(0, maxOfficialChars),
  };
  return [
    'Clasifica esta unica alerta oficial. No uses conocimiento de clasificaciones anteriores.',
    JSON.stringify(payload, null, 2),
  ].join('\n\n');
}

async function classifyAlertWithAi1({
  officialSnapshot,
  maxOfficialChars,
  callAi = llamarIA,
} = {}) {
  const prompt = buildAi1Prompt(officialSnapshot, maxOfficialChars);
  const startedAt = Date.now();
  let raw = null;
  try {
    const response = await callAi(prompt, AI1_INSTRUCTIONS, AI1_MODEL, {
      task: 'shadow_v2_ai1',
      textFormat: AI1_TEXT_FORMAT,
      maxOutputTokens: 2500,
      retries: 0,
      returnMetadata: true,
      skipAudit: true,
    });
    raw = typeof response === 'string' ? response : response?.text;
    const normalized = normalizeAi1Result(parsearJSON(raw));
    return {
      status: 'SUCCESS',
      called: true,
      model: AI1_MODEL,
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
      model: AI1_MODEL,
      prompt,
      rawResponse: raw,
      normalizedResponse: null,
      usage: error?.metadata?.usage || null,
      durationMs: error?.metadata?.duration_ms ?? Date.now() - startedAt,
      error: {
        code: String(error?.message || 'ai1_error').slice(0, 120),
        message: String(error?.message || error).slice(0, 1000),
      },
    };
  }
}

module.exports = {
  AI1_MODEL,
  AI1_TEXT_FORMAT,
  AI1_INSTRUCTIONS,
  AI1_CONTRACT_VERSION: VERSIONS.ai1Contract,
  AI1_PROMPT_VERSION: VERSIONS.ai1Prompt,
  normalizeAi1Result,
  buildAi1Prompt,
  classifyAlertWithAi1,
};
