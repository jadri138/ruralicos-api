const {
  construirDecisionDesdeInterpretacion,
  esRespuestaCortaDeFeedbackMIA,
  esRespuestaOrigenCaptacionMIA,
  esMensajeTrivialMIA,
  interpretarValoracionGlobalDigestMIA,
  limpiarRespuestaMIA,
} = require('../src/modules/mia/decisionCore');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

console.log('\n=== TESTS: mia decision core ===\n');

assert(esMensajeTrivialMIA('gracias') === true, 'Detecta mensajes triviales');
assert(esMensajeTrivialMIA('ok gracias') === true, 'Detecta cortesias compuestas como triviales');
assert(esMensajeTrivialMIA('Muy bien, gracias') === true, 'No aprende de una cortesia natural');
assert(interpretarValoracionGlobalDigestMIA('Flojas') === -1, 'Interpreta una valoracion global negativa del digest');
assert(interpretarValoracionGlobalDigestMIA('Muy bien, gracias') === 1, 'Interpreta una valoracion global positiva del digest');
assert(interpretarValoracionGlobalDigestMIA('ok gracias') === null, 'No confunde una cortesia neutra con feedback');
assert(interpretarValoracionGlobalDigestMIA('Buenas') === null, 'No confunde un saludo con feedback positivo');
assert(esMensajeTrivialMIA('Quiero recibir avisos sobre PAC') === false, 'No marca preferencias reales como triviales');
assert(esRespuestaCortaDeFeedbackMIA('1') === true, 'Detecta voto corto numerico');
assert(esRespuestaCortaDeFeedbackMIA('+1') === true, 'Detecta voto corto positivo');
assert(esRespuestaCortaDeFeedbackMIA('ninguna') === true, 'Detecta voto corto ninguna');
assert(esMensajeTrivialMIA('1') === false, 'No marca "1" como trivial');
assert(esMensajeTrivialMIA('ninguna') === false, 'No marca "ninguna" como trivial');
assert(esRespuestaOrigenCaptacionMIA('Redes sociales') === true, 'Detecta respuesta corta de origen por redes sociales');
assert(esRespuestaOrigenCaptacionMIA('por un amigo') === true, 'Detecta respuesta corta de origen por recomendacion');
assert(esRespuestaOrigenCaptacionMIA('me interesa la alerta de redes de riego') === false, 'No confunde alertas agrarias con origen de captacion');

const decisionFeedback = construirDecisionDesdeInterpretacion({
  texto: 'me interesa la 1',
  digest: { id: 10 },
  alertasDelDigest: [{ id: 100 }],
  interpretacion: {
    feedbacks: [{ item_numero: 1, valor: 1, confianza: 'alta', razon: 'Interes explicito' }],
    memoria: [],
    requiere_respuesta: false,
    respuesta: '',
    intencion: 'feedback',
    resumen_para_log: 'Feedback positivo item 1',
  },
});

assert(decisionFeedback.intent === 'feedback_digest', 'Clasifica feedback de digest');
assert(decisionFeedback.feedback_actions.length === 1, 'Expone acciones de feedback');
assert(decisionFeedback.confidence > 0.9, 'Calcula confianza alta para feedback claro');

const decisionPreferencias = construirDecisionDesdeInterpretacion({
  texto: 'Me gustaria recibir avisos sobre la PAC y ayudas para tractores',
  digest: { id: 11 },
  alertasDelDigest: [{ id: 101 }],
  interpretacion: {
    feedbacks: [],
    memoria: [
      { tipo: 'interes_detectado', contenido: 'Le interesa la PAC', peso_inicial: 0.9 },
      { tipo: 'interes_detectado', contenido: 'Le interesan ayudas para tractores', peso_inicial: 0.9 },
    ],
    requiere_respuesta: false,
    respuesta: '',
    intencion: 'conversacion',
    resumen_para_log: 'Preferencia futura guardada sin votar digest',
  },
});

assert(decisionPreferencias.intent === 'actualizar_preferencias', 'Clasifica preferencias futuras separadas del feedback');
assert(decisionPreferencias.feedback_actions.length === 0, 'Preferencias futuras no crean acciones de feedback');
assert(decisionPreferencias.memory_actions.length === 2, 'Preferencias futuras crean acciones de memoria');

const decisionPreguntaContaminada = construirDecisionDesdeInterpretacion({
  texto: 'Que ayudas incluye la solicitud unica PAC 2026?',
  digest: null,
  alertasDelDigest: [],
  interpretacion: {
    feedbacks: [],
    memoria: [{ tipo: 'interes_detectado', contenido: 'Le interesa la gestion del agua', peso_inicial: 0.8 }],
    requiere_respuesta: true,
    respuesta: 'Lo reviso.',
    intencion: 'conversacion',
    resumen_para_log: 'Preferencia detectada por IA',
  },
});
assert(decisionPreguntaContaminada.intent === 'pregunta_usuario', 'Una pregunta prevalece sobre una preferencia inferida');
assert(decisionPreguntaContaminada.memory_actions.length === 0, 'Descarta memoria no demostrada en una pregunta');
assert(
  decisionPreguntaContaminada.risk_flags.includes('memory_actions_dropped_unverified'),
  'Audita el descarte de memoria no demostrada'
);

const decisionComentarioContaminado = construirDecisionDesdeInterpretacion({
  texto: 'Flojas',
  digest: null,
  alertasDelDigest: [],
  interpretacion: {
    feedbacks: [],
    memoria: [{ tipo: 'interes_detectado', contenido: 'Le interesa la gestion del agua', peso_inicial: 0.8 }],
    requiere_respuesta: false,
    respuesta: '',
    intencion: 'conversacion',
    resumen_para_log: 'Preferencia detectada por IA',
  },
});
assert(decisionComentarioContaminado.intent !== 'actualizar_preferencias', 'Un comentario ambiguo no actualiza preferencias');
assert(decisionComentarioContaminado.memory_actions.length === 0, 'Un comentario ambiguo no guarda memoria tematica');

const decisionPreferenciaCondicional = construirDecisionDesdeInterpretacion({
  texto: 'Formacion solo me interesa del Gobierno de Aragon o del Ministerio de Agricultura',
  digest: null,
  alertasDelDigest: [],
  interpretacion: {
    feedbacks: [],
    memoria: [{
      tipo: 'interes_detectado',
      contenido: 'Solo quiere formacion del Gobierno de Aragon o del Ministerio de Agricultura',
      peso_inicial: 0.9,
    }],
    requiere_respuesta: false,
    respuesta: '',
    intencion: 'conversacion',
    resumen_para_log: 'Preferencia de fuentes de formacion',
  },
});
assert(decisionPreferenciaCondicional.intent === 'actualizar_preferencias', 'Conserva una preferencia condicional explicita');
assert(decisionPreferenciaCondicional.memory_actions.length === 1, 'Guarda el matiz declarado por el usuario');

const decisionSinDigest = construirDecisionDesdeInterpretacion({
  texto: 'me interesa la 1',
  digest: null,
  alertasDelDigest: [],
  interpretacion: {
    feedbacks: [{ item_numero: 1, valor: 1, confianza: 'alta', razon: 'Interes explicito' }],
    memoria: [],
    requiere_respuesta: false,
    respuesta: '',
    intencion: 'feedback',
    resumen_para_log: 'Feedback positivo item 1',
  },
});

assert(decisionSinDigest.intent !== 'feedback_digest', 'No acepta feedback sin digest valido');
assert(decisionSinDigest.feedback_actions.length === 0, 'No expone acciones de feedback sin digest valido');
assert(decisionSinDigest.risk_flags.includes('digest_missing'), 'Marca riesgo cuando falta digest');
assert(
  decisionSinDigest.risk_flags.includes('feedback_without_valid_digest_context'),
  'Marca riesgo si hay feedback sin contexto de digest'
);
assert(
  decisionSinDigest.risk_flags.includes('feedback_actions_dropped'),
  'Descarta acciones de feedback no ejecutables'
);

const decisionItemInvalido = construirDecisionDesdeInterpretacion({
  texto: 'me interesa la 3',
  digest: { id: 12 },
  alertasDelDigest: [{ id: 102 }],
  interpretacion: {
    feedbacks: [{ item_numero: 3, valor: 1, confianza: 'alta', razon: 'Item fuera de rango' }],
    memoria: [],
    requiere_respuesta: false,
    respuesta: '',
    intencion: 'feedback',
    resumen_para_log: 'Feedback item inexistente',
  },
});
assert(decisionItemInvalido.feedback_actions.length === 0, 'Descarta feedback fuera de rango');
assert(decisionItemInvalido.risk_flags.includes('feedback_actions_dropped'), 'Marca descarte por item fuera de rango');

const decisionBajaConfianza = construirDecisionDesdeInterpretacion({
  texto: 'igual la primera',
  digest: { id: 13 },
  alertasDelDigest: [{ id: 103 }],
  interpretacion: {
    feedbacks: [{ item_numero: 1, valor: 1, confianza: 'baja', razon: 'Ambiguo' }],
    memoria: [],
    requiere_respuesta: false,
    respuesta: '',
    intencion: 'feedback',
    resumen_para_log: 'Feedback ambiguo',
  },
});
assert(decisionBajaConfianza.feedback_actions.length === 0, 'No ejecuta feedback de baja confianza');
assert(decisionBajaConfianza.risk_flags.includes('low_confidence_feedback'), 'Marca feedback de baja confianza');

const respuestaLimpia = limpiarRespuestaMIA(
  'Hola Jaime Marquez Camara,\nLo tengo en cuenta para proximas alertas.\nQue tengas buen dia en tu granja con tus vacas.'
);
assert(!respuestaLimpia.includes('Jaime Marquez'), 'Elimina saludo con nombre completo');
assert(!respuestaLimpia.toLowerCase().includes('granja'), 'Elimina despedidas raras');
assert(respuestaLimpia.includes('Lo tengo en cuenta'), 'Conserva la respuesta util');

const decisionConRespuestaRara = construirDecisionDesdeInterpretacion({
  texto: 'cuando sale la resolucion',
  digest: { id: 12 },
  alertasDelDigest: [{ id: 102 }],
  interpretacion: {
    feedbacks: [],
    memoria: [{ tipo: 'pregunta_usuario', contenido: 'Pregunta por resolucion', peso_inicial: 0.7 }],
    requiere_respuesta: true,
    respuesta: 'Hola Jose Luis,\nLo reviso y te aviso cuando haya una fecha clara.\nQue tengas buen dia en tu campo.',
    intencion: 'pregunta',
    resumen_para_log: 'Pregunta con respuesta',
  },
});
assert(decisionConRespuestaRara.reply_action.texto === 'Lo reviso y te aviso cuando haya una fecha clara.', 'Sanitiza reply_action');
assert(decisionConRespuestaRara.risk_flags.includes('reply_sanitized'), 'Marca que limpio la respuesta');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
