const assert = require('assert');
const {
  compararDobleCheck,
  ejecutarDobleCheckCritico,
  requiereDobleCheckCritico,
} = require('../src/modules/alertas/intelligence/criticalDoubleCheck');

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
    });
}

console.log('\n=== TESTS: critical double check ===\n');

const tests = [];
function asyncTest(name, fn) {
  tests.push({ name, fn });
}

asyncTest('detecta casos criticos por ayuda, plazo o baja evidencia', async () => {
  assert.strictEqual(requiereDobleCheckCritico({
    alerta: { titulo: 'Ayuda PAC con plazo' },
    factSheet: { evidence_coverage: 0.9 },
  }), true);

  assert.strictEqual(requiereDobleCheckCritico({
    alerta: { titulo: 'Aviso menor' },
    factSheet: { evidence_coverage: 0.4 },
  }), true);
});

asyncTest('compara campos criticos y bloquea discrepancias', async () => {
  const result = compararDobleCheck({
    status: 'send',
    fields: { plazo: '30 de junio', territorio: 'huesca' },
  }, {
    status: 'send',
    fields: { plazo: '15 de julio', territorio: 'huesca' },
  });

  assert.strictEqual(result.status, 'blocked_review');
  assert(result.disagreements.some((item) => item.field === 'plazo'));
});

asyncTest('permite send cuando ambos checks coinciden', async () => {
  const result = await ejecutarDobleCheckCritico({
    force: true,
    checkerA: async () => ({
      status: 'send',
      confidence: 0.92,
      fields: { plazo: '30 de junio', territorio: 'huesca', tipo_documento: 'ayuda' },
    }),
    checkerB: async () => ({
      status: 'send',
      confidence: 0.9,
      fields: { plazo: '30 de junio', territorio: 'huesca', tipo_documento: 'ayuda' },
    }),
    alerta: { titulo: 'Ayuda PAC con plazo' },
    factSheet: { plazo: { valor: '30 de junio' }, evidence_coverage: 0.9 },
  });

  assert.strictEqual(result.status, 'send');
  assert.strictEqual(result.ok, true);
});

asyncTest('queda skipped cuando no esta habilitado', async () => {
  const result = await ejecutarDobleCheckCritico({
    enabled: false,
    alerta: { titulo: 'Ayuda PAC con plazo' },
    factSheet: { evidence_coverage: 0.9 },
  });

  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.required, true);
});

(async () => {
  for (const item of tests) {
    await new Promise((resolve) => {
      const before = passed + failed;
      test(item.name, item.fn);
      const timer = setInterval(() => {
        if (passed + failed > before) {
          clearInterval(timer);
          resolve();
        }
      }, 0);
    });
  }

  console.log(`\nResultados criticalDoubleCheck: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
})();
