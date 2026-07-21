const {
  FACT_SHEET_STATUS,
  campoConEvidenciaOficial,
  campoVerificado,
  normalizarTexto,
  recalcularEvidencias,
} = require('./factSheetSchema');

const FIELD_WEIGHTS = {
  tipo_documento: 1,
  tema_principal: 1,
  resumen_neutro: 1,
  url_oficial: 1,
};

const FLAG_SEVERITY = {
  sin_url_oficial: 40,
  evidencia_minima_insuficiente: 25,
  tipo_documento_no_verificado: 15,
  tema_principal_no_verificado: 12,
  resumen_generico: 35,
  territorio_no_verificado: 30,
  sector_no_verificado: 15,
  plazo_no_verificado: 18,
  ayuda_sin_beneficiario_o_convocatoria: 18,
  expediente_individual: 25,
  notificacion_individual: 55,
  sancion_individual: 55,
  contradiccion_sector_tipo: 45,
  taxonomy_conflict: 45,
  unsupported_taxonomy_tag: 18,
  empty_taxonomy_ready: 55,
  cross_sector_match: 55,
};

function textoFactSheet(sheet = {}) {
  return normalizarTexto([
    sheet.tipo_documento?.valor,
    sheet.tema_principal?.valor,
    sheet.resumen_neutro?.valor,
    sheet.accion_requerida?.valor,
    sheet.accion_codigo?.valor,
    sheet.plazo?.valor,
    sheet.publication_date?.valor,
    sheet.effective_date?.valor,
    sheet.application_deadline?.valor,
    sheet.allegation_deadline?.valor,
    sheet.appeal_deadline?.valor,
    sheet.justification_deadline?.valor,
    sheet.beneficiarios?.valor,
    sheet.importe?.valor,
    ...(sheet.territorio || []).map((item) => item.valor),
    ...(sheet.sectores || []).map((item) => item.valor),
    ...(sheet.subsectores || []).map((item) => item.valor),
    ...(sheet.requisitos || []).map((item) => item.valor),
    ...(sheet.taxonomy_evidence || []).map((item) => `${item.tag} ${item.evidence}`),
    ...(sheet.evidencias || []).map((item) => item.evidencia),
  ].filter(Boolean).join(' '));
}

function textoAlerta(alerta = {}) {
  return normalizarTexto([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen,
    alerta.resumen_borrador,
    alerta.contenido,
  ].filter(Boolean).join(' '));
}

function addIssue(issues, flag, reason, severity = FLAG_SEVERITY[flag] || 10) {
  issues.push({ flag, reason, severity });
}

function esAyuda(sheet = {}, alerta = {}) {
  const text = `${textoFactSheet(sheet)} ${textoAlerta(alerta)}`;
  return /\b(ayuda|ayudas|subvencion|subvenciones|convocatoria|pac|fega)\b/.test(text);
}

function tieneConvocatoria(sheet = {}, alerta = {}) {
  const text = `${textoFactSheet(sheet)} ${textoAlerta(alerta)}`;
  return /\b(convocatoria|se convocan|extracto de la resolucion|bases reguladoras|beneficiarios)\b/.test(text);
}

function esExpedienteIndividual(sheet = {}, alerta = {}) {
  const text = `${textoFactSheet(sheet)} ${textoAlerta(alerta)}`;
  return /\b(expediente individual|parcela concreta|persona interesada|titular concreto|concesion de aguas|aprovechamiento de aguas|procedimiento sancionador|expediente sancionador|notificacion)\b/.test(text);
}

function esSancionONotificacion(sheet = {}, alerta = {}) {
  const text = `${textoFactSheet(sheet)} ${textoAlerta(alerta)}`;
  return /\b(notificacion|procedimiento sancionador|expediente sancionador|resolucion sancionadora|sancion)\b/.test(text);
}

function esResumenGenerico(sheet = {}, alerta = {}) {
  const text = normalizarTexto([
    sheet.resumen_neutro?.valor,
    sheet.tema_principal?.valor,
    alerta.resumen_final,
    alerta.resumen,
    alerta.titulo,
  ].filter(Boolean).join(' '));
  if (!text) return false;
  return /\b(publicacion oficial relevante|revisar si afecta|revisar si aplica|determinar su aplicabilidad|consulta el documento|documento completo)\b/.test(text);
}

function hayContradiccionSector(sheet = {}, alerta = {}) {
  const sheetText = textoFactSheet(sheet);
  const alertText = textoAlerta(alerta);
  const sectorValues = (sheet.sectores || []).map((item) => normalizarTexto(item.valor));
  const agrario = sectorValues.includes('agricultura') || sectorValues.includes('ganaderia');
  const pescaNoAgraria = /\b(pesca|pesquero|acuicultura|maritima|maritimo)\b/.test(alertText) &&
    !/\b(agraria|agrario|agricola|ganaderia|explotacion agraria|regadio|riego)\b/.test(alertText);

  return (agrario && pescaNoAgraria) ||
    (/\bcurso\b/.test(sheetText) && /\b(sancion|procedimiento sancionador)\b/.test(alertText));
}

function camposCoverage(sheet = {}, alerta = {}) {
  const weights = { ...FIELD_WEIGHTS };
  const text = textoAlerta(alerta);

  if ((alerta.provincias || []).length > 0 || (sheet.territorio || []).length > 0) {
    weights.territorio = 1;
  }
  if ((alerta.sectores || []).length > 0 || (sheet.sectores || []).length > 0) {
    weights.sectores = 1;
  }
  if ((alerta.subsectores || []).length > 0 || (sheet.subsectores || []).length > 0) {
    weights.subsectores = 0.75;
  }
  if (
    sheet.accion_requerida?.valor ||
    /\b(solicitud|inscripcion|alegacion|subsanacion|documentacion|obligacion)\b/.test(text)
  ) {
    weights.accion_requerida = 1;
  }
  if (esAyuda(sheet, alerta) || /\b(plazo|hasta el|finaliza|vence|dias habiles)\b/.test(text)) {
    weights.plazo = 1;
  }
  if (esAyuda(sheet, alerta)) weights.beneficiarios = 1;
  if (/\b(importe|cuantia|euros?)\b/.test(text)) weights.importe = 0.75;
  if (/\b(requisitos?|documentacion|deberan|anexo)\b/.test(text)) weights.requisitos = 0.75;

  return weights;
}

function calcularCoverage(sheet = {}, alerta = {}, fieldCheck = campoVerificado) {
  let total = 0;
  let covered = 0;

  for (const [field, weight] of Object.entries(camposCoverage(sheet, alerta))) {
    total += weight;
    if (fieldCheck(sheet[field])) covered += weight;
  }

  return total ? Number((covered / total).toFixed(2)) : 0;
}

function resolverProcedenciaEvidencia(sheet = {}) {
  const evidences = Array.isArray(sheet.evidencias) ? sheet.evidencias : [];
  const official = evidences.filter((item) => item.evidence_level === 'official').length;
  const derived = evidences.filter((item) => item.evidence_level === 'derived').length;
  if (official > 0 && derived > 0) return 'mixed';
  if (official > 0) return 'official';
  if (derived > 0) return 'derived';
  return 'none';
}

function estadoDesdeIssues(issues, coverage) {
  const flags = new Set(issues.map((issue) => issue.flag));
  if (
    flags.has('sin_url_oficial') ||
    flags.has('notificacion_individual') ||
    flags.has('sancion_individual') ||
    flags.has('resumen_generico') ||
    flags.has('territorio_no_verificado') ||
    flags.has('contradiccion_sector_tipo')
    || flags.has('taxonomy_conflict')
    || flags.has('empty_taxonomy_ready')
    || flags.has('cross_sector_match')
  ) {
    return FACT_SHEET_STATUS.BLOCKED;
  }

  if (coverage < 0.4 || flags.has('evidencia_minima_insuficiente')) {
    return FACT_SHEET_STATUS.INSUFFICIENT_EVIDENCE;
  }

  if (issues.length > 0 || coverage < 0.7) {
    return FACT_SHEET_STATUS.REVIEW;
  }

  return FACT_SHEET_STATUS.READY;
}

function validarFactSheet(input = {}, { alerta = {} } = {}) {
  const sheet = recalcularEvidencias(input);
  const issues = [];

  if (!campoVerificado(sheet.url_oficial)) {
    addIssue(issues, 'sin_url_oficial', 'La ficha no tiene URL oficial verificada.');
  }

  if (!campoVerificado(sheet.tipo_documento)) {
    addIssue(issues, 'tipo_documento_no_verificado', 'No hay tipo documental con evidencia textual.');
  }

  if (!campoVerificado(sheet.tema_principal)) {
    addIssue(issues, 'tema_principal_no_verificado', 'No hay tema principal verificable.');
  }

  if (!campoVerificado(sheet.resumen_neutro)) {
    addIssue(issues, 'evidencia_minima_insuficiente', 'No hay resumen neutro verificable.');
  }

  if (!campoVerificado(sheet.territorio) && Array.isArray(alerta.provincias) && alerta.provincias.length > 0) {
    addIssue(issues, 'territorio_no_verificado', 'La alerta declara territorio, pero no aparece evidencia textual clara.');
  }

  if (!campoVerificado(sheet.sectores) && Array.isArray(alerta.sectores) && alerta.sectores.length > 0) {
    addIssue(issues, 'sector_no_verificado', 'La alerta declara sector, pero no hay evidencia textual clara.');
  }

  if (sheet.plazo?.valor && !sheet.plazo?.evidencia) {
    addIssue(issues, 'plazo_no_verificado', 'La ficha contiene plazo sin evidencia textual.');
  }

  if (esAyuda(sheet, alerta) && !campoVerificado(sheet.plazo)) {
    addIssue(issues, 'plazo_no_verificado', 'La ayuda no tiene plazo verificado.');
  }

  if (esAyuda(sheet, alerta) && !campoVerificado(sheet.beneficiarios) && !tieneConvocatoria(sheet, alerta)) {
    addIssue(issues, 'ayuda_sin_beneficiario_o_convocatoria', 'La ayuda no demuestra beneficiarios ni convocatoria.');
  }

  if (esExpedienteIndividual(sheet, alerta)) {
    addIssue(issues, 'expediente_individual', 'Parece expediente particular o de titular concreto.');
  }

  if (esSancionONotificacion(sheet, alerta)) {
    const flag = /\bsancion|sancionador\b/.test(`${textoFactSheet(sheet)} ${textoAlerta(alerta)}`)
      ? 'sancion_individual'
      : 'notificacion_individual';
    addIssue(issues, flag, 'Sancion o notificacion individual no apta para digest automatico.');
  }

  if (esResumenGenerico(sheet, alerta)) {
    addIssue(issues, 'resumen_generico', 'El resumen no identifica objeto administrativo concreto.');
  }

  if (hayContradiccionSector(sheet, alerta)) {
    addIssue(issues, 'contradiccion_sector_tipo', 'Hay contradiccion entre texto, sector o tipo documental.');
  }

  const taxonomyValidation = alerta.taxonomy_validation || {};
  const topicValidation = taxonomyValidation.topic_validation || {};
  if (
    ['blocked', 'incoherent'].includes(taxonomyValidation.status) ||
    ['blocked', 'incoherent'].includes(topicValidation.status)
  ) {
    addIssue(issues, 'taxonomy_conflict', 'La validacion taxonomica detecta una incoherencia no reparada.');
  }

  for (const tag of sheet.unsupported_taxonomy_tags || []) {
    addIssue(issues, 'unsupported_taxonomy_tag', `La etiqueta ${tag} no tiene evidencia textual.`);
  }

  if (
    alerta.estado_ia === 'listo' &&
    (alerta.sectores || []).length === 0 &&
    (alerta.subsectores || []).length === 0 &&
    (alerta.tipos_alerta || []).length === 0
  ) {
    addIssue(issues, 'empty_taxonomy_ready', 'Una alerta lista no puede conservar la taxonomia completamente vacia.');
  }

  if ((alerta.audience_reach?.flags || []).includes('cross_sector_mass_match')) {
    addIssue(issues, 'cross_sector_match', 'La alerta alcanza perfiles de un sector incompatible.');
  }

  const coverage = calcularCoverage(sheet, alerta);
  const officialCoverage = calcularCoverage(sheet, alerta, campoConEvidenciaOficial);
  const risk = Math.min(100, issues.reduce((acc, issue) => acc + Number(issue.severity || 0), 0));
  const truth = Math.max(0, Math.round((coverage * 100) - Math.min(35, risk * 0.35)));
  const status = estadoDesdeIssues(issues, coverage);

  return {
    ...sheet,
    truth_score: truth,
    risk_score: risk,
    evidence_coverage: coverage,
    official_evidence_coverage: officialCoverage,
    evidence_provenance: resolverProcedenciaEvidencia(sheet),
    status,
    flags: [...new Set(issues.map((issue) => issue.flag))],
    reasons: issues.map((issue) => ({
      code: issue.flag,
      detail: issue.reason,
      severity: issue.severity,
    })),
  };
}

module.exports = {
  FIELD_WEIGHTS,
  FLAG_SEVERITY,
  camposCoverage,
  calcularCoverage,
  resolverProcedenciaEvidencia,
  validarFactSheet,
};
