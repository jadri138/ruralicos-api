const TOPIC_LABELS = {
  pac: 'la PAC',
  ayudas_maquinaria: 'las ayudas para maquinaria',
  ayudas_subvenciones: 'las ayudas y subvenciones',
  agua_riego: 'el agua y el riego',
  olivar: 'el olivar',
  porcino: 'el porcino',
  vacuno: 'el vacuno',
  ovino: 'el ovino',
  caprino: 'el caprino',
  apicultura: 'la apicultura',
  cereal: 'los cereales',
  frutales: 'los frutales',
  vinedo: 'el viñedo',
  formacion: 'los cursos y jornadas',
  medio_ambiente: 'el medio ambiente y los montes',
  plazos: 'los plazos y fechas límite',
  normativa_general: 'los cambios normativos',
};
const EXPLORATION_CONTROL_PREFIX = 'MIA_EXPLORATION_CONTROL:';

function normalizar(texto = '') {
  return String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function etiquetaTema(topic = '') {
  return TOPIC_LABELS[topic] || String(topic || 'este tema').replace(/_/g, ' ');
}

function estimarGananciaInformacion(topic = {}) {
  const confidenceRaw = Number(topic.confidence ?? 0.5);
  const conflictRatioRaw = Number(topic.conflict_ratio ?? (topic.declared_conflict ? 1 : 0.5));
  const confidence = Math.max(0, Math.min(1, Number.isFinite(confidenceRaw) ? confidenceRaw : 0.5));
  const conflictRatio = Math.max(0, Math.min(1, Number.isFinite(conflictRatioRaw) ? conflictRatioRaw : 0.5));
  const declaredBoost = topic.declared_conflict ? 0.2 : 0.1;
  return Number((conflictRatio * 0.55 + (1 - confidence) * 0.25 + declaredBoost).toFixed(4));
}

function detectarZonaIncertidumbre({ user = {}, memorias = [], perfil = null } = {}) {
  const conflicto = [...(perfil?.uncertain_topics || [])]
    .filter((item) => item?.topic)
    .sort((a, b) => estimarGananciaInformacion(b) - estimarGananciaInformacion(a))[0];
  if (conflicto?.topic) {
    return {
      kind: 'conflicting_topic',
      topic: conflicto.topic,
      label: etiquetaTema(conflicto.topic),
      reason: conflicto.declared_conflict
        ? 'declared_preference_conflict'
        : 'learned_signals_conflict',
      confidence: Number(conflicto.confidence || 0),
      information_gain: estimarGananciaInformacion(conflicto),
    };
  }

  const prefs = user.preferences || {};
  const tipos = Object.entries(prefs.tipos_alerta || {})
    .filter(([, activo]) => activo === true)
    .map(([tipo]) => tipo);
  const declaradas = [
    ...(Array.isArray(prefs.subsectores) ? prefs.subsectores : []),
    ...tipos,
    ...(Array.isArray(prefs.sectores) ? prefs.sectores : []),
  ];
  const textoMemoria = normalizar(memorias.map((m) => `${m.tipo} ${m.contenido}`).join(' '));
  const sinConfirmar = declaradas.find((tema) => {
    const value = normalizar(tema);
    return value && !textoMemoria.includes(value);
  });

  if (sinConfirmar) {
    const topic = normalizar(sinConfirmar).replace(/\s+/g, '_');
    return {
      kind: 'declared_topic_unconfirmed',
      topic,
      label: etiquetaTema(topic),
      reason: 'declared_topic_without_recent_signal',
      confidence: 0.5,
      information_gain: 0.5,
    };
  }

  return {
    kind: 'open_profile',
    topic: null,
    label: null,
    reason: 'profile_with_low_recent_signal',
    confidence: 0.25,
    information_gain: 0.25,
  };
}

function construirPreguntaExploracion(zona = {}) {
  if (zona.topic) {
    const inicio = zona.kind === 'conflicting_topic'
      ? 'He recibido señales contradictorias'
      : 'Quiero confirmar una preferencia';
    return `${inicio} sobre ${zona.label}. ¿Cuándo te interesa recibir esas alertas y cuándo no? Puedes responder con tus propias palabras.`;
  }
  return '¿Qué tema agrícola o ganadero quieres que priorice en tus próximas alertas?';
}

function esConversacionExploracion(conversacion = null) {
  return conversacion?.tipo === 'pregunta_exploracion' &&
    Boolean(conversacion?.contexto_json?.zona_incertidumbre);
}

function analizarRespuestaExploracion(texto = '', conversacion = null) {
  if (!esConversacionExploracion(conversacion)) return null;
  const zona = conversacion.contexto_json.zona_incertidumbre || {};
  if (!zona.topic) return null;

  const value = normalizar(texto).replace(/[.!?]+$/g, '');
  const negativa = /^(no|no quiero|mejor no|prefiero que no|no me interesa|dejalo)$/.test(value);
  const positiva = /^(si|vale|correcto|de acuerdo|me interesa|quiero|priorizalo)$/.test(value);
  if (!positiva && !negativa) return null;

  const label = zona.label || etiquetaTema(zona.topic);
  return {
    topic: zona.topic,
    label,
    polarity: negativa ? 'negative' : 'positive',
    memory_type: negativa ? 'desinteres_detectado' : 'interes_detectado',
    content: negativa ? `No le interesa ${label}` : `Le interesa ${label}`,
  };
}

function analizarControlExploracion(texto = '', conversacion = null) {
  const value = normalizar(texto);

  if (/\b(vuelve|puedes|quiero que)\b.*\b(preguntar|preguntarme|preguntas)\b/.test(value)) {
    return {
      action: 'active',
      content: `${EXPLORATION_CONTROL_PREFIX}active`,
      reply: 'Entendido. Solo preguntaré cuando necesite aclarar algo importante.',
    };
  }
  if (/\b(no me preguntes|deja de preguntarme|no quiero preguntas|sin preguntas)\b/.test(value)) {
    return {
      action: 'paused',
      content: `${EXPLORATION_CONTROL_PREFIX}paused`,
      reply: 'Entendido. No volveré a hacerte preguntas automáticas.',
    };
  }
  if (!esConversacionExploracion(conversacion)) return null;
  if (/\b(ahora no|mas adelante|otro dia|no lo se|no se|prefiero no responder)\b/.test(value)) {
    return {
      action: 'snoozed',
      content: `${EXPLORATION_CONTROL_PREFIX}snoozed`,
      reply: 'De acuerdo. No hace falta responder ahora.',
    };
  }
  return null;
}

function estadoExploracionDesdeMemorias(memorias = []) {
  const control = (memorias || []).find((memoria) =>
    String(memoria?.contenido || '').startsWith(EXPLORATION_CONTROL_PREFIX)
  );
  if (!control) return 'active';
  return String(control.contenido).slice(EXPLORATION_CONTROL_PREFIX.length) || 'active';
}

module.exports = {
  EXPLORATION_CONTROL_PREFIX,
  TOPIC_LABELS,
  analizarControlExploracion,
  analizarRespuestaExploracion,
  construirPreguntaExploracion,
  detectarZonaIncertidumbre,
  esConversacionExploracion,
  estadoExploracionDesdeMemorias,
  estimarGananciaInformacion,
  etiquetaTema,
};
