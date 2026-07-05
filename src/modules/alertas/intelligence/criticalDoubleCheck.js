const { llamarIA } = require('../../../platform/ia/llamarIA');
const { normalizarTexto } = require('./factSheetSchema');

const ENABLE_CRITICAL_DOUBLE_CHECK =
  (process.env.ENABLE_CRITICAL_DOUBLE_CHECK || 'false').toLowerCase() === 'true';

const CRITICAL_FIELDS = [
  'tipo_documento',
  'territorio',
  'plazo',
  'beneficiarios',
  'importe',
  'accion_requerida',
  'sectores',
  'subsectores',
];

function textoAlerta(alerta = {}) {
  return normalizarTexto([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen,
    alerta.contenido,
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
    ...(Array.isArray(alerta.sectores) ? alerta.sectores : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
  ].filter(Boolean).join(' '));
}

function textoFactSheet(factSheet = {}) {
  return normalizarTexto([
    factSheet.tipo_documento?.valor,
    factSheet.tema_principal?.valor,
    factSheet.resumen_neutro?.valor,
    factSheet.accion_requerida?.valor,
    factSheet.plazo?.valor,
    factSheet.beneficiarios?.valor,
    factSheet.importe?.valor,
    ...(factSheet.territorio || []).map((item) => item.valor),
    ...(factSheet.sectores || []).map((item) => item.valor),
    ...(factSheet.subsectores || []).map((item) => item.valor),
    ...(factSheet.requisitos || []).map((item) => item.valor),
    ...(factSheet.flags || []),
  ].filter(Boolean).join(' '));
}

function requiereDobleCheckCritico({ alerta = {}, factSheet = {}, itemValidation = null } = {}) {
  const text = `${textoAlerta(alerta)} ${textoFactSheet(factSheet)}`;
  const flags = [
    ...(Array.isArray(factSheet.flags) ? factSheet.flags : []),
    ...(Array.isArray(itemValidation?.flags) ? itemValidation.flags : []),
  ];

  return Boolean(
    /\b(ayuda|subvencion|pac|fega|fiscal|sanidad animal|bienestar animal|agua|riego|sancion|plazo|importe|beneficiarios)\b/.test(text) ||
    Number(factSheet.evidence_coverage || 1) < 0.7 ||
    Number(factSheet.risk_score || 0) > 35 ||
    flags.some((flag) => /deadline|amount|territory|aid|risk|blocked|review|evidence|contradiccion/.test(String(flag)))
  );
}

function safeJson(raw) {
  if (!raw || typeof raw !== 'string') return {};
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function normalizarCampo(value) {
  if (Array.isArray(value)) {
    return value.map(normalizarCampo).filter(Boolean).sort().join('|');
  }
  if (value && typeof value === 'object') {
    return normalizarCampo(value.valor || value.value || JSON.stringify(value));
  }
  return normalizarTexto(value);
}

function normalizarResultadoCheck(raw = {}) {
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw;
  const fields = parsed.fields && typeof parsed.fields === 'object' ? parsed.fields : parsed;
  const normalized = {};
  for (const field of CRITICAL_FIELDS) {
    normalized[field] = normalizarCampo(fields[field]);
  }
  return {
    status: ['send', 'review_only', 'blocked_review'].includes(parsed.status)
      ? parsed.status
      : 'review_only',
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
    fields: normalized,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
  };
}

function compararDobleCheck(a = {}, b = {}) {
  const left = normalizarResultadoCheck(a);
  const right = normalizarResultadoCheck(b);
  const disagreements = [];

  for (const field of CRITICAL_FIELDS) {
    const leftValue = left.fields[field] || '';
    const rightValue = right.fields[field] || '';
    if (leftValue !== rightValue) {
      disagreements.push({ field, left: leftValue || null, right: rightValue || null });
    }
  }

  if (left.status !== right.status) {
    disagreements.push({ field: 'status', left: left.status, right: right.status });
  }

  return {
    status: disagreements.length > 0 ? 'blocked_review' : left.status,
    ok: disagreements.length === 0 && left.status === 'send',
    disagreements,
    checker_a: left,
    checker_b: right,
  };
}

function construirPromptDobleCheck({ alerta = {}, factSheet = {}, mensaje = '' } = {}) {
  return [
    'Revisa si una alerta agroganadera puede enviarse automaticamente.',
    'Devuelve solo JSON con: status, confidence, fields y reasons.',
    'status debe ser send, review_only o blocked_review.',
    '',
    'ALERTA:',
    JSON.stringify({
      id: alerta.id,
      titulo: alerta.titulo,
      resumen_final: alerta.resumen_final,
      provincias: alerta.provincias,
      sectores: alerta.sectores,
      subsectores: alerta.subsectores,
      tipos_alerta: alerta.tipos_alerta,
      url: alerta.url,
    }, null, 2),
    '',
    'FACT_SHEET:',
    JSON.stringify(factSheet, null, 2),
    '',
    'MENSAJE:',
    String(mensaje || '').slice(0, 2400),
  ].join('\n');
}

async function ejecutarDobleCheckCritico({
  alerta = {},
  factSheet = {},
  mensaje = '',
  itemValidation = null,
  enabled = ENABLE_CRITICAL_DOUBLE_CHECK,
  force = false,
  checkerA = null,
  checkerB = null,
  llamarIAFn = llamarIA,
} = {}) {
  const required = requiereDobleCheckCritico({ alerta, factSheet, itemValidation });
  if (!required) {
    return { status: 'skipped', required: false, reason: 'not_critical' };
  }

  if (!enabled && !force) {
    return { status: 'skipped', required: true, reason: 'disabled' };
  }

  if (typeof checkerA === 'function' && typeof checkerB === 'function') {
    const [a, b] = await Promise.all([
      checkerA({ alerta, factSheet, mensaje, itemValidation }),
      checkerB({ alerta, factSheet, mensaje, itemValidation }),
    ]);
    return { required: true, ...compararDobleCheck(a, b) };
  }

  if (!process.env.OPENAI_API_KEY && !force) {
    return {
      status: 'blocked_review',
      required: true,
      ok: false,
      disagreements: [{ field: 'availability', left: 'missing_openai_api_key', right: 'missing_openai_api_key' }],
      reason: 'double_check_unavailable',
    };
  }

  const prompt = construirPromptDobleCheck({ alerta, factSheet, mensaje });
  const [rawA, rawB] = await Promise.all([
    llamarIAFn(prompt, 'Eres auditor juridico-agro. Se estricto y no inventes.', process.env.CRITICAL_DOUBLE_CHECK_MODEL_A || 'gpt-4o-mini', { task: 'double_check' }),
    llamarIAFn(prompt, 'Eres auditor de evidencia documental. Se conservador y bloquea dudas.', process.env.CRITICAL_DOUBLE_CHECK_MODEL_B || 'gpt-4o-mini', { task: 'double_check' }),
  ]);

  return { required: true, ...compararDobleCheck(rawA, rawB) };
}

module.exports = {
  ENABLE_CRITICAL_DOUBLE_CHECK,
  CRITICAL_FIELDS,
  requiereDobleCheckCritico,
  construirPromptDobleCheck,
  normalizarResultadoCheck,
  compararDobleCheck,
  ejecutarDobleCheckCritico,
};
