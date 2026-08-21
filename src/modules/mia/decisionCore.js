const { interpretarMensaje } = require('../aprendizaje/cerebro');
const { generarRespuestaAlertaDigestMIA } = require('./groundedAnswer');
const {
  analizarControlExploracion,
  analizarRespuestaExploracion,
} = require('./exploration');

const DECISION_VERSION = 'mia_decision_v2';

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
  const trivial = limpio.replace(/[,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(hola|buen[ao]s(?: dias| tardes| noches)?|ok|vale|gracias|muchas gracias|si|no|bien(?: gracias)?|correcto|esta bien|me gusta|perfecto|recibido|ok gracias|vale gracias|perfecto gracias|muy bien(?: gracias)?|de acuerdo(?: gracias)?)[\s.!?]*$/.test(trivial);
}

function parecePreguntaMIA(texto) {
  const limpio = normalizarTexto(texto);
  if (!limpio) return false;
  return /[?¿]/.test(String(texto || '')) ||
    /\b(cuando|donde|como|que|cual|cuanto|por que|sabes|sabeis|puedes|podrias|me puedes|hay|existe|sale|pagan|ingresan|plazo|resolucion|explicame|explicar|explica|cuentame)\b/.test(limpio);
}

function parecePreferenciaExplicitaMIA(texto) {
  const limpio = normalizarTexto(texto);
  if (!limpio) return false;
  const futura = (
    /\b(me gustaria|quisiera|quiero|me interesaria|mandadme|enviadme|avisadme|avisame|avisenme|recibir)\b[^.!?]{0,100}\b(avisos?|alertas?|notificaciones?|mensajes?|informacion)\b/.test(limpio) ||
    /\b(avisos?|alertas?|notificaciones?|mensajes?|informacion)\b[^.!?]{0,100}\b(sobre|de|del|para)\b/.test(limpio) ||
    /\b(me gusta|prefiero|valoro)\s+que\s+me\s+(?:informes?|avises?|mandes?|envies?)\b/.test(limpio)
  );
  const exclusion = /\b(no me interesa|no quiero|no me envies|no me mandeis|dejad de|evitar)\b/.test(limpio);
  const condicion = /\b(solo|solamente|unicamente)\s+(?:me\s+)?interesa\b|\bme interesa\s+(?:solo|solamente|unicamente)\b/.test(limpio);
  return futura || exclusion || condicion;
}

function interpretarValoracionGlobalDigestMIA(texto, { totalItems = null } = {}) {
  const limpio = normalizarTexto(texto)
    .replace(/[.,;:!?¿¡]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(muy bien(?: gracias)?|interesantes?|utiles?|genial)$/.test(limpio)) return 1;
  if (/^(flojas?|mal|poco utiles?|no me sirven|ninguna me sirve)$/.test(limpio)) return -1;
  if (Number(totalItems) === 1 && /^(bien(?: gracias)?|correcto|esta bien|me gusta)$/.test(limpio)) return 1;
  if (Number(totalItems) === 1 && /^(no me gusta|no me interesa|esto no me interesa|incorrecto)$/.test(limpio)) return -1;
  return null;
}

function esSolicitudExplicacionDigestMIA(texto) {
  const limpio = normalizarTexto(texto)
    .replace(/[.,;:!?¿¡]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpio || limpio.split(/\s+/).length > 14) return false;

  return /\b(explicame|explicalo|me explicas|puedes explicarme|puedes explicarlo|podrias explicarme|podrias explicarlo|de que va|de que trata|que significa (?:esto|esta alerta|este mensaje)|que es esto|cuentame mas|dame mas informacion)\b/.test(limpio);
}

function extraerResumenVisibleAlertaDigestMIA(alerta = {}) {
  const resumenFinal = String(alerta.resumen_final || '').trim();
  const resumenDigest = resumenFinal.match(/(?:^|\n)\s*RESUMEN_DIGEST:\s*([^\n]+)/i)?.[1] || '';
  const candidato = resumenDigest || (
    /(?:^|\n)\s*FICHA_IA\s*(?:\n|$)/i.test(resumenFinal)
      ? String(alerta.resumen || '')
      : resumenFinal
  ) || String(alerta.resumen || '');
  const limpio = String(candidato).replace(/\s+/g, ' ').trim();
  return normalizarTexto(limpio) === 'no_detectado' ? '' : limpio;
}

function construirRespuestaExplicacionDigestMIA(alerta = {}) {
  const titulo = String(alerta.titulo || '').replace(/\s+/g, ' ').trim();
  const resumen = extraerResumenVisibleAlertaDigestMIA(alerta);
  if (!titulo && !resumen) return '';
  if (!titulo) return resumen;
  if (!resumen || normalizarTexto(resumen) === normalizarTexto(titulo)) {
    return `Esta alerta trata sobre: ${titulo}`;
  }
  return `Esta alerta trata sobre: ${titulo}\n\n${resumen}`;
}

function construirRespuestaListadoDigestMIA(alertas = [], introduccion = 'Hoy te envie estas alertas:') {
  const alertasDigest = Array.isArray(alertas) ? alertas : [];
  const maxDetalle = Math.max(60, Math.min(240, Math.floor(620 / Math.max(1, alertasDigest.length))));
  const lineas = alertasDigest.map((alerta, index) => {
    const titulo = String(alerta?.titulo || '').replace(/\s+/g, ' ').trim();
    const resumen = extraerResumenVisibleAlertaDigestMIA(alerta);
    const detalle = resumen && normalizarTexto(resumen) !== normalizarTexto(titulo)
      ? `${titulo || 'Alerta'}: ${resumen}`
      : (titulo || resumen || 'Alerta sin detalle');
    return `${index + 1}. ${detalle.slice(0, maxDetalle)}`;
  });
  return `${introduccion}\n${lineas.join('\n')}\n\nDime el numero o el tema si quieres que amplie una.`;
}

const TERMINOS_GENERICOS_REFERENCIA_DIGEST = new Set([
  'alerta', 'aviso', 'anuncio', 'publicacion', 'mensaje', 'digest', 'resumen',
  'este', 'esta', 'esto', 'ese', 'esa', 'hoy', 'ayer', 'mandado', 'mandaste',
  'enviado', 'enviaste', 'recibido', 'explica', 'explicame', 'dime', 'saber',
  'trata', 'informacion', 'quiero', 'puedes', 'podrias', 'sobre', 'para', 'como',
  'cuando', 'donde', 'cual', 'cuanto', 'porque', 'tiene', 'hacer', 'hecho',
]);

function normalizarTokenDigest(token) {
  let limpio = normalizarTexto(token).replace(/[^a-z0-9]/g, '');
  if (limpio.length > 6 && limpio.endsWith('es')) limpio = limpio.slice(0, -2);
  else if (limpio.length > 5 && limpio.endsWith('s')) limpio = limpio.slice(0, -1);
  return limpio;
}

function tokenizarReferenciaDigest(texto) {
  return [...new Set(normalizarTexto(texto)
    .split(/[^a-z0-9]+/)
    .map(normalizarTokenDigest)
    .filter((token) => token.length >= 4 && !TERMINOS_GENERICOS_REFERENCIA_DIGEST.has(token)))];
}

function extraerItemExplicitoDigestMIA(texto, totalItems) {
  const limpio = normalizarTexto(texto).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const numero = limpio.match(/^(?:el|la)?\s*(\d{1,2})$/)?.[1]
    || limpio.match(/\b(?:alerta|aviso|item|numero)\s*(\d{1,2})\b/)?.[1];
  const indice = Number(numero);
  if (Number.isInteger(indice) && indice >= 1 && indice <= totalItems) return indice - 1;

  const ordinales = [
    ['primer', 'primero', 'primera'],
    ['segundo', 'segunda'],
    ['tercero', 'tercera'],
    ['cuarto', 'cuarta'],
    ['quinto', 'quinta'],
  ];
  const ordinalIndex = ordinales.findIndex((grupo) => grupo.some((ordinal) => (
    new RegExp(`\\b${ordinal}\\b`).test(limpio)
  )));
  return ordinalIndex >= 0 && ordinalIndex < totalItems ? ordinalIndex : null;
}

function buscarAlertaReferenciadaDigestMIA(texto, alertas = []) {
  const alertasDigest = Array.isArray(alertas) ? alertas : [];
  const indiceExplicito = extraerItemExplicitoDigestMIA(texto, alertasDigest.length);
  if (indiceExplicito !== null) return { index: indiceExplicito, reason: 'explicit_item' };

  const tokensConsulta = tokenizarReferenciaDigest(texto);
  if (tokensConsulta.length === 0) return null;
  const tokensAlertas = alertasDigest.map((alerta) => new Set(tokenizarReferenciaDigest([
    alerta?.titulo,
    extraerResumenVisibleAlertaDigestMIA(alerta),
    ...(alerta?.sectores || []),
    ...(alerta?.subsectores || []),
    ...(alerta?.tipos_alerta || []),
  ].filter(Boolean).join(' '))));
  const frecuencia = new Map(tokensConsulta.map((token) => [
    token,
    tokensAlertas.filter((tokens) => tokens.has(token)).length,
  ]));
  const scores = tokensAlertas.map((tokens) => tokensConsulta.reduce((score, token) => (
    score + (frecuencia.get(token) === 1 && tokens.has(token) ? 1 : 0)
  ), 0));
  const mejorScore = Math.max(0, ...scores);
  if (mejorScore === 0 || scores.filter((score) => score === mejorScore).length !== 1) return null;
  return { index: scores.indexOf(mejorScore), reason: 'unique_terms', score: mejorScore };
}

function pareceFeedbackSobreDigestMIA(texto) {
  const limpio = normalizarTexto(texto);
  return /\b(me interesa|no me interesa|me gusta|no me gusta|ninguna|ninguno|ambas|todos|todas)\b/.test(limpio)
    || /^[+-]?\s*\d{1,2}\s*[+-]?$/.test(limpio);
}

function esReferenciaAlDigestMIA(texto, contextoReciente = []) {
  if (pareceFeedbackSobreDigestMIA(texto)) return false;
  if (esSolicitudExplicacionDigestMIA(texto)) return true;

  const limpio = normalizarTexto(texto);
  const mencionaContenido = /\b(alerta|alertas|aviso|avisos|anuncio|anuncios|mensaje|digest|resumen|curso|ayuda|publicacion)\b/.test(limpio);
  const mencionaEnvio = /\b(hoy|ayer|mandado|mandaste|mandasteis|enviado|enviaste|enviasteis|recibido|primero|primera|segundo|segunda|tercero|tercera|este|esta|ese|esa)\b/.test(limpio);
  if (mencionaContenido && mencionaEnvio) return true;

  const ultimaRespuesta = (Array.isArray(contextoReciente) ? contextoReciente : [])
    .filter((item) => item?.direccion === 'ruralicos' && String(item.texto || '').trim())
    .at(-1);
  const answerSource = String(ultimaRespuesta?.answer_source || '');
  if (answerSource && !answerSource.startsWith('digest_context')) return false;
  const esperabaEleccion = /\b(te refieres|dime el numero|dime el tema|cual de|alerta|curso|ayuda)\b/.test(
    normalizarTexto(ultimaRespuesta?.texto)
  );
  return esperabaEleccion && /^(?:el|la)\s+de\b|^(?:ese|esa|este|esta)\b/.test(limpio);
}

function construirDecisionContextoDigestMIA({
  digest,
  alertas,
  respuesta,
  answerSource,
  answerGuardrails = [],
  answerError = null,
  answered,
  matches,
  summary,
}) {
  const riskFlags = answered ? ['answered_from_digest_context'] : [];
  if (answerSource === 'digest_context_ai') riskFlags.push('answered_by_llm_from_digest_alert');
  if (answerError) riskFlags.push('digest_answer_ai_failed');
  const decision = normalizarDecision({
    intent: 'pregunta_usuario',
    confidence: answered ? 0.99 : 0.9,
    reply_action: { canal: 'whatsapp', texto: respuesta },
    risk_flags: riskFlags,
    summary,
    legacy_interpretacion: {
      feedbacks: [],
      memoria: [],
      requiere_respuesta: true,
      respuesta,
      intencion: 'pregunta',
      resumen_para_log: summary,
    },
  });
  return aplicarContratoAcciones({
    ...decision,
    knowledge_context: {
      handled: true,
      answered,
      needs_agent: false,
      evidence_level: 'alta',
      tipo_pregunta: answered ? 'explicacion_digest' : 'aclaracion_digest',
      answer_source: answerSource,
      answer_guardrails: answerGuardrails,
      answer_error: answerError,
      digest_id: digest?.id || null,
      matches: (matches || []).map((alerta) => ({
        id: alerta?.id || null,
        titulo: alerta?.titulo || null,
      })),
    },
  }, { digest, alertasDelDigest: alertas });
}

function buscarAlertaFocoConversacionMIA(contextoReciente = [], alertas = []) {
  const porId = new Map((Array.isArray(alertas) ? alertas : []).map((alerta) => [Number(alerta?.id), alerta]));
  for (const mensaje of (Array.isArray(contextoReciente) ? contextoReciente : []).slice().reverse()) {
    const ids = [...new Set((Array.isArray(mensaje?.alerta_ids) ? mensaje.alerta_ids : [])
      .map(Number)
      .filter((id) => porId.has(id)))];
    if (ids.length === 1) return porId.get(ids[0]);
  }
  return null;
}

function debeBuscarFueraDelDigestMIA({ texto, contextoReciente = [], alertas = [] } = {}) {
  const limpio = normalizarTexto(texto).replace(/\s+/g, ' ').trim();
  if (!limpio || pareceFeedbackSobreDigestMIA(limpio)) return false;

  if (/\b(quitando|sin contar|aparte de|ademas de)\b[^.!?]{0,60}\b(esta|esa|la)\s+(alerta|ayuda|publicacion|curso)\b/.test(limpio)) {
    return true;
  }

  const cambiaPeriodo = (
    /\b(?:de\s+)?otros?\s+dias?\b/.test(limpio) ||
    /\bultim(?:o|os|a|as)\s+(?:\d{1,2}\s+)?(?:dias?|semanas?|meses?)\b/.test(limpio) ||
    /\b(?:dias?|semanas?|meses?)\s+anteriores\b|\bhistorico\b/.test(limpio)
  );
  if (cambiaPeriodo) return true;

  const referenciaFocoExplicita = (
    /\b(esta|esa)\s+(alerta|ayuda|publicacion)\b/.test(limpio) ||
    /\b(este|ese)\s+(curso|anuncio|aviso|mensaje)\b/.test(limpio) ||
    /\b(alerta|curso|anuncio|aviso|mensaje)\s+(?:de hoy|que me (?:has )?(?:mandado|enviado))\b/.test(limpio)
  );
  if (referenciaFocoExplicita) return false;

  const consultaGlobalExplicita = (
    /\b(ha salido algo|han salido|que ha salido|que ayudas? (?:hay|estan)|hay (?:alguna|otras?) ayudas?|novedades|buscar? en (?:las )?alertas)\b/.test(limpio) ||
    /\b(ayudas?|subvenciones?)\b[^.!?]{0,60}\b(abiertas?|disponibles?|vigentes?|puedo pedir|pueda pedir)\b/.test(limpio)
  );
  if (consultaGlobalExplicita) return true;

  const consultaHistorica = /\b(cuando salio|cuando se publico|salio|salieron|publicado|publicaron)\b/.test(limpio);
  if (!consultaHistorica) return false;

  const alertaFoco = buscarAlertaFocoConversacionMIA(contextoReciente, alertas);
  if (!alertaFoco) return true;
  const temasConsulta = tokenizarReferenciaDigest(limpio);
  if (temasConsulta.length === 0) return false;
  return !buscarAlertaReferenciadaDigestMIA(limpio, [alertaFoco]);
}

function esSeguimientoAlertaFocalMIA(texto, alertaFoco) {
  if (!alertaFoco || pareceFeedbackSobreDigestMIA(texto)) return false;
  if (parecePreguntaMIA(texto)) return true;
  const limpio = normalizarTexto(texto);
  return /\b(precio|cuesta|plazo|fecha|requisitos|solicitud|inscripcion|apuntar|apuntarme|plazas|duracion|horario|lugar|telefono|correo|obligatorio|certificado|carne|temario)\b/.test(limpio);
}

async function resolverConsultaDesdeDigestMIA({
  texto,
  digest,
  alertas = [],
  contextoReciente = [],
  usuario = null,
  organizationContext = null,
  responderAlertaFn = generarRespuestaAlertaDigestMIA,
}) {
  const alertasDigest = Array.isArray(alertas) ? alertas : [];
  if (!digest || alertasDigest.length === 0 || pareceFeedbackSobreDigestMIA(texto)) return null;

  if (debeBuscarFueraDelDigestMIA({ texto, contextoReciente, alertas: alertasDigest })) return null;

  const explicacion = esSolicitudExplicacionDigestMIA(texto);
  const referencia = esReferenciaAlDigestMIA(texto, contextoReciente);
  const alertaFoco = buscarAlertaFocoConversacionMIA(contextoReciente, alertasDigest);
  const seguimientoFocal = esSeguimientoAlertaFocalMIA(texto, alertaFoco);
  if (!explicacion && !referencia && !seguimientoFocal) return null;

  const coincidencia = buscarAlertaReferenciadaDigestMIA(texto, alertasDigest);
  const alertaSeleccionada = coincidencia
    ? alertasDigest[coincidencia.index]
    : (seguimientoFocal || (explicacion && alertaFoco) ? alertaFoco : null);
  if (alertaSeleccionada) {
    let generada = null;
    try {
      generada = await responderAlertaFn({
        texto,
        alerta: alertaSeleccionada,
        digest,
        contextoReciente,
        usuario,
        organizationContext,
      });
    } catch (error) {
      generada = { answer_error: error.message };
    }
    const respuesta = generada?.reply || construirRespuestaExplicacionDigestMIA(alertaSeleccionada);
    if (!respuesta) return null;
    return construirDecisionContextoDigestMIA({
      digest,
      alertas: alertasDigest,
      respuesta,
      answerSource: generada?.answer_source || 'digest_context',
      answerGuardrails: generada?.answer_guardrails || ['exact_digest_alert', 'deterministic_fallback'],
      answerError: generada?.answer_error || null,
      answered: true,
      matches: [alertaSeleccionada],
      summary: generada?.answer_source === 'digest_context_ai'
        ? 'Pregunta resuelta por MIA desde el contenido oficial de una alerta concreta del digest.'
        : 'Pregunta resuelta desde una alerta concreta del digest.',
    });
  }

  if (explicacion) {
    const respuesta = alertasDigest.length === 1
      ? construirRespuestaExplicacionDigestMIA(alertasDigest[0])
      : construirRespuestaListadoDigestMIA(alertasDigest);
    if (!respuesta) return null;
    return construirDecisionContextoDigestMIA({
      digest,
      alertas: alertasDigest,
      respuesta,
      answerSource: 'digest_context',
      answered: true,
      matches: alertasDigest,
      summary: 'Pregunta general resuelta con el contenido completo del digest.',
    });
  }

  if (alertasDigest.length === 1) {
    const respuesta = construirRespuestaExplicacionDigestMIA(alertasDigest[0]);
    if (!respuesta) return null;
    return construirDecisionContextoDigestMIA({
      digest,
      alertas: alertasDigest,
      respuesta,
      answerSource: 'digest_context',
      answered: true,
      matches: alertasDigest,
      summary: 'Referencia al unico item resuelta desde el digest.',
    });
  }

  const respuesta = construirRespuestaListadoDigestMIA(
    alertasDigest,
    'No se a cual de las alertas te refieres:'
  );
  return construirDecisionContextoDigestMIA({
    digest,
    alertas: alertasDigest,
    respuesta,
    answerSource: 'digest_context_clarification',
    answered: false,
    matches: alertasDigest,
    summary: 'Referencia ambigua al digest; se pide elegir alerta.',
  });
}

function memoriaDemostradaPorMensaje(memory = {}, texto = '') {
  const tipo = String(memory.tipo || '');
  const limpio = normalizarTexto(texto);
  if (['interes_detectado', 'desinteres_detectado', 'evento_estacional'].includes(tipo)) {
    return parecePreferenciaExplicitaMIA(limpio);
  }
  if (tipo === 'dato_explotacion') {
    return /\b(soy|tengo|gestiono|cultivo|crio|mi explotacion|mis parcelas?|mi finca)\b/.test(limpio);
  }
  return !['pregunta_usuario', 'mensaje_libre'].includes(tipo);
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

function esRespuestaOrigenCaptacionMIA(texto) {
  const limpio = normalizarTexto(texto)
    .replace(/[¿?¡!.,;:()[\]{}"'`*_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!limpio) return false;
  const palabras = limpio.split(/\s+/).filter(Boolean);
  if (palabras.length > 8 || limpio.length > 80) return false;

  const patrones = [
    /^(por\s+)?(las?\s+)?red(es)?\s+social(es)?$/,
    /^(por\s+)?(instagram|facebook|tiktok|tik tok|twitter|linkedin|youtube|google|internet|buscador|web|pagina web)$/,
    /^(por\s+)?(anuncio|publicidad|radio|prensa|periodico|revista)$/,
    /^(por\s+)?(un\s+|una\s+)?(amigo|amiga|conocido|conocida|familiar|cliente|vecino|vecina|companero|companera)$/,
    /^(por\s+)?(recomendacion|boca a boca|cooperativa|asociacion|sindicato|feria|evento|jornada|charla)$/,
    /^(me\s+)?(lo\s+)?(dijo|recomendo|paso)\s+(un\s+|una\s+)?(amigo|amiga|conocido|conocida|familiar|cliente|vecino|vecina|companero|companera)$/,
    /^(os|te)\s+(vi|he visto|conoci|conoci)\s+en\s+(redes|instagram|facebook|google|internet)$/,
  ];

  return patrones.some((patron) => patron.test(limpio));
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

  if (parecePreguntaMIA(texto) && !parecePreferenciaExplicitaMIA(texto)) {
    return 'pregunta_usuario';
  }

  if (
    parecePreferenciaExplicitaMIA(texto) &&
    memorias.some((m) => ['interes_detectado', 'desinteres_detectado', 'dato_explotacion', 'evento_estacional'].includes(m.tipo))
  ) {
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
  const puedeAprenderDelDigest = intent === 'feedback_digest';
  const memoriasVerificadas = (interpretacion.memoria || []).filter((memoria) => (
    puedeAprenderDelDigest || memoriaDemostradaPorMensaje(memoria, texto)
  ));
  if (memoriasVerificadas.length < (interpretacion.memoria || []).length) {
    riskFlags.push('memory_actions_dropped_unverified');
  }

  const decision = normalizarDecision({
    intent,
    confidence,
    feedback_actions: (interpretacion.feedbacks || []).map((feedback) => ({
      item_numero: Number(feedback.item_numero),
      valor: Number(feedback.valor),
      confianza: feedback.confianza || 'media',
      razon: feedback.razon || '',
    })),
    memory_actions: memoriasVerificadas.map((memoria) => ({
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

async function decidirMensajeMIA({
  mensajeUsuario,
  usuario,
  conversacionActiva,
  digest,
  alertasDelDigest,
  contextoReciente = [],
}) {
  const controlExploracion = analizarControlExploracion(mensajeUsuario, conversacionActiva);
  if (controlExploracion) {
    const memoria = {
      tipo: 'mensaje_libre',
      contenido: controlExploracion.content,
      peso_inicial: 1,
    };
    return aplicarContratoAcciones(normalizarDecision({
      intent: 'actualizar_preferencias',
      confidence: 0.99,
      memory_actions: [memoria],
      reply_action: { canal: 'whatsapp', texto: controlExploracion.reply },
      summary: `Control de preguntas automáticas: ${controlExploracion.action}.`,
      legacy_interpretacion: {
        feedbacks: [],
        memoria: [memoria],
        requiere_respuesta: true,
        respuesta: controlExploracion.reply,
        intencion: 'preferencia',
        resumen_para_log: `Control de exploración ${controlExploracion.action}`,
      },
    }), { digest, alertasDelDigest });
  }

  const respuestaExploracion = analizarRespuestaExploracion(mensajeUsuario, conversacionActiva);
  if (respuestaExploracion) {
    const memoria = {
      tipo: respuestaExploracion.memory_type,
      contenido: respuestaExploracion.content,
      peso_inicial: 0.95,
    };
    const respuesta = 'Entendido. Lo tendré en cuenta en las próximas alertas.';
    return aplicarContratoAcciones(normalizarDecision({
      intent: 'actualizar_preferencias',
      confidence: 0.99,
      memory_actions: [memoria],
      reply_action: { canal: 'whatsapp', texto: respuesta },
      summary: `Preferencia confirmada: ${respuestaExploracion.topic} (${respuestaExploracion.polarity}).`,
      legacy_interpretacion: {
        feedbacks: [],
        memoria: [memoria],
        requiere_respuesta: true,
        respuesta,
        intencion: 'preferencia',
        resumen_para_log: `Respuesta de exploración sobre ${respuestaExploracion.topic}`,
      },
    }), { digest, alertasDelDigest });
  }

  const alertasDigest = Array.isArray(alertasDelDigest) ? alertasDelDigest : [];
  const valoracionGlobal = digest && alertasDigest.length > 0
    ? interpretarValoracionGlobalDigestMIA(mensajeUsuario, { totalItems: alertasDigest.length })
    : null;
  if (valoracionGlobal !== null) {
    const feedbackActions = alertasDigest.map((_alerta, index) => ({
      item_numero: index + 1,
      valor: valoracionGlobal,
      confianza: 'media',
      razon: valoracionGlobal > 0
        ? 'Valoracion positiva global del resumen de alertas'
        : 'Valoracion negativa global del resumen de alertas',
    }));
    return aplicarContratoAcciones(normalizarDecision({
      intent: 'feedback_digest',
      confidence: 0.85,
      feedback_actions: feedbackActions,
      memory_actions: [],
      reply_action: null,
      summary: `Valoracion global ${valoracionGlobal > 0 ? 'positiva' : 'negativa'} del digest.`,
      legacy_interpretacion: {
        feedbacks: feedbackActions,
        memoria: [],
        requiere_respuesta: false,
        respuesta: '',
        intencion: 'feedback',
        resumen_para_log: 'Valoracion global interpretada localmente',
      },
    }), { digest, alertasDelDigest: alertasDigest });
  }

  if (esRespuestaOrigenCaptacionMIA(mensajeUsuario)) {
    return normalizarDecision({
      intent: 'mensaje_libre',
      confidence: 0.98,
      summary: 'Respuesta a pregunta de origen/captacion sin acciones MIA.',
      legacy_interpretacion: {
        feedbacks: [],
        memoria: [],
        requiere_respuesta: false,
        respuesta: '',
        intencion: 'otro',
        resumen_para_log: 'Respuesta de origen/captacion ignorada',
      },
    });
  }

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

  if (parecePreguntaMIA(mensajeUsuario) && !parecePreferenciaExplicitaMIA(mensajeUsuario)) {
    return normalizarDecision({
      intent: 'pregunta_usuario',
      confidence: 0.95,
      reply_action: null,
      summary: 'Pregunta preparada para el agente conversacional con herramientas.',
      legacy_interpretacion: {
        feedbacks: [],
        memoria: [],
        requiere_respuesta: false,
        respuesta: '',
        intencion: 'pregunta',
        resumen_para_log: 'Pregunta derivada al agente conversacional con herramientas',
      },
    });
  }

  const interpretacion = await interpretarMensaje({
    mensajeUsuario,
    usuario,
    conversacionActiva,
    alertasDelDigest,
    contextoReciente,
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
  esRespuestaOrigenCaptacionMIA,
  parecePreguntaMIA,
  parecePreferenciaExplicitaMIA,
  interpretarValoracionGlobalDigestMIA,
  esSolicitudExplicacionDigestMIA,
  extraerResumenVisibleAlertaDigestMIA,
  construirRespuestaExplicacionDigestMIA,
  construirRespuestaListadoDigestMIA,
  buscarAlertaReferenciadaDigestMIA,
  esReferenciaAlDigestMIA,
  debeBuscarFueraDelDigestMIA,
  resolverConsultaDesdeDigestMIA,
};
