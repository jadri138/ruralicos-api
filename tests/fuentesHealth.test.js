const assert = require('assert');
const { evaluarSaludFuentes, construirMensajeFuentesCaidas } = require('../src/modules/boletines/fuentesHealth');

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

function runsDe(fuente, dia, statuses, errorMsg = 'timeout of 40000ms exceeded') {
  return statuses.map((status) => ({
    fuente,
    dia,
    status,
    error_msg: status === 'error' ? errorMsg : null,
  }));
}

console.log('\n=== TESTS: fuentes health ===\n');

test('detecta fuente con 2 días consecutivos en error total', () => {
  const runs = [
    ...runsDe('BOPZ', '2026-07-04', ['error', 'error', 'error']),
    ...runsDe('BOPZ', '2026-07-03', ['error', 'error']),
    ...runsDe('BOE', '2026-07-04', ['ok', 'ok']),
  ];

  const caidas = evaluarSaludFuentes(runs, { minDiasCaida: 2 });
  assert.strictEqual(caidas.length, 1);
  assert.strictEqual(caidas[0].fuente, 'BOPZ');
  assert.strictEqual(caidas[0].dias_caida, 2);
  assert(/timeout/.test(caidas[0].ultimo_error));
});

test('un solo día en error no dispara con min_dias=2', () => {
  const runs = [
    ...runsDe('BON', '2026-07-04', ['error', 'error']),
    ...runsDe('BON', '2026-07-03', ['ok', 'error']),
  ];

  assert.strictEqual(evaluarSaludFuentes(runs, { minDiasCaida: 2 }).length, 0);
});

test('un run ok en el día corta la racha (error intermitente ≠ caída)', () => {
  const runs = [
    ...runsDe('BOCM', '2026-07-04', ['error', 'ok', 'error']),
    ...runsDe('BOCM', '2026-07-03', ['error', 'error']),
  ];

  assert.strictEqual(evaluarSaludFuentes(runs, { minDiasCaida: 2 }).length, 0);
});

test('la racha se cuenta desde el día más reciente hacia atrás', () => {
  const runs = [
    ...runsDe('BOCCE', '2026-07-04', ['error']),
    ...runsDe('BOCCE', '2026-07-03', ['error']),
    ...runsDe('BOCCE', '2026-07-02', ['error']),
    ...runsDe('BOCCE', '2026-07-01', ['ok']),
    ...runsDe('BOCCE', '2026-06-30', ['error']),
  ];

  const caidas = evaluarSaludFuentes(runs, { minDiasCaida: 2 });
  assert.strictEqual(caidas.length, 1);
  assert.strictEqual(caidas[0].dias_caida, 3);
});

test('los warnings no cuentan como caída', () => {
  const runs = [
    ...runsDe('BOPH', '2026-07-04', ['warning', 'warning']),
    ...runsDe('BOPH', '2026-07-03', ['warning', 'warning']),
  ];

  assert.strictEqual(evaluarSaludFuentes(runs, { minDiasCaida: 2 }).length, 0);
});

test('ordena por días de caída y construye mensaje legible', () => {
  const runs = [
    ...runsDe('BOPZ', '2026-07-04', ['error']),
    ...runsDe('BOPZ', '2026-07-03', ['error']),
    ...runsDe('BOCCE', '2026-07-04', ['error']),
    ...runsDe('BOCCE', '2026-07-03', ['error']),
    ...runsDe('BOCCE', '2026-07-02', ['error']),
  ];

  const caidas = evaluarSaludFuentes(runs, { minDiasCaida: 2 });
  assert.deepStrictEqual(caidas.map((c) => c.fuente), ['BOCCE', 'BOPZ']);

  const mensaje = construirMensajeFuentesCaidas(caidas, { fecha: '2026-07-04' });
  assert(mensaje.includes('BOCCE: 3 día(s)'), 'incluye BOCCE con su racha');
  assert(mensaje.includes('BOPZ: 2 día(s)'), 'incluye BOPZ con su racha');
  assert(construirMensajeFuentesCaidas([]) === '', 'sin caídas → mensaje vacío');
});

console.log(`\nResultados fuentesHealth: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
