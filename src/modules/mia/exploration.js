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

function detectarZonaIncertidumbre({ user = {}, memorias = [], perfil = null } = {}) {
  const conflicto = perfil?.uncertain_topics?.[0];
  if (conflicto?.topic) {
    return {
      kind: 'conflicting_topic',
      topic: conflicto.topic,
      label: etiquetaTema(conflicto.topic),
      reason: conflicto.declared_conflict
        ? 'declared_preference_conflict'
        : 'learned_signals_conflict',
      confidence: Number(conflicto.confidence || 0),
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
    };
  }

  return {
    kind: 'open_profile',
    topic: null,
    label: null,
    reason: 'profile_with_low_recent_signal',
    confidence: 0.25,
  };
}

function construirPreguntaExploracion(zona = {}) {
  if (zona.topic) {
    const inicio = zona.kind === 'conflicting_topic'
      ? 'He recibido señales contradictorias'
      : 'Quiero confirmar una preferencia';
    return `${inicio} sobre ${zona.label}. ¿Quieres que priorice esas alertas? Responde sí o no.`;
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

module.exports = {
  TOPIC_LABELS,
  analizarRespuestaExploracion,
  construirPreguntaExploracion,
  detectarZonaIncertidumbre,
  esConversacionExploracion,
  etiquetaTema,
};
