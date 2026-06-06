const assert = require('assert');
const { fusionarAlertasUnicas, obtenerIdAlerta } = require('../src/utils/alertCandidateMerge');

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

console.log('\n=== TESTS: alert candidate merge ===\n');

test('prioriza pgvector sin perder candidatos base validos', () => {
  const fusionadas = fusionarAlertasUnicas(
    [{ id: 9954, origen: 'pgvector' }],
    [{ id: 9954, origen: 'base' }, { id: 9955, origen: 'base' }, { id: 9964, origen: 'base' }]
  );

  assert.deepStrictEqual(fusionadas.map((alerta) => alerta.id), [9954, 9955, 9964]);
  assert.strictEqual(fusionadas[0].origen, 'pgvector');
});

test('ignora candidatos sin id numerico', () => {
  assert.strictEqual(obtenerIdAlerta({ id: '42' }), 42);
  assert.strictEqual(obtenerIdAlerta({ id: 'x' }), null);
  assert.deepStrictEqual(fusionarAlertasUnicas([{ id: null }, { id: 1 }]).map((alerta) => alerta.id), [1]);
});

console.log(`\nResultados alertCandidateMerge: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
