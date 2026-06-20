const assert = require('assert');
const {
  FEEDBACK_CATEGORIES,
  clasificarFeedbackDigest,
} = require('../src/modules/mia/feedbackClassifier');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

console.log('\n=== TESTS: feedback classifier ===\n');

test('clasifica feedback positivo como useful', () => {
  const result = clasificarFeedbackDigest({
    texto: 'me interesa la 1',
    feedback: { valor: 1, confidence: 0.93 },
    alerta: { titulo: 'Ayuda maquinaria' },
  });

  assert.strictEqual(result.category, FEEDBACK_CATEGORIES.USEFUL);
  assert(result.confidence >= 0.9);
});

test('detecta ubicacion incorrecta', () => {
  const result = clasificarFeedbackDigest({
    texto: 'la 2 no es de mi zona, es otra provincia',
    feedback: { valor: -1 },
    alerta: { titulo: 'Ayuda', provincias: ['Teruel'] },
  });

  assert.strictEqual(result.category, FEEDBACK_CATEGORIES.WRONG_LOCATION);
});

test('detecta ruido de expediente individual', () => {
  const result = clasificarFeedbackDigest({
    texto: 'esto es un caso particular, no es mio',
    feedback: { valor: -1 },
    alerta: { titulo: 'Concesion de aguas', resumen_final: 'Expediente individual de concesion de aguas.' },
  });

  assert.strictEqual(result.category, FEEDBACK_CATEGORIES.INDIVIDUAL_CASE_NOISE);
});

test('detecta resumen demasiado generico', () => {
  const result = clasificarFeedbackDigest({
    texto: 'demasiado generico, no dice nada',
    feedback: { valor: -1 },
    alerta: { titulo: 'Publicacion oficial relevante' },
  });

  assert.strictEqual(result.category, FEEDBACK_CATEGORIES.TOO_GENERIC);
});

test('detecta perfil de usuario incompleto', () => {
  const result = clasificarFeedbackDigest({
    texto: 'yo soy ganadero de ovino y no tengo vinedo',
    feedback: { valor: -1 },
    alerta: { titulo: 'Ayuda a vinedo' },
  });

  assert.strictEqual(result.category, FEEDBACK_CATEGORIES.USER_PROFILE_MISSING);
});

test('marca rechazo simple como wrong_topic suave', () => {
  const result = clasificarFeedbackDigest({
    texto: 'no me interesa',
    feedback: { valor: -1 },
    alerta: { titulo: 'Aviso agrario' },
  });

  assert.strictEqual(result.category, FEEDBACK_CATEGORIES.WRONG_TOPIC);
});

console.log(`\nResultados feedbackClassifier: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
