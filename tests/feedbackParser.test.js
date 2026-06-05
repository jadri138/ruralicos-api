const {
  parsearVotosDigest,
  esComentarioTramiteOEspera,
  extraerMencionesPosNeg,
  parsearVotosNaturalesPorAlertas,
} = require('../src/brain/feedbackParser');
const { __testing: cerebroTesting } = require('../src/utils/cerebro');

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

function sameArray(a, b) {
  return Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((v, i) => v === b[i]);
}

console.log('\n=== TESTS: feedbackParser ===\n');

const votos1 = parsearVotosDigest('+1');
assert(votos1.length === 1 && votos1[0].item === 1 && votos1[0].valor === 1, 'Detecta +1 como voto positivo para item 1');

const votos2 = parsearVotosDigest('quitar 5');
assert(votos2.length === 1 && votos2[0].item === 5 && votos2[0].valor === -1, 'Detecta "quitar 5" como voto negativo');

const votos3 = parsearVotosDigest('Me interesa 2 y 3');
assert(votos3.length === 2 && votos3.some(v => v.item === 2 && v.valor === 1) && votos3.some(v => v.item === 3 && v.valor === 1), 'Detecta numeros positivos tras "me interesa"');

const votos4 = parsearVotosDigest('1,2,3');
assert(votos4.length === 3 && votos4.every(v => v.valor === 1), 'Detecta lista de numeros sin signo como positivos');

const votos5 = parsearVotosDigest('ambas', 2);
assert(votos5.length === 2 && votos5.every(v => v.valor === 1), 'Detecta "ambas" como positivo para todos los items');

const votos6 = parsearVotosDigest('ninguna', 2);
assert(votos6.length === 2 && votos6.every(v => v.valor === -1), 'Detecta "ninguna" como negativo para todos los items');

const votos7 = parsearVotosDigest('12', 2);
assert(votos7.length === 2 && votos7.every(v => v.valor === 1), 'Detecta "12" como items 1 y 2');

const menciones1 = extraerMencionesPosNeg('Me interesa el olivar de Castellon pero no el porcino');
assert(
  sameArray(menciones1.positivas.sort(), ['castellon', 'olivar'].sort()) && sameArray(menciones1.negativas, ['porcino']),
  'Extrae menciones positivas y negativas con "no" correctamente'
);

const menciones2 = extraerMencionesPosNeg('No quiero porcino ni vacuno');
assert(
  menciones2.positivas.length === 0 && sameArray(menciones2.negativas.sort(), ['porcino', 'vacuno'].sort()),
  'Detecta menciones negativas cuando el usuario dice "no quiero"'
);

const menciones3 = extraerMencionesPosNeg('Me encanta la apicultura y el arroz');
assert(
  sameArray(menciones3.positivas.sort(), ['apicultura', 'arroz'].sort()) && menciones3.negativas.length === 0,
  'Detecta temas positivos simples'
);

const menciones4 = extraerMencionesPosNeg('Me gusta la alerta de los olivos pero no la de los cerdos');
assert(
  sameArray(menciones4.positivas, ['olivar']) && sameArray(menciones4.negativas, ['porcino']),
  'Normaliza alias: olivos -> olivar y cerdos -> porcino'
);

const natural1 = parsearVotosNaturalesPorAlertas('Me gusta la alerta de los olivos pero no la de los cerdos', [
  { titulo: 'Ayudas para explotaciones de olivar', subsectores: ['olivar'] },
  { titulo: 'Normativa sanitaria para porcino', subsectores: ['porcino'] },
]);
assert(
  natural1.votos.length === 2 &&
    natural1.votos.some(v => v.item === 1 && v.valor === 1 && v.tema === 'olivar') &&
    natural1.votos.some(v => v.item === 2 && v.valor === -1 && v.tema === 'porcino'),
  'Convierte feedback natural por temas en votos sobre alertas del digest'
);

const votos8 = parsearVotosDigest('Me interesa el 2 el 3 sobre todo, el resto no me interesa tanto', 5);
assert(
  votos8.length === 5 &&
    votos8.some(v => v.item === 2 && v.valor === 1) &&
    votos8.some(v => v.item === 3 && v.valor === 1) &&
    [1, 4, 5].every(item => votos8.some(v => v.item === item && v.valor === -1)),
  'Detecta positivos concretos y marca "el resto no me interesa tanto" como negativos suaves'
);

const menciones5 = extraerMencionesPosNeg('Me interesan las subvenciones para agricultura, pero lo del agua no me interesa tanto');
assert(
  menciones5.positivas.includes('ayuda') &&
    menciones5.negativas.includes('agua') &&
    !menciones5.positivas.includes('agua'),
  'Detecta "agua no me interesa tanto" como desinteres aunque el tema vaya antes de la negacion'
);

const natural2 = parsearVotosNaturalesPorAlertas('Me interesan las subvenciones, lo del agua no me interesa tanto', [
  { titulo: 'Concesion de aguas publicas', subsectores: ['agua'], tipos_alerta: ['agua_infraestructuras'] },
  { titulo: 'Subvenciones para agricultura', tipos_alerta: ['ayudas_subvenciones'] },
]);
assert(
  natural2.votos.some(v => v.item === 1 && v.valor === -1 && v.tema === 'agua') &&
    natural2.votos.some(v => v.item === 2 && v.valor === 1 && v.tema === 'ayuda'),
  'Convierte tema positivo y desinteres suave por agua en votos sobre alertas'
);

const comentarioTramite = 'a esa yo la solicite en cuanto salio y no se nada aun';
const naturalTramite = parsearVotosNaturalesPorAlertas(comentarioTramite, [
  { titulo: 'Concesion de aguas publicas', subsectores: ['agua'], tipos_alerta: ['agua_infraestructuras'] },
]);
assert(esComentarioTramiteOEspera(comentarioTramite), 'Detecta comentario de tramite o espera');
assert(parsearVotosDigest('aun no e recibido respuesta de ningun tipo', 2).length === 0, 'No interpreta espera de respuesta como ninguna alerta');
assert(
  naturalTramite.votos.length === 0 &&
    naturalTramite.menciones.positivas.length === 0 &&
    naturalTramite.menciones.negativas.length === 0,
  'No convierte comentario de tramite en voto natural sobre alertas'
);

const menciones6 = extraerMencionesPosNeg('Me gustaria recibir avisos sobre la PAC y ayudas para tractores');
assert(
  menciones6.positivas.includes('pac') &&
    menciones6.positivas.includes('ayuda') &&
    menciones6.positivas.includes('maquinaria agricola'),
  'Detecta PAC, ayudas y tractores como intereses aprendibles'
);

const futura1 = cerebroTesting.reforzarInterpretacionConReglasLocales(
  {
    feedbacks: [{ item_numero: 1, valor: -1, confianza: 'media', razon: 'La IA lo interpreto como rechazo del item' }],
    memoria: [],
    intencion: 'feedback',
    resumen_para_log: 'Feedback negativo item 1',
  },
  'Me gustaria recibir avisos sobre la PAC y ayudas para tractores',
  [{ titulo: 'Subvenciones agrarias', tipos_alerta: ['ayudas_subvenciones'] }]
);
assert(
  futura1.feedbacks.length === 0 &&
    futura1.memoria.some((m) => m.tipo === 'interes_detectado' && /pac/i.test(m.contenido)) &&
    futura1.intencion !== 'feedback',
  'Una preferencia futura no vota negativamente el digest activo'
);

const tramite1 = cerebroTesting.reforzarInterpretacionConReglasLocales(
  {
    feedbacks: [{ item_numero: 1, valor: -1, confianza: 'media', razon: 'La IA lo interpreto como rechazo del item' }],
    memoria: [{ tipo: 'desinteres_detectado', contenido: 'No le interesa agua', peso_inicial: 0.8 }],
    requiere_respuesta: true,
    respuesta: 'Hemos registrado tu interés.',
    intencion: 'feedback',
    resumen_para_log: 'Feedback negativo item 1',
  },
  'aun no e recibido respuesta de ningun tipo',
  [{ titulo: 'Concesion de aguas publicas', subsectores: ['agua'], tipos_alerta: ['agua_infraestructuras'] }]
);
assert(
  tramite1.feedbacks.length === 0 &&
    tramite1.memoria.length === 0 &&
    tramite1.requiere_respuesta === false &&
    tramite1.intencion === 'otro',
  'Refuerzo local anula feedback erroneo de espera de respuesta'
);

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
