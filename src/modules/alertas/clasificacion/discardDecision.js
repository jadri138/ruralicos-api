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
});

const DISCARD_REASON_CODES = Object.freeze(Object.keys(DISCARD_REASON_MESSAGES));
const HARD_DISCARD_REASON_CODES = Object.freeze([
  'proceso_personal_publico',
  'pesca_maritimo_no_agrario',
  'administracion_general_no_agraria',
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

  return {
    estado_ia: 'descartado',
    resumen: 'NO IMPORTA',
    discard_reason_code: normalizedCode,
    discard_reason: normalizedReason,
    discard_stage: normalizedStage,
    discard_confidence: normalizedConfidence,
    decision_audit: {
      version: 'alert_decision_audit_v2',
      preclassification: preclassification && typeof preclassification === 'object'
        ? preclassification
        : {},
      classification: classification && typeof classification === 'object'
        ? classification
        : {},
      discard: {
        code: normalizedCode,
        reason: normalizedReason,
        stage: normalizedStage,
        confidence: normalizedConfidence,
      },
    },
  };
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
  HARD_DISCARD_REASON_CODES,
  construirDescarteAuditable,
  limpiarCamposDescarte,
  metadatosDescartePreclasificador,
  normalizarCodigoDescarte,
  normalizarConfianzaDescarte,
  obtenerClasificacionAlerta,
  obtenerPreclasificacionAlerta,
};
