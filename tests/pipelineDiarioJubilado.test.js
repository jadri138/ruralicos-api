const assert = require('assert');
const { pipelineDiarioJubilado } = require('../src/modules/tareas/tareas.helpers');

let passed = 0;
let failed = 0;

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`OK: ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`FAIL: ${name}`);
      console.error(err.message);
      process.exitCode = 1;
    });
}

console.log('\n=== TESTS: interlock de cutover de pipeline-diario ===\n');

test('sin variable el tick corre en real y pipeline-diario queda jubilado', () => {
  assert.strictEqual(pipelineDiarioJubilado({}, {}), true);
});

test('con PIPELINE_TICK_SHADOW=true explicito sigue activo', () => {
  assert.strictEqual(pipelineDiarioJubilado({ PIPELINE_TICK_SHADOW: 'true' }, {}), false);
});

test('con el tick en real (PIPELINE_TICK_SHADOW=false) queda jubilado', () => {
  assert.strictEqual(pipelineDiarioJubilado({ PIPELINE_TICK_SHADOW: 'false' }, {}), true);
});

test('jubilado pero con force_legacy=true se reactiva puntualmente', () => {
  assert.strictEqual(
    pipelineDiarioJubilado({ PIPELINE_TICK_SHADOW: 'false' }, { force_legacy: 'true' }),
    false
  );
});

test('force_legacy no valido (typo) no reactiva', () => {
  assert.strictEqual(
    pipelineDiarioJubilado({ PIPELINE_TICK_SHADOW: 'false' }, { force_legacy: 'yes please' }),
    true
  );
});

test('force_legacy=true reactiva el legado incluso con el default real', () => {
  assert.strictEqual(pipelineDiarioJubilado({}, { force_legacy: 'true' }), false);
});

process.on('exit', () => {
  console.log(`\nResultados pipelineDiarioJubilado: ${passed} aprobados, ${failed} fallidos`);
});
