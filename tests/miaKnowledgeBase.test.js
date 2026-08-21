const {
  extraerTerminosConsultaMIA,
  extraerRegionesConsultaMIA,
  extraerFiltroTemporalConsultaMIA,
  extraerFuentesConsultaMIA,
  detectarConsultaHistoricaAlertasMIA,
  extraerFiltrosConsultaMIA,
  detectarTipoPreguntaMIA,
  esPreguntaDeFecha,
  extraerFechasTexto,
  puntuarAlerta,
  combinarYRankearAlertasMIA,
  construirRespuestaConAlertasMIA,
  aplicarRespuestaConocimientoADecision,
} = require('../src/modules/mia/knowledgeBase');

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

const now = new Date('2026-08-21T10:00:00.000Z');
assert(
  extraerFiltroTemporalConsultaMIA('Que salio ayer sobre la PAC?', { now }).desde === '2026-08-20',
  'Convierte ayer en una fecha objetiva de Madrid'
);
assert(
  extraerFiltroTemporalConsultaMIA('Y sobre el 13?', { now }).desde === '2026-08-13',
  'Interpreta el dia del mes en una repregunta corta'
);
assert(
  extraerFiltroTemporalConsultaMIA('Ha salido algo sobre PAC hoy?\nAclaracion del usuario: Y sobre el 13?', { now }).desde === '2026-08-13',
  'La fecha de la aclaracion prevalece sobre la pregunta anterior'
);
const ultimosSieteDias = extraerFiltroTemporalConsultaMIA('Novedades de los ultimos 7 dias', { now });
assert(
  ultimosSieteDias.desde === '2026-08-15' && ultimosSieteDias.hasta === '2026-08-21',
  'Calcula un rango inclusivo para los ultimos dias'
);
const anterioresAlDigest = extraerFiltroTemporalConsultaMIA(
  'cuando salio la PAC?\nAclaracion del usuario: pero de otro dia. Buscar alertas anteriores a 2026-08-21.',
  { now }
);
assert(
  anterioresAlDigest.desde === null && anterioresAlDigest.hasta === '2026-08-20',
  'Limita otro dia a las alertas anteriores al digest actual'
);
const ultimosMeses = extraerFiltroTemporalConsultaMIA('Que ayudas estan abiertas en los ultimos meses?', { now });
assert(
  ultimosMeses.desde === '2026-05-21' && ultimosMeses.hasta === '2026-08-21',
  'Interpreta ultimos meses como una ventana sencilla de tres meses'
);
const terminosAyudas = extraerTerminosConsultaMIA('Que ayudas estan abiertas ahora mismo en los ultimos meses?');
assert(
  terminosAyudas.includes('ayudas') && !terminosAyudas.includes('estan') && !terminosAyudas.includes('abiertas'),
  'Busca por ayudas y descarta palabras operativas sin valor tematico'
);
assert(extraerFuentesConsultaMIA('Ha salido en el BOA o el BOPZ?').join(',') === 'BOA,BOPZ', 'Detecta fuentes oficiales concretas');
assert(
  extraerFuentesConsultaMIA('Que salio en el BOJA?\nAclaracion del usuario: Y en el BOA?').join(',') === 'BOA',
  'La fuente de la aclaracion prevalece sobre la busqueda anterior'
);
assert(detectarConsultaHistoricaAlertasMIA('Ha salido algo sobre la PAC?') === true, 'Detecta una consulta historica de alertas');
const filtrosHistoricos = extraerFiltrosConsultaMIA('Ha salido algo de la PAC ayer?', { now });
assert(filtrosHistoricos.alerts_only === true, 'Restringe las consultas historicas a la tabla de alertas');
assert(filtrosHistoricos.temporal.desde === '2026-08-20', 'Conserva el filtro temporal de una consulta historica');
assert(extraerTerminosConsultaMIA('Que alertas salieron el 13 de agosto de 2026?').length === 0, 'No convierte la fecha o el verbo de busqueda en filtros de texto');
assert(extraerTerminosConsultaMIA('Que ha salido en el BOJA hoy?').length === 0, 'No exige que la sigla del boletin aparezca tambien en el titulo');

assert(esPreguntaDeFecha('Cuando sale la resolucion en Andalucia') === true, 'Detecta preguntas de fecha/resolucion');
assert(esPreguntaDeFecha('Hay ayudas para tractores?') === false, 'No marca como fecha una pregunta general');
assert(detectarTipoPreguntaMIA('Cuando llegan los pagos de las borrascas') === 'pago', 'Detecta preguntas de pago');
assert(
  detectarTipoPreguntaMIA('Cuando salio la PAC?') === 'fecha_publicacion',
  'Distingue una fecha oficial ya publicada de una prediccion futura'
);
assert(
  detectarTipoPreguntaMIA('Que ayudas estan abiertas ahora mismo?') === 'plazo',
  'Trata la vigencia de ayudas como una consulta sensible de plazo'
);
assert(extraerFechasTexto('El plazo termina el 15 de junio de 2026 y el 2026-07-01').length === 2, 'Extrae fechas en formatos comunes');

const alerta = {
  id: 8064,
  titulo: 'Ayudas para maquinaria agricola y tractores',
  resumen_final: 'Convocatoria dirigida a explotaciones agrarias.',
  fecha: '2026-05-22',
  url: 'https://example.com/ayudas',
};

assert(puntuarAlerta(alerta, ['tractores', 'maquinaria']) >= 8, 'Puntua alto coincidencias en titulo');
assert(
  puntuarAlerta({ titulo: 'Actas previas a la ocupacion de terrenos' }, ['pac']) < 4,
  'No confunde PAC con una subcadena dentro de ocupacion'
);

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

const rankingPacVerificado = combinarYRankearAlertasMIA({
  lexicalItems: [{
    id: 3,
    titulo: 'Boletin oficial del dia',
    resumen_final: 'Publicacion agraria incluida en el boletin.',
    fecha: '2026-08-21',
    estado_ia: 'listo',
    verified_terms: ['pac'],
  }],
  semanticItems: [{
    id: 3,
    titulo: 'Boletin oficial del dia',
    resumen_final: 'Publicacion agraria incluida en el boletin.',
    fecha: '2026-08-21',
    estado_ia: 'listo',
    similitud: 0.8,
  }],
  contexto: { terminos: ['pac'], regiones: [], tipoPregunta: 'general', filtros: {} },
  limit: 1,
});
assert(rankingPacVerificado[0].matching_terms.includes('pac'), 'Conserva la coincidencia PAC verificada por busqueda de texto completo');

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

const respuestaIrrelevante = construirRespuestaConAlertasMIA({
  texto: 'Hay ayudas para comprar fertilizante en Extremadura?',
  terminos: ['ayudas', 'comprar', 'fertilizante'],
  regiones: ['extremadura'],
  items: [{
    ...alerta,
    titulo: 'Precios publicos de residencia y comedor',
    score: 12,
    matching_terms: ['ayudas'],
    matching_regions: [],
  }],
});
assert(respuestaIrrelevante.answered === false, 'No responde con una coincidencia semantica sin encaje objetivo suficiente');
assert(respuestaIrrelevante.matches.length === 0, 'No expone como evidencia una referencia descartada');

const respuestaSinResultados = construirRespuestaConAlertasMIA({
  texto: 'Que alertas salieron ayer?',
  terminos: [],
  filtros: {
    alerts_only: true,
    fuentes: [],
    temporal: { kind: 'day', desde: '2026-08-20', hasta: '2026-08-20', label: '2026-08-20' },
  },
  retrieval: { scope: 'alertas', search_completed: true },
  items: [],
});
assert(respuestaSinResultados.answered === true, 'Responde una busqueda de alertas completada aunque no haya resultados');
assert(respuestaSinResultados.needs_agent === false, 'No escala una ausencia de resultados comprobada');
assert(respuestaSinResultados.answer_source === 'alerts_search_no_results', 'Distingue una busqueda vacia de una respuesta sin evidencia');
assert(respuestaSinResultados.reply.includes('2026-08-20'), 'Explica el periodo objetivo que se busco');

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
