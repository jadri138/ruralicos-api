const FEEDBACK_CATEGORIES = Object.freeze({
  WRONG_TOPIC: 'wrong_topic',
  WRONG_LOCATION: 'wrong_location',
  TOO_GENERIC: 'too_generic',
  MISCLASSIFICATION: 'misclassification',
  INDIVIDUAL_CASE_NOISE: 'individual_case_noise',
  USER_PROFILE_MISSING: 'user_profile_missing',
  USEFUL: 'useful',
  UNCLEAR: 'unclear',
});

function normalizarTexto(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function textoAlerta(alerta = {}) {
  return normalizarTexto([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen,
    alerta.contenido,
    ...(Array.isArray(alerta.provincias) ? alerta.provincias : []),
    ...(Array.isArray(alerta.sectores) ? alerta.sectores : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
  ].filter(Boolean).join(' '));
}

function flagsAlerta(alerta = {}) {
  return [
    ...(Array.isArray(alerta.final_validation_flags) ? alerta.final_validation_flags : []),
    ...(Array.isArray(alerta.calidad_mia?.flags) ? alerta.calidad_mia.flags : []),
    ...(Array.isArray(alerta.fact_sheet?.flags) ? alerta.fact_sheet.flags : []),
    ...(Array.isArray(alerta.decision_digest?.diagnostico?.policy?.riesgo_de_ruido?.reasons)
      ? alerta.decision_digest.diagnostico.policy.riesgo_de_ruido.reasons.map((reason) => reason.code)
      : []),
  ].filter(Boolean);
}

function classifyByRules(text, alertText, flags) {
  const reasons = [];

  if (/\b(no es de mi zona|fuera de mi zona|otra provincia|otro municipio|no es mi pueblo|demasiado lejos|no es de aqui|territorio|provincia incorrecta)\b/.test(text) ||
    flags.includes('territory_claim_without_evidence') ||
    flags.includes('territorio_no_verificado')) {
    reasons.push('location_signal');
    return { category: FEEDBACK_CATEGORIES.WRONG_LOCATION, confidence: 0.9, reasons };
  }

  if (/\b(expediente individual|caso particular|titular concreto|no es mio|concesion de agua concreta|notificacion individual|sancion individual)\b/.test(text) ||
    /\b(expediente individual|concesion de aguas|procedimiento sancionador|notificacion)\b/.test(alertText) ||
    flags.includes('expediente_individual') ||
    flags.includes('notificacion_individual')) {
    reasons.push('individual_case_signal');
    return { category: FEEDBACK_CATEGORIES.INDIVIDUAL_CASE_NOISE, confidence: 0.88, reasons };
  }

  if (/\b(no es ayuda|no es subvencion|no es curso|no es normativa|esta mal clasificado|mal clasificado|clasificacion incorrecta|esto es licitacion|es una licitacion)\b/.test(text) ||
    flags.includes('aid_claim_weak_evidence') ||
    flags.includes('contradiccion_sector_tipo')) {
    reasons.push('misclassification_signal');
    return { category: FEEDBACK_CATEGORIES.MISCLASSIFICATION, confidence: 0.84, reasons };
  }

  if (/\b(no dice nada|muy generico|demasiado generico|no se entiende|sin detalle|sin resumen|no aporta|revisar si afecta|publicacion oficial relevante)\b/.test(text) ||
    flags.includes('generic_digest_phrase') ||
    flags.includes('resumen_generico')) {
    reasons.push('generic_signal');
    return { category: FEEDBACK_CATEGORIES.TOO_GENERIC, confidence: 0.82, reasons };
  }

  if (/\b(no soy|yo soy|me dedico a|no tengo|tengo|mi explotacion es|solo quiero|no quiero recibir)\b/.test(text)) {
    reasons.push('profile_update_signal');
    return { category: FEEDBACK_CATEGORIES.USER_PROFILE_MISSING, confidence: 0.76, reasons };
  }

  if (/\b(no me interesa|no encaja|no va conmigo|no tiene que ver|no es para mi|no aplica)\b/.test(text)) {
    reasons.push('topic_mismatch_signal');
    return { category: FEEDBACK_CATEGORIES.WRONG_TOPIC, confidence: 0.68, reasons };
  }

  return { category: FEEDBACK_CATEGORIES.UNCLEAR, confidence: 0.45, reasons: ['negative_unclear'] };
}

function clasificarFeedbackDigest({
  texto = '',
  feedback = {},
  alerta = {},
} = {}) {
  const valor = Number(feedback.valor);
  const text = normalizarTexto([texto, feedback.razon].filter(Boolean).join(' '));
  const alertText = textoAlerta(alerta);
  const flags = flagsAlerta(alerta);

  if (valor > 0) {
    return {
      category: FEEDBACK_CATEGORIES.USEFUL,
      confidence: Number(feedback.confidence || 0.8),
      reasons: ['positive_feedback'],
      evidence: { text_excerpt: text.slice(0, 240), flags },
    };
  }

  if (valor === 0) {
    return {
      category: FEEDBACK_CATEGORIES.UNCLEAR,
      confidence: 0.4,
      reasons: ['neutral_feedback'],
      evidence: { text_excerpt: text.slice(0, 240), flags },
    };
  }

  const result = classifyByRules(text, alertText, flags);
  return {
    ...result,
    evidence: {
      text_excerpt: text.slice(0, 240),
      alert_excerpt: alertText.slice(0, 240),
      flags,
    },
  };
}

module.exports = {
  FEEDBACK_CATEGORIES,
  clasificarFeedbackDigest,
};
