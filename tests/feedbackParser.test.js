/**
 * tests/feedbackParser.test.js
 *
 * Pruebas locales de las funciones puras del parser de feedback.
 * No requieren OpenAI ni Supabase.
 */

const {
  parsearVotosDigest,
  extraerMencionesPosNeg,
} = require('../src/brain/feedbackParser');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`✅ ${message}`);
  passed += 1;
}

function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

console.log('\n=== TESTS: feedbackParser ===\n');

const votos1 = parsearVotosDigest('+1');
assert(votos1.length === 1 && votos1[0].item === 1 && votos1[0].valor === 1, 'Detecta +1 como voto positivo para item 1');

const votos2 = parsearVotosDigest('quitar 5');
assert(votos2.length === 1 && votos2[0].item === 5 && votos2[0].valor === -1, 'Detecta "quitar 5" como voto negativo');

const votos3 = parsearVotosDigest('Me interesa 2 y 3');
assert(votos3.length === 2 && votos3.some(v => v.item === 2 && v.valor === 1) && votos3.some(v => v.item === 3 && v.valor === 1), 'Detecta números positivos tras "me interesa"');

const votos4 = parsearVotosDigest('1,2,3');
assert(votos4.length === 3 && votos4.every(v => v.valor === 1), 'Detecta lista de números sin signo como positivos');

const menciones1 = extraerMencionesPosNeg('Me interesa el olivar de Castellón pero no el porcino');
assert(
  sameArray(menciones1.positivas.sort(), ['castellón', 'olivar'].sort()) && sameArray(menciones1.negativas, ['porcino']),
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

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
