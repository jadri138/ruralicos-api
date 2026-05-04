const {
  parsearVotosDigest,
  extraerMencionesPosNeg,
  parsearVotosNaturalesPorAlertas,
} = require('../src/brain/feedbackParser');

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

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
