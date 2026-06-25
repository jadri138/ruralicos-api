const assert = require('assert');
const {
  calcularAjusteFeedbackTag,
  esTagPositivoAtribuible,
  esRechazoGlobalFeedback,
} = require('../src/modules/aprendizaje/userInterestProfile');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

console.log('\n=== TESTS: user interest profile ===\n');

test('detecta ninguna como rechazo global', () => {
  assert.strictEqual(esRechazoGlobalFeedback('ninguna'), true);
  assert.strictEqual(esRechazoGlobalFeedback('no'), true);
  assert.strictEqual(esRechazoGlobalFeedback('no 2'), false);
});

test('ninguna no penaliza provincia sector ni concepto amplio', () => {
  assert.strictEqual(calcularAjusteFeedbackTag('provincia:huesca', -1, 'ninguna'), 0);
  assert.strictEqual(calcularAjusteFeedbackTag('sector:ganaderia', -1, 'ninguna'), 0);
  assert.strictEqual(calcularAjusteFeedbackTag('concepto:agua_riego', -1, 'ninguna'), 0);
});

test('ninguna penaliza suave fuente y tramite concreto', () => {
  assert.strictEqual(calcularAjusteFeedbackTag('fuente:DOGC', -1, 'ninguna'), -0.25);
  assert.strictEqual(calcularAjusteFeedbackTag('tramite:individual', -1, 'ninguna'), -0.45);
});

test('rechazo de item concreto penaliza tema pero no base geografica', () => {
  assert.strictEqual(calcularAjusteFeedbackTag('provincia:huesca', -1, 'no 2'), 0);
  assert.strictEqual(calcularAjusteFeedbackTag('concepto:agua_riego', -1, 'no 2'), -0.35);
});

test('feedback positivo generico solo refuerza tags de alta senal', () => {
  assert.strictEqual(calcularAjusteFeedbackTag('provincia:huesca', 1, '1'), 0);
  assert.strictEqual(calcularAjusteFeedbackTag('sector:agricultura', 1, '1'), 0);
  assert.strictEqual(calcularAjusteFeedbackTag('fuente:boe', 1, '1'), 0);
  assert.strictEqual(calcularAjusteFeedbackTag('concepto:agua_riego', 1, '1'), 1);
  assert.strictEqual(calcularAjusteFeedbackTag('subsector:olivar', 1, '1'), 1);
});

test('feedback positivo explicito puede atribuir geografia o sector', () => {
  assert.strictEqual(esTagPositivoAtribuible('provincia:huesca', 'Me interesa Huesca'), true);
  assert.strictEqual(calcularAjusteFeedbackTag('provincia:huesca', 1, 'Me interesa Huesca'), 1);
  assert.strictEqual(calcularAjusteFeedbackTag('sector:ganaderia', 1, 'Quiero ganaderia'), 1);
});

console.log(`\nResultados userInterestProfile: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
