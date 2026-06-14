const {
  construirDecisionDesdeInterpretacion,
  esRespuestaCortaDeFeedbackMIA,
  esRespuestaOrigenCaptacionMIA,
  esMensajeTrivialMIA,
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
