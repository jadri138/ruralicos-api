const { llamarIA } = require('../platform/ia/llamarIA');
const { obtenerMiaBranding } = require('./organizationContext');

const DEFAULT_MODEL = process.env.MIA_GROUNDED_MODEL || 'gpt-4o-mini';
const DEFAULT_MAX_REPLY_LENGTH = Number(process.env.MIA_GROUNDED_MAX_REPLY_LENGTH || 1200);
const FORBIDDEN_PATTERNS = [
  /\bjaime\b/i,
  /\bsoy\s+jaime\b/i,
  /\ben\s+mi\s+nombre\b/i,
  /\bmi\s+granja\b/i,
  /\btu\s+granja\b/i,
  /\bvacas?\b/i,
  /\bovejas?\b/i,
  /\bque\s+tengas\s+un\s+buen\s+d(?:ia|\u00eda)\b/i,
  /\bfeliz\s+d(?:ia|\u00eda)\b/i,
];

function envFlag(name, defaultValue = true) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function compactarTexto(texto, max = 500) {
  const limpio = String(texto || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (limpio.length <= max) return limpio;
  return `${limpio.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function prepararEvidenciasMIA(matches = [], { max = 3 } = {}) {
  return (Array.isArray(matches) ? matches : [])
    .filter((match) => match && match.id)
    .slice(0, max)
    .map((match, index) => ({
      ref: `E${index + 1}`,
      id: match.id,
      titulo: compactarTexto(match.titulo, 220),
      resumen: compactarTexto(match.snippet || match.resumen, 520),
      fecha: match.fecha || null,
      region: match.region || null,
      fuente: match.fuente || null,
      url: match.url || null,
      score: Number(match.score || 0),
      matching_terms: match.matching_terms || [],
      matching_regions: match.matching_regions || [],
      fechas_detectadas: match.fechas_detectadas || [],
    }));
}

function quitarSaludoInicial(texto) {
  return String(texto || '')
    .replace(/^\s*(hola|buenas|buenos d(?:ias|\u00edas)|buenas tardes|buenas noches)[,!.:\-\s]+/i, '')
    .trim();
}

function limpiarRespuestaGroundedMIA(texto, { maxLength = DEFAULT_MAX_REPLY_LENGTH } = {}) {
  const lineas = String(texto || '')
    .replace(/```[a-z]*|```/gi, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((linea) => quitarSaludoInicial(linea).trim())
    .filter(Boolean)
    .filter((linea) => !FORBIDDEN_PATTERNS.some((pattern) => pattern.test(linea)));

  const limpio = lineas
    .join('\n')
    .replace(/\bDon\s+[A-Z][^\n,.]{1,80}/g, '')
    .replace(/\bDona\s+[A-Z][^\n,.]{1,80}/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return compactoConCorteSeguro(limpio, maxLength);
}

function compactoConCorteSeguro(texto, max = DEFAULT_MAX_REPLY_LENGTH) {
  const value = String(texto || '').trim();
  if (value.length <= max) return value;
  const corte = value.slice(0, max);
  const ultimoSalto = corte.lastIndexOf('\n');
  const ultimoPunto = corte.lastIndexOf('.');
  const pos = Math.max(ultimoSalto, ultimoPunto);
  if (pos > Math.floor(max * 0.65)) return corte.slice(0, pos + 1).trim();
  return `${corte.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function respuestaTieneReferenciaValida(texto, evidencias = []) {
  if (!evidencias.length) return false;
  const refsValidas = new Set(evidencias.map((evidencia) => `[${evidencia.ref}]`));
  const refsEncontradas = String(texto || '').match(/\[E\d+\]/g) || [];
  return refsEncontradas.some((ref) => refsValidas.has(ref));
}

function contienePatronProhibido(texto) {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(String(texto || '')));
}

function respuestaConfirmaDatoSensible(texto, tipoPregunta) {
  if (!['pago', 'fecha_resolucion', 'plazo'].includes(tipoPregunta)) return false;
  const normalizado = String(texto || '').toLowerCase();
  const afirmaPago = /\b(se\s+pagar(?:a|\u00e1)|se\s+paga|cobrar(?:as|\u00e1s|a|\u00e1)|ingresar(?:an|\u00e1n)|ingresan|abonar(?:an|\u00e1n)|se\s+abonar(?:a|\u00e1))\b/.test(normalizado);
  const afirmaFecha = /\b(sale|saldr(?:a|\u00e1)|se\s+publica|se\s+publicar(?:a|\u00e1)|se\s+resolver(?:a|\u00e1)|ser(?:a|\u00e1))\s+(el\s+)?\d{1,2}\b/.test(normalizado);
  const contieneCautela = /\b(no\s+confirma|sin\s+confirmar|revis|agente|referencia|indicio|aparece)\b/.test(normalizado);
  return (afirmaPago || afirmaFecha) && !contieneCautela;
}

function validarRespuestaGroundedMIA(texto, {
  evidencias = [],
  tipoPregunta = 'general',
  needsAgent = false,
} = {}) {
  const reasons = [];
  if (!String(texto || '').trim()) reasons.push('empty_reply');
  if (contienePatronProhibido(texto)) reasons.push('forbidden_persona_or_flair');
  if (!respuestaTieneReferenciaValida(texto, evidencias)) reasons.push('missing_valid_evidence_reference');
  if (respuestaConfirmaDatoSensible(texto, tipoPregunta)) reasons.push('sensitive_claim_without_caution');
  if (needsAgent && !/\b(agente|equipo|revis)/i.test(String(texto || ''))) {
    reasons.push('missing_escalation_notice');
  }
  return { ok: reasons.length === 0, reasons };
}

function construirRespuestaFallbackGroundedMIA({
  matches = [],
  tipoPregunta = 'general',
  evidenceLevel = 'sin_evidencia',
  needsAgent = true,
  organizationContext = null,
} = {}) {
  const branding = obtenerMiaBranding(organizationContext);
  const evidencias = prepararEvidenciasMIA(matches);
  const top = evidencias[0] || null;
  const sensible = ['pago', 'fecha_resolucion', 'plazo'].includes(tipoPregunta);
  const lineas = [];

  if (!top) {
    lineas.push(`${branding.assistant_name} no ha encontrado una referencia suficiente en la base de ${branding.reply_sender} para responder con seguridad.`);
    lineas.push(`Lo revisa ${branding.agent_label} y te contestamos cuando haya una respuesta clara.`);
    return {
      reply: lineas.join('\n'),
      answer_source: 'deterministic_no_evidence',
      answer_guardrails: ['no_evidence', 'agent_escalation'],
      evidences: evidencias,
    };
  }

  if (sensible) {
    lineas.push(`${branding.assistant_name} ha encontrado referencias relacionadas en la base de ${branding.reply_sender}, pero no confirma fechas, pagos ni plazos sin revision.`);
  } else {
    lineas.push(`${branding.assistant_name} ha encontrado referencias relacionadas en la base de ${branding.reply_sender}.`);
  }

  lineas.push(`Referencia principal [${top.ref}]: ${top.titulo}${top.fecha ? ` (${top.fecha})` : ''}.`);
  if (top.resumen) lineas.push(`Resumen: ${compactarTexto(top.resumen, 340)}`);

  const fechas = [...new Set([top.fecha, ...(top.fechas_detectadas || [])].filter(Boolean))].slice(0, 4);
  if (sensible && fechas.length) {
    lineas.push(`Fechas que aparecen en la referencia: ${fechas.join(', ')}.`);
  }

  if (top.url) lineas.push(top.url);
  if (needsAgent || sensible || evidenceLevel === 'baja') {
    lineas.push(`Lo dejamos revisado por ${branding.agent_label} para darte una respuesta confirmada.`);
  }

  return {
    reply: compactoConCorteSeguro(lineas.join('\n'), DEFAULT_MAX_REPLY_LENGTH),
    answer_source: 'deterministic_grounded',
    answer_guardrails: [
      'evidence_reference_required',
      sensible ? 'sensitive_answer_requires_review' : 'evidence_limited_answer',
    ],
    evidences: evidencias,
  };
}

function construirPromptGroundedMIA({
  texto,
  tipoPregunta,
  evidenceLevel,
  needsAgent,
  evidencias,
} = {}) {
  return [
    'Mensaje del usuario:',
    String(texto || '').trim(),
    '',
    `Tipo de pregunta: ${tipoPregunta || 'general'}`,
    `Nivel de evidencia: ${evidenceLevel || 'desconocido'}`,
    `Debe escalar a agente: ${needsAgent ? 'si' : 'no'}`,
    '',
    'Evidencias disponibles:',
    JSON.stringify(evidencias, null, 2),
  ].join('\n');
}

function instruccionesGroundedMIA(organizationContext = null) {
  const branding = obtenerMiaBranding(organizationContext);
  return [
    `Eres ${branding.assistant_name}, asistente de ${branding.reply_sender}. Respondes en nombre de ${branding.reply_sender}, nunca como una persona concreta.`,
    'Usa solo las evidencias aportadas. No inventes fechas, pagos, requisitos, importes ni estados administrativos.',
    `Si la pregunta trata de pagos, plazos o resoluciones, ofrece solo lo que aparece en las evidencias y deja claro que ${branding.reply_sender} lo revisa con un agente si no hay certeza.`,
    'Escribe para WhatsApp: claro, breve, profesional y util. Sin saludos personalizados, sin apellidos, sin despedidas creativas y sin bromas.',
    'No uses terminos internos de producto o ingenieria como digest, outbox, webhook, payload, retrieval, embedding, policy o decision_json; di "resumen de alertas", "respuesta", "busqueda" o "registro" si hace falta.',
    'Incluye al menos una cita de evidencia con formato [E1], [E2] o [E3]. No cites referencias que no existan.',
    `Si debe escalar a agente, dilo de forma natural como "lo revisa ${branding.agent_label}".`,
    'Devuelve solo el texto final para el usuario, sin JSON ni markdown.',
  ].join('\n');
}

async function generarRespuestaGroundedMIA({
  texto,
  matches = [],
  tipoPregunta = 'general',
  answered = false,
  needsAgent = true,
  evidenceLevel = 'sin_evidencia',
  confidence = 0,
  llamarIAFn = llamarIA,
  model = DEFAULT_MODEL,
  forceAI = false,
  organizationContext = null,
} = {}) {
  const fallback = construirRespuestaFallbackGroundedMIA({
    matches,
    tipoPregunta,
    evidenceLevel,
    needsAgent,
    organizationContext,
  });
  const evidencias = fallback.evidences || prepararEvidenciasMIA(matches);
  const canUseAI = (
    answered
    && evidencias.length > 0
    && Number(confidence || 0) >= 0.5
    && envFlag('MIA_GROUNDED_AI_ENABLED', true)
    && (forceAI || Boolean(process.env.OPENAI_API_KEY))
  );

  if (!canUseAI) {
    return {
      ...fallback,
      answer_guardrails: [...new Set([...(fallback.answer_guardrails || []), 'ai_not_used'])],
    };
  }

  try {
    const raw = await llamarIAFn(
      construirPromptGroundedMIA({ texto, tipoPregunta, evidenceLevel, needsAgent, evidencias }),
      instruccionesGroundedMIA(organizationContext),
      model,
      { maxOutputTokens: Number(process.env.MIA_GROUNDED_MAX_TOKENS || 450) }
    );
    const limpio = limpiarRespuestaGroundedMIA(raw);
    const validation = validarRespuestaGroundedMIA(limpio, { evidencias, tipoPregunta, needsAgent });

    if (!validation.ok) {
      return {
        ...fallback,
        answer_source: 'deterministic_after_guardrail',
        answer_guardrails: [...new Set([...(fallback.answer_guardrails || []), ...validation.reasons])],
      };
    }

    return {
      reply: limpio,
      answer_source: 'ai_grounded',
      answer_guardrails: ['evidence_reference_required', 'validated_grounded_reply'],
      evidences: evidencias,
    };
  } catch (error) {
    return {
      ...fallback,
      answer_source: 'deterministic_after_ai_error',
      answer_guardrails: [...new Set([...(fallback.answer_guardrails || []), 'ai_generation_error'])],
      answer_error: error.message,
    };
  }
}

module.exports = {
  prepararEvidenciasMIA,
  limpiarRespuestaGroundedMIA,
  validarRespuestaGroundedMIA,
  construirRespuestaFallbackGroundedMIA,
  generarRespuestaGroundedMIA,
};
