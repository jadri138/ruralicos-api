const {
  FACT_SHEET_VERSION,
  FACT_SHEET_STATUS,
  EVIDENCE_COVERAGE,
  FACT_FIELDS,
  ARRAY_FACT_FIELDS,
  NO_VERIFICADO,
  esValorVerificado,
  calcularEvidenceScore,
  coverageFromScore,
} = require('./factSheetSchema');

function factHasValue(fact) {
  if (!fact || typeof fact !== 'object') return false;
  if (Array.isArray(fact.value)) return fact.value.length > 0;
  return fact.value !== null && fact.value !== undefined && fact.value !== NO_VERIFICADO;
}

function validarFactSheet(sheet = {}) {
  const errores = [];
  const avisos = [];
  const addError = (code, detail) => errores.push({ code, detail });
  const addAviso = (code, detail) => avisos.push({ code, detail });

  if (sheet.version !== FACT_SHEET_VERSION) {
    addError('version_invalida', `Version esperada: ${FACT_SHEET_VERSION}.`);
  }

  if (!Object.values(FACT_SHEET_STATUS).includes(sheet.status)) {
    addError('status_invalido', 'El status no pertenece al contrato fact_sheet_v1.');
  }

  if (!Object.values(EVIDENCE_COVERAGE).includes(sheet.evidence_coverage)) {
    addError('coverage_invalida', 'evidence_coverage debe ser alto, medio o bajo.');
  }

  if (!sheet.facts || typeof sheet.facts !== 'object') {
    addError('facts_missing', 'Falta el objeto facts.');
  }

  const evidences = Array.isArray(sheet.evidences) ? sheet.evidences : [];
  const evidenceById = new Map(evidences.map((evidence) => [evidence.id, evidence]));

  for (const evidence of evidences) {
    if (!evidence.id || !evidence.quote || !evidence.field) {
      addError('evidence_incompleta', `Evidencia incompleta: ${evidence.id || 'sin_id'}.`);
    }
  }

  for (const field of [...FACT_FIELDS, ...ARRAY_FACT_FIELDS, 'expediente']) {
    const fact = sheet.facts?.[field];
    if (!factHasValue(fact)) continue;

    if (!esValorVerificado(fact)) {
      addError('fact_without_evidence', `${field} tiene valor pero no evidencia textual.`);
      continue;
    }

    for (const ref of fact.evidence_refs || []) {
      const evidence = evidenceById.get(ref);
      if (!evidence) {
        addError('evidence_ref_missing', `${field} referencia evidencia inexistente: ${ref}.`);
      } else if (evidence.field !== field) {
        addError('evidence_field_mismatch', `${field} referencia evidencia de ${evidence.field}.`);
      }
    }
  }

  const hasTextEvidence = Boolean(sheet.source?.has_raw_document || sheet.source?.has_texto_fuente);
  if (!hasTextEvidence) {
    if (sheet.status !== FACT_SHEET_STATUS.REVIEW_ONLY) {
      addError('sin_evidencia_no_review_only', 'Sin rawDocument ni textoFuente, status debe ser review_only.');
    }
    if (sheet.evidence_coverage !== EVIDENCE_COVERAGE.BAJO || Number(sheet.evidence_score || 0) !== 0) {
      addError('sin_evidencia_coverage_invalida', 'Sin evidencia textual, coverage debe ser bajo y score 0.');
    }
    if (evidences.length > 0) {
      addError('sin_evidencia_con_evidences', 'Sin fuente textual no deben existir evidencias inventadas.');
    }
  }

  if (sheet.source?.relation_verified === false) {
    addError('raw_document_alerta_mismatch', 'raw_documents.inserted_alerta_id no coincide con alertas.id.');
  }

  if (sheet.source?.uses_alerta_raw_document_id !== false) {
    addError('depends_on_alertas_raw_document_id', 'El contrato prohibe depender de alertas.raw_document_id.');
  }

  const expectedScore = calcularEvidenceScore(sheet.facts || {});
  const expectedCoverage = coverageFromScore(expectedScore);
  if (Number(sheet.evidence_score || 0) !== expectedScore) {
    addAviso('evidence_score_desactualizado', `Score esperado ${expectedScore}, recibido ${sheet.evidence_score}.`);
  }
  if (sheet.evidence_coverage !== expectedCoverage) {
    addAviso('evidence_coverage_desactualizada', `Coverage esperada ${expectedCoverage}, recibida ${sheet.evidence_coverage}.`);
  }

  const statusSugerido = sugerirStatus({ sheet, errores, expectedCoverage });
  if (sheet.status !== statusSugerido) {
    addAviso('status_sugerido_distinto', `Status sugerido: ${statusSugerido}.`);
  }

  const codigos = [...errores, ...avisos].map((item) => item.code);
  return {
    ok: errores.length === 0,
    status_sugerido: statusSugerido,
    errores,
    avisos,
    codigos,
  };
}

function sugerirStatus({ sheet, errores, expectedCoverage }) {
  if (errores.length > 0) return FACT_SHEET_STATUS.REVIEW_ONLY;
  if (!sheet.source?.has_raw_document && !sheet.source?.has_texto_fuente) return FACT_SHEET_STATUS.REVIEW_ONLY;
  if (expectedCoverage === EVIDENCE_COVERAGE.BAJO) return FACT_SHEET_STATUS.REVIEW_ONLY;
  if (expectedCoverage === EVIDENCE_COVERAGE.MEDIO) return FACT_SHEET_STATUS.PARTIAL;
  return FACT_SHEET_STATUS.READY;
}

module.exports = {
  validarFactSheet,
  validateFactSheet: validarFactSheet,
};
