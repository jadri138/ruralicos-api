const FORBIDDEN_PATTERNS = [
  /\bque tengas\b.*\b(buen|gran|feliz)\b.*\b(dia|jornada|manana|tarde)\b/i,
  /\b(buen|feliz)\b.*\b(dia|jornada)\b.*\b(granja|finca|explotacion|campo|vacas|ganado|cultivos)\b/i,
  /\b(disfruta|aprovecha|animo|suerte)\b.*\b(dia|jornada|granja|finca|campo|vacas|ganado|cultivos)\b/i,
  /\bque vaya bien\b.*\b(granja|finca|campo|vacas|ganado|cultivos|jornada)\b/i,
  /^espero que\b.*\b(dia|jornada|granja|finca|campo|vacas|ganado|cultivos)\b/i,
  /\btu granja\b|\btus vacas\b|\btus animales\b/i,
];

const JAIME_PATTERN = /\bjaime\b/i;

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function compactarLineas(texto) {
  return String(texto || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((linea) => linea.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function pareceSaludoPersonal(linea) {
  const limpio = normalizar(linea).replace(/[*_`~]/g, '');
  if (!/^hola\b/.test(limpio)) return false;
  if (limpio === 'hola' || limpio === 'hola ruralicos') return false;
  return true;
}

function contienePatronProhibido(texto) {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(String(texto || '')));
}

function limpiarRespuestaMIA(texto, {
  maxChars = 1800,
  replacePersonalName = true,
  senderName = 'Ruralicos',
  supportLabel = null,
} = {}) {
  const original = String(texto || '');
  const flags = [];
  const safeSender = String(senderName || 'Ruralicos').trim() || 'Ruralicos';
  const safeSupportLabel = String(supportLabel || `el equipo de ${safeSender}`).trim();

  let lineas = compactarLineas(original);
  if (lineas.length === 0) {
    return { text: '', flags: ['empty_reply'], changed: original.length > 0 };
  }

  if (lineas.some((linea) => contienePatronProhibido(linea))) {
    flags.push('removed_weird_personalization');
    lineas = lineas.filter((linea) => !contienePatronProhibido(linea));
  }

  if (lineas[0] && pareceSaludoPersonal(lineas[0])) {
    flags.push('removed_personal_greeting');
    lineas = lineas.slice(1);
  }

  let cleaned = lineas.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  if (JAIME_PATTERN.test(cleaned)) {
    flags.push('replaced_personal_sender');
    if (replacePersonalName) cleaned = cleaned.replace(/\bJaime\b/gi, safeSender);
  }

  cleaned = cleaned
    .replace(/\bmi pareja y yo\b/gi, safeSupportLabel)
    .replace(/\byo personalmente\b/gi, safeSender)
    .replace(/\s+\n/g, '\n')
    .trim();

  if (cleaned.length > maxChars) {
    flags.push('truncated_reply');
    cleaned = cleaned.slice(0, maxChars).trim();
  }

  if (!cleaned) flags.push('empty_reply_after_guard');

  return {
    text: cleaned,
    flags: [...new Set(flags)],
    changed: cleaned !== original.trim(),
  };
}

function evaluarRespuestaMIA(texto, { decision = {}, senderName = null, supportLabel = null } = {}) {
  const branding = decision.organization_context || {};
  const resolvedSenderName = senderName || branding.reply_sender || branding.brand_name || 'Ruralicos';
  const resolvedSupportLabel = supportLabel || branding.support_label || null;
  const cleaned = limpiarRespuestaMIA(texto, {
    senderName: resolvedSenderName,
    supportLabel: resolvedSupportLabel,
  });
  const flags = [...cleaned.flags];
  const normalized = normalizar(cleaned.text);
  const policy = decision.policy || {};
  const knowledge = decision.knowledge_context || {};
  const outcome = policy.outcome || '';
  const tipoPregunta = knowledge.tipo_pregunta || '';

  if (!cleaned.text) flags.push('empty_reply');
  if (JAIME_PATTERN.test(String(texto || ''))) flags.push('mentions_personal_sender');
  if (contienePatronProhibido(texto)) flags.push('weird_personalization');

  const autoAnswer = outcome === 'auto_answer' || decision.auto_answered === true;
  const hasEvidenceMarker = /\[E\d+\]/.test(cleaned.text) || /https?:\/\//i.test(cleaned.text);
  if (autoAnswer && knowledge.answered && !hasEvidenceMarker) {
    flags.push('auto_answer_without_visible_evidence');
  }

  if (['pago', 'fecha_resolucion', 'plazo'].includes(tipoPregunta) && policy.requires_agent === false) {
    flags.push('sensitive_answer_without_agent_review');
  }

  if (normalized.includes('seguro que') || normalized.includes('te garantizo')) {
    flags.push('overconfident_language');
  }

  return {
    ok: flags.length === 0,
    text: cleaned.text,
    flags: [...new Set(flags)],
    changed: cleaned.changed,
  };
}

module.exports = {
  limpiarRespuestaMIA,
  evaluarRespuestaMIA,
  contienePatronProhibido,
};
