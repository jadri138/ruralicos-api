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
      action: { type: 'string', maxLength: 240 },
      deadline: {
        anyOf: [
          { type: 'string', format: 'date' },
          { type: 'null' },
        ],
      },
      summary: { type: 'string', maxLength: 450 },
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
  'Un puesto de empleo publico, un convenio entre entidades, una autorizacion ya concedida a una empresa o una declaracion de impacto ya resuelta no son utiles para usuarios rurales solo por mencionar agricultura, agua, montes, suelo o medio ambiente.',
  'Si el unico destinatario de la accion es una administracion, una empresa nombrada o las entidades firmantes, usa actionable=false; no conviertas su tramite interno en una accion para terceros.',
  'Clasifica territorio, actividades, beneficiarios, tipo, accion y plazo usando exclusivamente el documento actual.',
  'activities contiene como maximo tres actividades directamente afectadas; no anadas sectores rurales amplios por contexto.',
  'No escribas dudas, interrogantes ni etiquetas tentativas en activities o beneficiary_types. Si el documento no demuestra un dato, deja el array vacio.',
  'Usa aid para ayudas abiertas, opportunity para cursos o participacion abierta, obligation para deberes vigentes e information solo si no hay una accion mas concreta.',
  'deadline es exclusivamente la fecha limite para que la persona beneficiaria solicite, alegue, recurra, se inscriba o cumpla una obligacion.',
  'Usa una fecha YYYY-MM-DD solo si aparece de forma explicita en el documento como ese plazo. No calcules plazos relativos ni dias habiles: usa null.',
  'Nunca uses como deadline una transferencia o pago entre organismos, la vigencia o firma de un convenio, la publicacion o resolucion, ni el inicio o fin de un curso.',
  'Una concesion, adjudicacion o convocatoria ya resuelta o cerrada no es una oportunidad abierta.',
  'Escribe summary en espanol claro, en una o dos frases breves, con un maximo de 450 caracteres y solo los hechos utiles para decidir.',
  'Escribe action en espanol, en infinitivo y como una unica accion concreta de la persona; no uses barras, alternativas vagas ni anglicismos.',
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

function supportedDeadline(value, officialContent) {
  if (!isIsoDate(value)) return null;
  const deadline = String(value);
  if (officialContent === undefined) return deadline;

  const [year, month, day] = deadline.split('-');
  const numericDay = String(Number(day));
  const numericMonth = String(Number(month));
  const monthName = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ][Number(month) - 1];
  if (!monthName) return null;

  const source = String(officialContent || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
  const variants = [...new Set([
    deadline,
    `${day}/${month}/${year}`,
    `${numericDay}/${numericMonth}/${year}`,
    `${day}-${month}-${year}`,
    `${numericDay}-${numericMonth}-${year}`,
    `${numericDay} de ${monthName} de ${year}`,
    `${numericDay} de ${monthName} ${year}`,
    `${numericDay} ${monthName} ${year}`,
  ])];
  const actionSignal = /\b(plazo|fecha limite|solicitud(?:es)?|alegacion(?:es)?|recurso(?:s)?|recurrir|inscripcion(?:es)?|subsanacion|oferta(?:s)?|proposicion(?:es)?|cumplir|cumplimiento|comunicar|comunicacion|justificar|justificacion)\b/;
  const nonUserDate = /\b(transferid\w*|transferencia|pago al ico|abono al ico|vigencia del convenio|firma del convenio|suscripcion del convenio|inicio del curso|fin del curso|finalizacion del curso)\b|\bfechas?\s*:\s*del\b/;

  return variants.some((variant) => {
    let index = source.indexOf(variant);
    while (index !== -1) {
      const before = source.slice(Math.max(0, index - 180), index);
      const after = source.slice(index + variant.length, index + variant.length + 140);
      const context = `${before}${variant}${after}`;
      const isDocumentDate = /\b(?:fecha de )?(?:publicacion|resolucion)\s*(?:de|del)?\s*:?\s*$|\b(?:resolucion|orden|anuncio)\s+de\s*$|\bpublicad[oa]\s+(?:el|con fecha)\s*$/.test(before);
      if (actionSignal.test(before) && !nonUserDate.test(context) && !isDocumentDate) return true;
      index = source.indexOf(variant, index + variant.length);
    }
    return false;
  }) ? deadline : null;
}

function normalizeAi1Result(value, { officialContent, officialDate } = {}) {
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

  const action = cleanString(value.action, 240);
  const summary = cleanString(value.summary, 450);
  const evidence = cleanStringArray(value.evidence, 10, 500);
  if (!summary) throw new Error('ai1_missing_summary');
  if (evidence.length === 0) throw new Error('ai1_insufficient_evidence');
  if (value.actionable && !action) throw new Error('ai1_missing_action');
  const supported = supportedDeadline(value.deadline, officialContent);
  const deadline = isIsoDate(officialDate) && supported === officialDate ? null : supported;

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
    const normalized = normalizeAi1Result(parsearJSON(raw), {
      officialContent: officialSnapshot?.official_content || '',
      officialDate: officialSnapshot?.date,
    });
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
