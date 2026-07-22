// Contrato unico para persistir descartes de alertas de forma auditable.
// No incluye campos de taxonomia ni de preclasificacion: un descarte nuevo no
// debe borrar informacion que ya existia en la alerta.

const DISCARD_REASON_MESSAGES = Object.freeze({
  proceso_personal_publico: 'La publicacion corresponde a empleo publico, oposiciones, nombramientos o provision de personal.',
  pesca_maritimo_no_agrario: 'La publicacion trata de pesca o actividad maritima sin relacion agraria suficiente.',
  administracion_general_no_agraria: 'La publicacion corresponde a administracion general sin relacion operativa con el medio rural.',
  sin_senal_rural: 'No se detectaron senales suficientes de agricultura, ganaderia o actividad rural.',
  preclasificador_regla_descarte: 'El preclasificador detecto ruido administrativo sin senales rurales suficientes.',
  clasificador_ia_no_relevante: 'El clasificador marco la alerta como no relevante sin proporcionar un motivo especifico.',
  aviso_legal_privacidad_no_rural: 'La publicacion es un aviso legal o de proteccion de datos sin contenido rural.',
  actividad_cultural_no_rural: 'La publicacion corresponde a un premio o actividad cultural sin alcance rural agrario.',
  centro_educativo_privado_no_rural: 'La publicacion autoriza la apertura de un centro educativo privado sin alcance rural agrario.',
  instalacion_gas_individual_no_rural: 'La publicacion tramita una instalacion individual de gas sin impacto agrario expreso.',
  urbanismo_no_agrario: 'La publicacion trata de urbanismo industrial o terciario sin impacto agrario expreso.',
  autorizacion_ambiental_individual_no_agraria: 'La publicacion tramita una autorizacion ambiental individual de una empresa sin impacto agrario colectivo expreso.',
  procedimiento_empresarial_individual_no_agrario: 'La publicacion tramita un procedimiento empresarial individual que no pertenece al digest rural general.',
  association_registration_without_user_action: 'La publicacion inscribe una asociacion en un registro y no abre ninguna actuacion para el usuario.',
  cultural_content_out_of_scope: 'La publicacion trata contenido cultural sin relacion operativa con la actividad agraria.',
  sports_grant_out_of_scope: 'La convocatoria se dirige exclusivamente a clubes, entidades o actividades deportivas.',
  non_agricultural_collective_agreement: 'La publicacion es un convenio colectivo sin relacion con la actividad agraria.',
  legacy_unstructured_discard: 'Descarte historico cuyo motivo original no puede deducirse de los datos conservados.',
});

const DISCARD_REASON_CODES = Object.freeze(Object.keys(DISCARD_REASON_MESSAGES));
const DISCARD_COMPATIBILITY_SUMMARY = 'NO IMPORTA';
const DISCARD_REQUIRED_FIELDS = Object.freeze([
  'discard_reason_code',
  'discard_reason',
  'discard_stage',
  'discard_confidence',
  'decision_audit',
]);
const HARD_DISCARD_REASON_CODES = Object.freeze([
  'proceso_personal_publico',
  'pesca_maritimo_no_agrario',
  'administracion_general_no_agraria',
  'association_registration_without_user_action',
  'cultural_content_out_of_scope',
  'sports_grant_out_of_scope',
  'non_agricultural_collective_agreement',
]);

function normalizarConfianzaDescarte(value, fallback = 0.5) {
  if (value === null || value === undefined || value === '') return fallback;
  const numero = Number(value);
  if (!Number.isFinite(numero)) return fallback;
  return Math.min(1, Math.max(0, numero));
}

function normalizarCodigoDescarte(code, fallback = 'clasificador_ia_no_relevante') {
  const value = typeof code === 'string' ? code.trim() : '';
  return /^[a-z][a-z0-9_]{2,63}$/.test(value) ? value : fallback;
}

function construirDescarteAuditable({
  code,
  reason,
  stage,
  confidence,
  preclassification,
  classification,
  previousAudit,
} = {}) {
  const fallbackCode = 'clasificador_ia_no_relevante';
  const requestedCode = normalizarCodigoDescarte(code, fallbackCode);
  const suppliedReason = typeof reason === 'string' ? reason.trim() : '';
  const normalizedCode = suppliedReason || DISCARD_REASON_MESSAGES[requestedCode]
    ? requestedCode
    : fallbackCode;
  const normalizedReason = suppliedReason || DISCARD_REASON_MESSAGES[normalizedCode];
  const normalizedStage = typeof stage === 'string' && stage.trim()
    ? stage.trim()
    : 'classifier_ai';
  const normalizedConfidence = normalizarConfianzaDescarte(confidence);
  const auditAnterior = previousAudit && typeof previousAudit === 'object' && !Array.isArray(previousAudit)
    ? previousAudit
    : {};
  const preclasificacionAuditada = preclassification && typeof preclassification === 'object'
    ? preclassification
    : auditAnterior.preclassification && typeof auditAnterior.preclassification === 'object'
      ? auditAnterior.preclassification
      : {};
  const clasificacionAuditada = classification && typeof classification === 'object'
    ? classification
    : auditAnterior.classification && typeof auditAnterior.classification === 'object'
      ? auditAnterior.classification
      : {};

  return {
    estado_ia: 'descartado',
    resumen: DISCARD_COMPATIBILITY_SUMMARY,
    discard_reason_code: normalizedCode,
    discard_reason: normalizedReason,
    discard_stage: normalizedStage,
    discard_confidence: normalizedConfidence,
    decision_audit: {
      ...auditAnterior,
      version: 'alert_decision_audit_v2',
      preclassification: preclasificacionAuditada,
      classification: clasificacionAuditada,
      discard: {
        code: normalizedCode,
        reason: normalizedReason,
        stage: normalizedStage,
        confidence: normalizedConfidence,
      },
    },
  };
}

function obtenerCamposFaltantesDescarte(alerta = {}) {
  const faltantes = [];
  const textoValido = (value) => typeof value === 'string' && Boolean(value.trim());
  const confianzaValida = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

  if (!textoValido(alerta.discard_reason_code)) faltantes.push('discard_reason_code');
  if (!textoValido(alerta.discard_reason)) faltantes.push('discard_reason');
  if (!textoValido(alerta.discard_stage)) faltantes.push('discard_stage');
  if (!confianzaValida(alerta.discard_confidence)) faltantes.push('discard_confidence');

  const audit = alerta.decision_audit;
  const discardAudit = audit && typeof audit === 'object' && !Array.isArray(audit)
    ? audit.discard
    : null;
  if (!discardAudit || typeof discardAudit !== 'object' || Array.isArray(discardAudit)) {
    faltantes.push('decision_audit');
    return faltantes;
  }

  if (
    discardAudit.code !== alerta.discard_reason_code
    || discardAudit.reason !== alerta.discard_reason
    || discardAudit.stage !== alerta.discard_stage
    || discardAudit.confidence !== alerta.discard_confidence
  ) {
    faltantes.push('decision_audit');
  }

  return faltantes;
}

function esAlertaDescartada(alerta = {}) {
  return alerta.estado_ia === 'descartado';
}

function esResumenDescarteVisual(value) {
  return value === DISCARD_COMPATIBILITY_SUMMARY;
}

function esDescarteAuditable(alerta = {}) {
  return esAlertaDescartada(alerta) && obtenerCamposFaltantesDescarte(alerta).length === 0;
}

function limpiarCamposDescarte() {
  return {
    discard_reason_code: null,
    discard_reason: null,
    discard_stage: null,
    discard_confidence: null,
  };
}

function obtenerPreclasificacionAlerta(alerta = {}) {
  const auditada = alerta.decision_audit?.preclassification;
  if (auditada && typeof auditada === 'object') return auditada;

  const reconstruida = {
    pre_score: alerta.pre_score,
    pre_status: alerta.pre_status,
    pre_reasons: alerta.pre_reasons,
    candidate_level: alerta.candidate_level,
  };
  return Object.values(reconstruida).some((value) => value !== null && value !== undefined)
    ? reconstruida
    : {};
}

function obtenerClasificacionAlerta(alerta = {}) {
  const auditada = alerta.decision_audit?.classification;
  return auditada && typeof auditada === 'object' ? auditada : {};
}

function metadatosDescartePreclasificador(preclassification = {}) {
  const reasons = Array.isArray(preclassification.pre_reasons)
    ? preclassification.pre_reasons
    : [];
  const exclusion = reasons.find((item) =>
    item && HARD_DISCARD_REASON_CODES.includes(item.tag)
  )?.tag;

  const code = exclusion || 'preclasificador_regla_descarte';
  return {
    code,
    reason: DISCARD_REASON_MESSAGES[code],
    stage: 'preclassifier',
    confidence: exclusion ? 1 : 0.9,
  };
}

module.exports = {
  DISCARD_REASON_CODES,
  DISCARD_REASON_MESSAGES,
  DISCARD_COMPATIBILITY_SUMMARY,
  DISCARD_REQUIRED_FIELDS,
  HARD_DISCARD_REASON_CODES,
  construirDescarteAuditable,
  esAlertaDescartada,
  esDescarteAuditable,
  esResumenDescarteVisual,
  limpiarCamposDescarte,
  metadatosDescartePreclasificador,
  normalizarCodigoDescarte,
  normalizarConfianzaDescarte,
  obtenerCamposFaltantesDescarte,
  obtenerClasificacionAlerta,
  obtenerPreclasificacionAlerta,
};
