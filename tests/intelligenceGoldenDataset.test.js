const assert = require('assert');
const {
  GOLDEN_DATASET_VERSION,
  INTELLIGENCE_GOLDEN_FIXTURES,
  ejecutarGoldenDataset,
  evaluarEscenarioGolden,
} = require('../src/modules/alertas/intelligence/goldenDataset');

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

console.log('\n=== EVALS: intelligence golden dataset ===\n');

test('declara version y bateria amplia de escenarios', () => {
  assert.strictEqual(GOLDEN_DATASET_VERSION, 'intelligence_golden_v1');
  assert(INTELLIGENCE_GOLDEN_FIXTURES.length >= 14);
});

test('cubre decisiones futuras include, review_only y blocked', () => {
  const decisions = new Set(INTELLIGENCE_GOLDEN_FIXTURES.map((fixture) => fixture.expected.future_decision));
  assert(decisions.has('include'));
  assert(decisions.has('review_only'));
  assert(decisions.has('blocked'));
});

test('cada escenario tiene expectativa futura auditable', () => {
  for (const fixture of INTELLIGENCE_GOLDEN_FIXTURES) {
    assert(fixture.id);
    assert(fixture.description);
    assert(fixture.alerta?.id);
    assert(['include', 'review_only', 'blocked'].includes(fixture.expected.future_decision));
    assert(Array.isArray(fixture.expected.reasons));
  }
});

test('cada escenario puede evaluarse contra el motor actual sin escribir datos', () => {
  for (const fixture of INTELLIGENCE_GOLDEN_FIXTURES) {
    const result = evaluarEscenarioGolden(fixture);
    assert.strictEqual(result.id, fixture.id);
    assert(['include', 'review_only', 'blocked'].includes(result.current.decision));
    assert(['include', 'review', 'review_only', 'exclude'].includes(result.current.action));
    assert(Number.isFinite(result.current.score));
    assert(Number.isFinite(result.current.quality_score));
    assert(Array.isArray(result.current.quality_flags));
    assert(Array.isArray(result.gaps));
  }
});

test('el informe global no permite brechas frente a la decision futura esperada', () => {
  const report = ejecutarGoldenDataset();
  assert.strictEqual(report.version, GOLDEN_DATASET_VERSION);
  assert.strictEqual(report.scenarios_total, INTELLIGENCE_GOLDEN_FIXTURES.length);
  assert(Array.isArray(report.scenarios));
  assert(Array.isArray(report.gaps));
  assert.strictEqual(report.scenarios_matching_future, report.scenarios_total);
  assert.strictEqual(report.scenarios_with_gaps, 0);
  assert.strictEqual(report.gaps_total, 0);
});

const report = ejecutarGoldenDataset();
console.log('\nResumen golden dataset:');
console.log(JSON.stringify({
  scenarios_total: report.scenarios_total,
  scenarios_matching_future: report.scenarios_matching_future,
  scenarios_with_gaps: report.scenarios_with_gaps,
  gaps_total: report.gaps_total,
}, null, 2));

console.log(`\nResultados intelligenceGoldenDataset: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
