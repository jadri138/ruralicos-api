const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  GOLDEN_CORPUS_VERSION,
  REQUIRED_GOLDEN_CATEGORIES,
  inspectOfflineReplaySource,
  runOfflineReplay,
  validateReplayCorpus,
} = require('../src/modules/alertas/decision/replay');

const fixturePath = path.join(__dirname, 'fixtures', 'decision', 'golden-corpus.json');
const replayModulePath = path.join(__dirname, '..', 'src', 'modules', 'alertas', 'decision', 'replay.js');
const replayScriptPath = path.join(__dirname, '..', 'scripts', 'replay_alert_decisions.js');
const corpus = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function resultById(report, id) {
  const result = report.results.find((item) => item.case_id === id);
  assert(result, `No existe el caso ${id}`);
  return result;
}

test('el corpus dorado es versionado, representativo, sin PII y cubre cuatro semanas', () => {
  const validation = validateReplayCorpus(corpus);
  assert.deepStrictEqual(validation, { valid: true, errors: [] });
  assert.strictEqual(corpus.version, GOLDEN_CORPUS_VERSION);
  const categories = new Set(corpus.cases.flatMap((item) => item.categories));
  for (const category of REQUIRED_GOLDEN_CATEGORIES) assert(categories.has(category));
  const serialized = JSON.stringify(corpus.profiles);
  assert(!/telefono|phone|email|nombre|name/i.test(serialized));
});

test('el replay compara decisiones actuales y propuestas sin desviarse del golden', async () => {
  const report = await runOfflineReplay(corpus);
  assert.strictEqual(report.mode, 'offline_read_only');
  assert.strictEqual(report.totals.cases, 16);
  assert.strictEqual(report.totals.expected_failed, 0);
  assert.strictEqual(report.acceptance.passed, true);
  assert(report.period.span_days >= 22);
  assert(report.metrics.alerts_gained.includes('autonomous-aragon-applicable'));
  assert(report.metrics.alerts_gained.includes('national-pac-opportunity'));
  assert(report.metrics.alerts_lost.includes('other-province-hard-block'));
  assert(report.metrics.alerts_lost.includes('irrelevant-urban-marketing'));
  assert(Object.keys(report.metrics.silence_causes).length > 0);
  assert(Number.isFinite(report.metrics.estimated_cost_eur.proposed));
  assert(report.metrics.llm_only_changes.includes('irrelevant-urban-marketing'));
  assert(report.metrics.evidence_contradictions.some((item) => item.case_id === 'other-province-hard-block'));
});

test('las pruebas metamórficas conservan orden y endurecen evidencia y territorio', async () => {
  const report = await runOfflineReplay(corpus);
  assert.strictEqual(report.metamorphic.passed, true);
  assert.deepStrictEqual(report.metamorphic.violations, []);
  assert.strictEqual(report.metamorphic.checks.length, 3);
  assert(report.metamorphic.checks.every((item) => item.passed));
  assert.strictEqual(report.metrics.stability.passed, true);
  assert.strictEqual(report.metrics.stability.stable_cases, corpus.cases.length);
});

test('recorre casos completos positivo, bloqueado, retenido y con fallo de transporte', async () => {
  const report = await runOfflineReplay(corpus);
  const positive = resultById(report, 'relevant-teruel-aid');
  assert.strictEqual(positive.proposed.state, 'ADD_TO_DIGEST');
  assert(positive.proposed.message);
  assert.strictEqual(positive.delivery.status, 'READ');
  assert(positive.memory_effects.some((item) => item.source === 'feedback'));
  assert(positive.memory_effects.some((item) => item.source === 'click'));

  const blocked = resultById(report, 'other-province-hard-block');
  assert.strictEqual(blocked.proposed.state, 'BLOCKED');
  assert.strictEqual(blocked.proposed.message, null);
  assert.strictEqual(blocked.delivery.attempted, false);

  const held = resultById(report, 'incomplete-without-official-url');
  assert.strictEqual(held.proposed.state, 'HOLD_FOR_EVIDENCE');
  assert.strictEqual(held.proposed.message, null);
  assert(held.proposed.reason_codes.includes('OFFICIAL_URL_MISSING'));

  const failed = resultById(report, 'transport-failure-does-not-learn');
  assert.strictEqual(failed.proposed.state, 'ADD_TO_DIGEST');
  assert(failed.proposed.message);
  assert.strictEqual(failed.delivery.status, 'FAILED');
  assert.deepStrictEqual(failed.memory_effects, []);
  assert.strictEqual(report.metrics.delivery.failed, 1);
});

test('los mensajes simulados solo usan la proyección segura', async () => {
  const report = await runOfflineReplay(corpus);
  const messages = report.results.map((item) => item.proposed.message).filter(Boolean);
  assert(messages.length > 0);
  assert(messages.every((message) => /Fuente oficial:/i.test(message)));
  assert(messages.every((message) => !/embedding|fact[ -]?sheet|algoritmo|prompt|score/i.test(message)));
});

test('el paquete offline no importa clientes externos ni contiene mutaciones o red', async () => {
  const replaySource = fs.readFileSync(replayModulePath, 'utf8');
  const scriptSource = fs.readFileSync(replayScriptPath, 'utf8');
  const moduleSafety = inspectOfflineReplaySource(replaySource);
  const scriptSafety = inspectOfflineReplaySource(scriptSource);
  assert.strictEqual(moduleSafety.safe, true, JSON.stringify(moduleSafety));
  assert.strictEqual(scriptSafety.safe, true, JSON.stringify(scriptSafety));

  let networkCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    networkCalls += 1;
    throw new Error('La red no está permitida en replay');
  };
  try {
    const report = await runOfflineReplay(corpus);
    assert.strictEqual(report.acceptance.passed, true);
  } finally {
    global.fetch = originalFetch;
  }
  assert.strictEqual(networkCalls, 0);
});

test('rechaza un corpus roto antes de evaluar', async () => {
  const broken = JSON.parse(JSON.stringify(corpus));
  broken.cases[0].profile_id = 'profile-missing';
  const validation = validateReplayCorpus(broken);
  assert.strictEqual(validation.valid, false);
  assert(validation.errors.includes('profile_not_found:relevant-teruel-aid'));
  await assert.rejects(() => runOfflineReplay(broken), (error) => (
    error.code === 'INVALID_REPLAY_CORPUS'
  ));
});

test('el comando CLI usa el corpus local y devuelve JSON válido', () => {
  const execution = spawnSync(process.execPath, [replayScriptPath, '--json'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  assert.strictEqual(execution.status, 0, execution.stderr || execution.stdout);
  const report = JSON.parse(execution.stdout);
  assert.strictEqual(report.mode, 'offline_read_only');
  assert.strictEqual(report.acceptance.passed, true);
  assert.strictEqual(report.totals.expected_failed, 0);
});

(async () => {
  let passed = 0;
  let failed = 0;
  console.log('\n=== TESTS: alert decision offline replay ===\n');
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`OK: ${item.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL: ${item.name}`);
      console.error(error.stack || error.message);
    }
  }
  console.log(`\nResultado: ${passed} OK, ${failed} FAIL\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
