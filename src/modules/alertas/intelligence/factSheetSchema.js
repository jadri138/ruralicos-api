const FACT_SHEET_SCHEMA_VERSION = 'fact_sheet_v1';
const FACT_SHEET_BUILDER_VERSION = 'fact_sheet_builder_v1';

const FACT_SHEET_STATUS = Object.freeze({
  READY: 'ready_for_digest',
  REVIEW: 'review_only',
  BLOCKED: 'blocked',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
});

function compactarTexto(value, max = 600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, Math.max(0, max - 3)).trim() + '...' : text;
}

function normalizarTexto(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarLista(value, normalizer = (item) => item) {
  if (Array.isArray(value)) return value.map(normalizer).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/[,;\n]/g)
    .map((item) => normalizer(item.trim()))
    .filter(Boolean);
}

function crearCampo(valor = null, evidencia = null, options = {}) {
  const cleanEvidence = compactarTexto(evidencia, options.maxEvidence || 500);
  const hasValue = valor !== undefined && valor !== null && String(valor).trim() !== '';
  return {
    valor: hasValue ? valor : null,
    evidencia: cleanEvidence,
    source: options.source || null,
    confidence: Number.isFinite(Number(options.confidence)) ? Number(options.confidence) : 0,
    status: hasValue && cleanEvidence ? 'verified' : 'no_verificado',
  };
}

function crearFactSheetBase({ alerta = {}, trace = null, now = new Date() } = {}) {
  return {
    schema_version: FACT_SHEET_SCHEMA_VERSION,
    builder_version: FACT_SHEET_BUILDER_VERSION,
    generated_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    alerta_id: alerta.id ?? alerta.alerta_id ?? null,
    raw_document_id: trace?.raw_document_id ?? null,
    content_hash: trace?.content_hash ?? null,
    document_trace: trace ? {
      status: trace.status || null,
      reason: trace.reason || null,
      relation: trace.relation || null,
      evidence_available: Boolean(trace.evidence_available),
      source_url: trace.source_url || null,
      official_id: trace.official_id || null,
      warnings: Array.isArray(trace.warnings) ? trace.warnings : [],
    } : null,
    tipo_documento: crearCampo(),
    tema_principal: crearCampo(),
    resumen_neutro: crearCampo(),
    territorio: [],
    sectores: [],
    subsectores: [],
    accion_requerida: crearCampo(),
    plazo: crearCampo(),
    beneficiarios: crearCampo(),
    importe: crearCampo(),
    requisitos: [],
    url_oficial: crearCampo(),
    evidencias: [],
    truth_score: 0,
    risk_score: 100,
    evidence_coverage: 0,
    status: FACT_SHEET_STATUS.INSUFFICIENT_EVIDENCE,
    flags: [],
    reasons: [],
  };
}

function campoVerificado(field) {
  if (Array.isArray(field)) return field.some(campoVerificado);
  return Boolean(field && field.valor !== null && field.evidencia);
}

function agregarEvidencia(sheet, fieldName, field) {
  if (!sheet || !field) return sheet;
  const fields = Array.isArray(field) ? field : [field];
  const existing = new Set((sheet.evidencias || []).map((item) => `${item.field}:${item.evidencia}`));

  for (const entry of fields) {
    if (!campoVerificado(entry)) continue;
    const item = {
      field: fieldName,
      valor: entry.valor,
      evidencia: entry.evidencia,
      source: entry.source || null,
      confidence: entry.confidence || 0,
    };
    const key = `${item.field}:${item.evidencia}`;
    if (existing.has(key)) continue;
    sheet.evidencias.push(item);
    existing.add(key);
  }

  return sheet;
}

function recalcularEvidencias(sheet) {
  const next = { ...sheet, evidencias: [] };
  const fieldNames = [
    'tipo_documento',
    'tema_principal',
    'resumen_neutro',
    'territorio',
    'sectores',
    'subsectores',
    'accion_requerida',
    'plazo',
    'beneficiarios',
    'importe',
    'requisitos',
    'url_oficial',
  ];

  for (const fieldName of fieldNames) {
    agregarEvidencia(next, fieldName, next[fieldName]);
  }

  return next;
}

module.exports = {
  FACT_SHEET_SCHEMA_VERSION,
  FACT_SHEET_BUILDER_VERSION,
  FACT_SHEET_STATUS,
  compactarTexto,
  normalizarTexto,
  normalizarLista,
  crearCampo,
  crearFactSheetBase,
  campoVerificado,
  agregarEvidencia,
  recalcularEvidencias,
};

