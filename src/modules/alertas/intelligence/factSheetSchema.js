const FACT_SHEET_VERSION = 'fact_sheet_v1';

const NO_VERIFICADO = 'no_verificado';

const FACT_SHEET_STATUS = Object.freeze({
  READY: 'ready',
  PARTIAL: 'partial',
  REVIEW_ONLY: 'review_only',
});

const EVIDENCE_COVERAGE = Object.freeze({
  ALTO: 'alto',
  MEDIO: 'medio',
  BAJO: 'bajo',
});

const FACT_FIELDS = Object.freeze([
  'titulo_oficial',
  'tipo_documento',
  'tema_principal',
  'territorio',
  'beneficiarios',
  'accion_requerida',
  'plazo',
  'importe',
]);

const ARRAY_FACT_FIELDS = Object.freeze([
  'requisitos',
]);

const DOCUMENT_TYPES = Object.freeze({
  AYUDA_SUBVENCION: 'ayuda_subvencion',
  CONCESION: 'concesion',
  SANCION: 'sancion',
  FORMACION: 'formacion',
  NORMATIVA: 'normativa',
  ANUNCIO_PUBLICO: 'anuncio_publico',
});

function normalizarTexto(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function limpiarTexto(value, max = 600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max).trim() : text;
}

function crearFact(value = NO_VERIFICADO, evidenceRefs = []) {
  const known = value !== null && value !== undefined && value !== NO_VERIFICADO;
  return {
    value: known ? value : NO_VERIFICADO,
    evidence_refs: known ? [...new Set(evidenceRefs.filter(Boolean))] : [],
  };
}

function crearArrayFact(values = [], evidenceRefs = []) {
  const cleanValues = [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
  return {
    value: cleanValues,
    evidence_refs: cleanValues.length ? [...new Set(evidenceRefs.filter(Boolean))] : [],
  };
}

function crearEvidence({ id, source, quote, field, value }) {
  const cleanQuote = limpiarTexto(quote, 500);
  if (!id || !cleanQuote || !field) return null;
  return {
    id,
    source: source || 'desconocido',
    quote: cleanQuote,
    field,
    value: value === undefined ? null : value,
  };
}

function esValorVerificado(fact) {
  if (!fact || typeof fact !== 'object') return false;
  if (Array.isArray(fact.value)) return fact.value.length > 0 && Array.isArray(fact.evidence_refs) && fact.evidence_refs.length > 0;
  return fact.value !== null &&
    fact.value !== undefined &&
    fact.value !== NO_VERIFICADO &&
    Array.isArray(fact.evidence_refs) &&
    fact.evidence_refs.length > 0;
}

function calcularEvidenceScore(facts = {}) {
  const total = FACT_FIELDS.length;
  const verified = FACT_FIELDS.filter((field) => esValorVerificado(facts[field])).length;
  return total ? Math.round((verified / total) * 100) / 100 : 0;
}

function coverageFromScore(score) {
  const value = Number(score || 0);
  if (value >= 0.67) return EVIDENCE_COVERAGE.ALTO;
  if (value >= 0.34) return EVIDENCE_COVERAGE.MEDIO;
  return EVIDENCE_COVERAGE.BAJO;
}

function crearFactSheetBase({ alerta = {}, rawDocument = null, textoFuente = null } = {}) {
  const alertaId = alerta?.id ?? alerta?.alerta_id ?? null;
  const insertedAlertaId = rawDocument?.inserted_alerta_id ?? null;
  const relationVerified = rawDocument && insertedAlertaId !== null && alertaId !== null
    ? Number(insertedAlertaId) === Number(alertaId)
    : null;

  return {
    version: FACT_SHEET_VERSION,
    status: FACT_SHEET_STATUS.REVIEW_ONLY,
    alerta_id: alertaId,
    evidence_coverage: EVIDENCE_COVERAGE.BAJO,
    evidence_score: 0,
    source: {
      input_contract: '{ alerta, rawDocument?: optional, textoFuente?: optional }',
      uses_alerta_raw_document_id: false,
      has_raw_document: Boolean(rawDocument),
      has_texto_fuente: Boolean(String(textoFuente || '').trim()),
      raw_document_id: rawDocument?.id ?? null,
      inserted_alerta_id: insertedAlertaId,
      relation: rawDocument ? 'raw_documents.inserted_alerta_id -> alertas.id' : null,
      relation_verified: relationVerified,
      fuente: rawDocument?.fuente ?? alerta?.fuente ?? null,
      fecha: rawDocument?.fecha ?? alerta?.fecha ?? null,
      urls: {
        oficial: rawDocument?.url ?? alerta?.url ?? null,
        html: rawDocument?.url_html ?? rawDocument?.urlHtml ?? null,
        pdf: rawDocument?.url_pdf ?? rawDocument?.urlPdf ?? null,
      },
    },
    facts: {
      titulo_oficial: crearFact(),
      tipo_documento: crearFact(),
      tema_principal: crearFact(),
      territorio: crearFact(),
      beneficiarios: crearFact(),
      accion_requerida: crearFact(),
      plazo: crearFact(),
      importe: crearFact(),
      expediente: crearFact(),
      requisitos: crearArrayFact(),
    },
    evidences: [],
    warnings: [],
  };
}

module.exports = {
  FACT_SHEET_VERSION,
  NO_VERIFICADO,
  FACT_SHEET_STATUS,
  EVIDENCE_COVERAGE,
  FACT_FIELDS,
  ARRAY_FACT_FIELDS,
  DOCUMENT_TYPES,
  normalizarTexto,
  limpiarTexto,
  crearFact,
  crearArrayFact,
  crearEvidence,
  esValorVerificado,
  calcularEvidenceScore,
  coverageFromScore,
  crearFactSheetBase,
};
