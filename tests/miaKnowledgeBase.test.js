const {
  extraerTerminosConsultaMIA,
  extraerRegionesConsultaMIA,
  detectarTipoPreguntaMIA,
  esPreguntaDeFecha,
  extraerFechasTexto,
  puntuarAlerta,
  combinarYRankearAlertasMIA,
  construirRespuestaConAlertasMIA,
  aplicarRespuestaConocimientoADecision,
} = require('../src/mia/knowledgeBase');

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

console.log('\n=== TESTS: mia knowledge base ===\n');

const terminos = extraerTerminosConsultaMIA('Me gustaria recibir avisos sobre la PAC y ayudas para tractores');
assert(terminos.includes('pac'), 'Conserva termino PAC');
assert(terminos.includes('tractores'), 'Conserva termino tractores');
assert(!terminos.includes('gustaria'), 'Elimina palabras de baja senal');
assert(extraerRegionesConsultaMIA('Cuando sale la resolucion en Andalucia').includes('andalucia'), 'Detecta region Andalucia');

assert(esPreguntaDeFecha('Cuando sale la resolucion en Andalucia') === true, 'Detecta preguntas de fecha/resolucion');
assert(esPreguntaDeFecha('Hay ayudas para tractores?') === false, 'No marca como fecha una pregunta general');
assert(detectarTipoPreguntaMIA('Cuando llegan los pagos de las borrascas') === 'pago', 'Detecta preguntas de pago');
assert(extraerFechasTexto('El plazo termina el 15 de junio de 2026 y el 2026-07-01').length === 2, 'Extrae fechas en formatos comunes');

const alerta = {
  id: 8064,
  titulo: 'Ayudas para maquinaria agricola y tractores',
  resumen_final: 'Convocatoria dirigida a explotaciones agrarias.',
  fecha: '2026-05-22',
  url: 'https://example.com/ayudas',
};

assert(puntuarAlerta(alerta, ['tractores', 'maquinaria']) >= 8, 'Puntua alto coincidencias en titulo');

const rankingHibrido = combinarYRankearAlertasMIA({
  lexicalItems: [{
    id: 1,
    titulo: 'Curso de maquinaria agricola',
    resumen_final: 'Formacion general sobre maquinaria.',
    estado_ia: 'listo',
  }],
  semanticItems: [{
    id: 2,
    titulo: 'Convocatoria PAC para modernizacion de explotaciones',
    resumen_final: 'Ayudas relacionadas con explotaciones agrarias y tractores.',
    estado_ia: 'listo',
    similitud: 0.82,
  }],
  contexto: {
    terminos: ['pac', 'tractores'],
    regiones: [],
    tipoPregunta: 'general',
  },
  limit: 2,
});

assert(rankingHibrido[0].id === 2, 'La evidencia semantica fuerte puede liderar el ranking');
assert(rankingHibrido[0].retrieval_sources.includes('semantic'), 'Conserva fuente semantic en evidencia');
assert(rankingHibrido[0].score_breakdown.semantic_points > 0, 'Expone desglose de puntuacion semantica');

const rankingConManual = combinarYRankearAlertasMIA({
  lexicalItems: [],
  semanticItems: [{
    id: 10,
    source_type: 'manual',
    document_id: 2,
    titulo: 'Manual SIGPAC: recintos y parcelas',
    resumen: 'SIGPAC permite consultar parcelas, recintos, usos agrarios y referencias declarativas.',
    categoria: 'SIGPAC',
    fuente: 'MAPA',
    similitud: 0.84,
  }],
  contexto: {
    terminos: ['sigpac', 'parcelas'],
    regiones: [],
    tipoPregunta: 'general',
  },
  limit: 1,
});

assert(rankingConManual[0].source_type === 'manual', 'Puede rankear manuales curados como evidencia');
assert(rankingConManual[0].document_id === 2, 'Conserva document_id del manual');

const respuestaSimple = construirRespuestaConAlertasMIA({
  texto: 'Hay ayudas para tractores?',
  terminos: ['tractores', 'maquinaria'],
  items: [{ ...alerta, score: 10, matching_terms: ['tractores', 'maquinaria'], snippet: alerta.resumen_final }],
});

assert(respuestaSimple.answered === true, 'Construye respuesta con evidencias internas');
assert(respuestaSimple.needs_agent === false, 'No escala una respuesta simple con buena evidencia');
assert(respuestaSimple.reply.includes('Ayudas para maquinaria'), 'Incluye alerta relevante en la respuesta');

const respuestaConMarca = construirRespuestaConAlertasMIA({
  texto: 'Hay ayudas para tractores?',
  terminos: ['tractores', 'maquinaria'],
  items: [{ ...alerta, score: 10, matching_terms: ['tractores', 'maquinaria'], snippet: alerta.resumen_final }],
  organizationContext: { reply_sender: 'Cooperativa Los Olivos', assistant_name: 'MIA' },
});
assert(respuestaConMarca.reply.includes('base de Cooperativa Los Olivos'), 'Adapta respuesta de conocimiento al remitente organizativo');

const respuestaFecha = construirRespuestaConAlertasMIA({
  texto: 'Cuando sale la resolucion en Andalucia?',
  terminos: ['andalucia'],
  regiones: ['andalucia'],
  tipo_pregunta: 'fecha_resolucion',
  items: [{ ...alerta, score: 7, matching_terms: ['andalucia'], matching_regions: ['andalucia'], snippet: alerta.resumen_final }],
});

assert(respuestaFecha.answered === true, 'Da respuesta parcial para pregunta de fecha');
assert(respuestaFecha.needs_agent === true, 'Escala preguntas de fecha si no hay certeza');

const decision = aplicarRespuestaConocimientoADecision(
  { intent: 'pregunta_usuario', confidence: 0.4, risk_flags: [], summary: 'Pregunta' },
  respuestaSimple
);

assert(decision.reply_action.texto.includes('base de Ruralicos'), 'Inyecta respuesta apoyada en base Ruralicos');
assert(decision.risk_flags.includes('auto_answered_from_knowledge_base'), 'Marca auto respuesta con base de conocimiento');
assert(decision.knowledge_context.matches.length === 1, 'Guarda contexto de evidencias');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
