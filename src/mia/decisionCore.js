const { interpretarMensaje } = require('../utils/cerebro');

const DECISION_VERSION = 'mia_decision_v1';

const INTENTS = new Set([
  'feedback_digest',
  'actualizar_preferencias',
  'pregunta_usuario',
  'queja_servicio',
  'mensaje_libre',
  'spam_newsletter',
  'trivial',
  'unknown',
]);

const FEEDBACK_CONFIDENCES = new Set(['alta', 'media', 'baja']);

const MEMORY_TYPES = new Set([
  'interes_detectado',
  'desinteres_detectado',
  'indiferencia',
  'mensaje_libre',
  'dato_explotacion',
  'pregunta_usuario',
  'pregunta_sistema',
  'respuesta_exploracion',
  'evento_estacional',
  'feedback_positivo',
  'feedback_negativo',
]);

const PATRONES_RESPUESTA_RARA = [
  /\bque tengas\b.*\b(granja|vacas|ovejas|cabras|cerdos|tractor|tractores|campo|explotacion)\b/i,
  /\b(en|con) tu\b.*\b(granja|campo|explotacion|tractor|ganado)\b/i,
  /\bdisfruta\b.*\b(granja|vacas|ovejas|cabras|cerdos|tractor|tractores|campo|explotacion)\b/i,
];

function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function esMensajeTrivialMIA(texto) {
  const limpio = normalizarTexto(texto);
  if (!limpio) return true;
  if (esRespuestaCortaDeFeedbackMIA(limpio)) return false;
  if (limpio.length < 4) return true;
  return /^(hola|buen[ao]s(?: dias| tardes| noches)?|ok|vale|gracias|muchas gracias|si|no|perfecto|recibido)[\s.!?]*$/.test(limpio);
}

function esRespuestaCortaDeFeedbackMIA(texto) {
  const limpio = normalizarTexto(texto)
    .replace(/[\u{1F44D}\u{2705}\u{2B50}\u{1F31F}\u{1F49A}]/gu, '+')
    .replace(/[\u{1F44E}\u{274C}\u{1F6D1}]/gu, '-');

  return (
    /^[+-]?\s*\d{1,2}$/.test(limpio) ||
    /^\d{1,2}\s*[+-]$/.test(limpio) ||
    /^(ninguna|ninguno|ambas|todos|todas)$/.test(limpio) ||
    /^[+-]$/.test(limpio)
  );
}

function limpiarRespuestaMIA(texto) {
  const limpio = String(texto || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((linea) => linea.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((linea) => !PATRONES_RESPUESTA_RARA.some((patron) => patron.test(linea)))
    .join('\n')
    .trim()
    .slice(0, 800);

  return limpio
    .replace(/^hola\s+[^,\n.!?]{2,80}[,.!?\s]+/i, '')
    .replace(/^hola[,.!?\s]+/i, '')
    .trim();
}

function normalizarReplyAction(reply) {
  if (!reply || reply.canal !== 'whatsapp') return null;
  const texto = limpiarRespuestaMIA(reply.texto);
  if (!texto) return null;
  return { canal: 'whatsapp', texto };
}

function normalizarFeedbackAction(action = {}) {
  const itemNumero = Number(action.item_numero);
  const valor = Number(action.valor);
  if (!Number.isInteger(itemNumero) || itemNumero <= 0) return null;
  if (![-1, 0, 1].includes(valor)) return null;

  return {
    item_numero: itemNumero,
    valor,
    confianza: FEEDBACK_CONFIDENCES.has(action.confianza) ? action.confianza : 'media',
    razon: String(action.razon || '').trim().slice(0, 500),
  };
}

function normalizarMemoryAction(action = {}) {
  const contenido = String(action.contenido || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!contenido) return null;

  const peso = Number(action.peso_inicial);
  return {
    tipo: MEMORY_TYPES.has(action.tipo) ? action.tipo : 'mensaje_libre',
    contenido,
    peso_inicial: Number.isFinite(peso) ? Math.max(0.1, Math.min(1, peso)) : 0.5,
  };
}

function aplicarContratoAcciones(decision = {}, context = {}) {
  const totalItems = Array.isArray(context.alertasDelDigest) ? context.alertasDelDigest.length : 0;
  const riskFlags = [...(decision.risk_flags || [])];
  const feedbackActions = [];
  let feedbackDropped = 0;

  for (const action of decision.feedback_actions || []) {
    const normalized = normalizarFeedbackAction(action);
    const itemValido = normalized && normalized.item_numero <= totalItems;
    const confianzaEjecutable = normalized && normalized.confianza !== 'baja';

    if (!normalized || !itemValido || !confianzaEjecutable || decision.intent !== 'feedback_digest') {
      feedbackDropped++;
      continue;
    }
    feedbackActions.push(normalized);
  }

  if (feedbackDropped > 0) riskFlags.push('feedback_actions_dropped');
  if (decision.intent === 'feedback_digest' && feedbackActions.length === 0) {
    riskFlags.push('feedback_digest_without_executable_actions');
  }

  const memoryActions = (decision.memory_actions || [])
    .map(normalizarMemoryAction)
    .filter(Boolean);

  if ((decision.memory_actions || []).length > memoryActions.length) {
    riskFlags.push('memory_actions_dropped');
  }

  return {
    ...decision,
    feedback_actions: feedbackActions,
    memory_actions: memoryActions,
    risk_flags: [...new Set(riskFlags)],
  };
}

function extraerConfianzaInterpretacion(interpretacion = {}) {
  const valores = [];

  for (const feedback of interpretacion.feedbacks || []) {
    if (feedback.confianza === 'alta') valores.push(0.95);
    else if (feedback.confianza === 'media') valores.push(0.75);
    else if (feedback.confianza === 'baja') valores.push(0.35);
  }

  for (const memoria of interpretacion.memoria || []) {
    const peso = Number(memoria.peso_inicial);
    if (Number.isFinite(peso)) valores.push(Math.max(0.2, Math.min(1, peso)));
  }

  if (interpretacion.requiere_respuesta) valores.push(0.8);
  if (valores.length === 0) return 0.5;
  return Number((valores.reduce((acc, value) => acc + value, 0) / valores.length).toFixed(2));
}

function inferirIntent({ texto, interpretacion = {}, digest, alertasDelDigest = [] }) {
  if (esMensajeTrivialMIA(texto)) return 'trivial';

  const feedbacks = interpretacion.feedbacks || [];
  const memorias = interpretacion.memoria || [];
  const intencionLegacy = interpretacion.intencion || 'otro';

  if (intencionLegacy === 'pregunta') return 'pregunta_usuario';
  if (intencionLegacy === 'queja') return 'queja_servicio';

  if (feedbacks.length > 0 && digest && alertasDelDigest.length > 0) {
    return 'feedback_digest';
  }

  if (memorias.some((m) => ['interes_detectado', 'desinteres_detectado', 'dato_explotacion', 'evento_estacional'].includes(m.tipo))) {
    return 'actualizar_preferencias';
  }

  if (interpretacion.requiere_respuesta) return 'pregunta_usuario';
  if (intencionLegacy === 'conversacion') return 'mensaje_libre';
  return 'unknown';
}

function construirRiskFlags({ intent, interpretacion = {}, digest, alertasDelDigest = [] }) {
  const flags = [];

  if (!digest) flags.push('digest_missing');
  if (digest && alertasDelDigest.length === 0) flags.push('digest_without_items');
  if ((interpretacion.feedbacks || []).length > 0 && intent !== 'feedback_digest') {
    flags.push('feedback_without_valid_digest_context');
  }
  if ((interpretacion.feedbacks || []).some((feedback) => feedback.confianza === 'baja')) {
    flags.push('low_confidence_feedback');
  }
  if (extraerConfianzaInterpretacion(interpretacion) < 0.45) flags.push('low_confidence');

  return flags;
}

function normalizarDecision(raw = {}) {
  const intent = INTENTS.has(raw.intent) ? raw.intent : 'unknown';
  const confidence = Number(raw.confidence);
  const replyAction = normalizarReplyAction(raw.reply_action);
  const riskFlags = Array.isArray(raw.risk_flags)
    ? [...new Set(raw.risk_flags.filter(Boolean))]
    : [];

  if (
    raw.reply_action?.texto &&
    (!replyAction || replyAction.texto !== String(raw.reply_action.texto || '').trim())
  ) {
    riskFlags.push('reply_sanitized');
  }

  return {
    version: raw.version || DECISION_VERSION,
    intent,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    feedback_actions: Array.isArray(raw.feedback_actions)
      ? raw.feedback_actions.map(normalizarFeedbackAction).filter(Boolean)
      : [],
    memory_actions: Array.isArray(raw.memory_actions)
      ? raw.memory_actions.map(normalizarMemoryAction).filter(Boolean)
      : [],
    reply_action: replyAction,
    risk_flags: [...new Set(riskFlags)],
    summary: String(raw.summary || '').trim().slice(0, 600),
    legacy_interpretacion: raw.legacy_interpretacion || {
      feedbacks: [],
      memoria: [],
      requiere_respuesta: false,
      respuesta: '',
      intencion: 'otro',
      resumen_para_log: '',
    },
  };
}

function construirDecisionDesdeInterpretacion({
  texto,
  interpretacion,
  digest,
  alertasDelDigest,
}) {
  const intent = inferirIntent({ texto, interpretacion, digest, alertasDelDigest });
  const confidence = extraerConfianzaInterpretacion(interpretacion);
  const riskFlags = construirRiskFlags({ intent, interpretacion, digest, alertasDelDigest });

  const decision = normalizarDecision({
    intent,
    confidence,
    feedback_actions: (interpretacion.feedbacks || []).map((feedback) => ({
      item_numero: Number(feedback.item_numero),
      valor: Number(feedback.valor),
      confianza: feedback.confianza || 'media',
      razon: feedback.razon || '',
    })),
    memory_actions: (interpretacion.memoria || []).map((memoria) => ({
      tipo: memoria.tipo,
      contenido: memoria.contenido,
      peso_inicial: memoria.peso_inicial || 0.5,
    })),
    reply_action: interpretacion.requiere_respuesta && interpretacion.respuesta
      ? { canal: 'whatsapp', texto: interpretacion.respuesta }
      : null,
    risk_flags: riskFlags,
    summary: interpretacion.resumen_para_log || `Intent ${intent}`,
    legacy_interpretacion: interpretacion,
  });

  return aplicarContratoAcciones(decision, { digest, alertasDelDigest });
}

async function decidirMensajeMIA({ mensajeUsuario, usuario, conversacionActiva, digest, alertasDelDigest }) {
  if (esMensajeTrivialMIA(mensajeUsuario)) {
    return normalizarDecision({
      intent: 'trivial',
      confidence: 0.95,
      summary: 'Mensaje trivial sin acciones.',
      legacy_interpretacion: {
        feedbacks: [],
        memoria: [],
        requiere_respuesta: false,
        respuesta: '',
        intencion: 'otro',
        resumen_para_log: 'Mensaje trivial sin acciones',
      },
    });
  }

  const interpretacion = await interpretarMensaje({
    mensajeUsuario,
    usuario,
    conversacionActiva,
    alertasDelDigest,
  });

  return construirDecisionDesdeInterpretacion({
    texto: mensajeUsuario,
    interpretacion,
    digest,
    alertasDelDigest,
  });
}

module.exports = {
  DECISION_VERSION,
  decidirMensajeMIA,
  normalizarDecision,
  construirDecisionDesdeInterpretacion,
  inferirIntent,
  limpiarRespuestaMIA,
  aplicarContratoAcciones,
  esMensajeTrivialMIA,
  esRespuestaCortaDeFeedbackMIA,
};
