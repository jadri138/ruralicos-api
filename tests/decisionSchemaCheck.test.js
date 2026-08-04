const assert = require('assert');
const {
  CONTRATO_ESPERADO,
  CredencialError,
  comprobarEsquemaDecision,
} = require('../scripts/check_decision_schema');

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

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

console.log('\n=== TESTS: comprobacion de esquema de decision ===\n');

// Cliente doble: responde segun un conjunto de columnas presentes. No hay red.
function clienteFalso({ presentes = null, ausentesTabla = [], errorGlobal = null } = {}) {
  return {
    from(tabla) {
      return {
        select(columna) {
          return {
            limit() {
              if (errorGlobal) return Promise.resolve({ error: { message: errorGlobal } });
              if (ausentesTabla.includes(tabla)) {
                return Promise.resolve({
                  error: { message: `relation "public.${tabla}" does not exist` },
                });
              }
              if (presentes && !presentes.has(`${tabla}.${columna}`)) {
                return Promise.resolve({
                  error: { message: `column ${tabla}.${columna} does not exist` },
                });
              }
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  };
}

function todasLasColumnas() {
  const set = new Set();
  for (const [tabla, columnas] of CONTRATO_ESPERADO) {
    for (const columna of columnas) set.add(`${tabla}.${columna}`);
  }
  return set;
}

test('el contrato cubre las tablas que toca el flujo nuevo', () => {
  const tablas = CONTRATO_ESPERADO.map(([tabla]) => tabla);
  for (const esperada of [
    'digest_candidate_decisions',
    'digest_attempts',
    'digests',
    'mia_outbox',
    'whatsapp_logs',
    'whatsapp_delivery_events',
    'user_memory',
    'alert_fact_sheets',
    'alert_decision_llm_daily_budget',
  ]) {
    assert(tablas.includes(esperada), `falta ${esperada} en el contrato comprobado`);
  }
});

testAsync('un esquema completo se declara aplicado', async () => {
  const informe = await comprobarEsquemaDecision({
    client: clienteFalso({ presentes: todasLasColumnas() }),
  });

  assert.strictEqual(informe.aplicada, true);
  assert.strictEqual(informe.resumen.incompletas, 0);
  assert(informe.tablas.every((fila) => fila.estado === 'ok'));
});

testAsync('una columna ausente se nombra y bloquea el despliegue', async () => {
  const presentes = todasLasColumnas();
  presentes.delete('digests.idempotency_key');

  const informe = await comprobarEsquemaDecision({ client: clienteFalso({ presentes }) });
  const digests = informe.tablas.find((fila) => fila.tabla === 'digests');

  assert.strictEqual(informe.aplicada, false);
  assert.strictEqual(digests.estado, 'columnas_ausentes');
  assert.deepStrictEqual(digests.columnas_ausentes, ['idempotency_key']);
});

testAsync('una tabla que no existe se distingue de una columna ausente', async () => {
  const informe = await comprobarEsquemaDecision({
    client: clienteFalso({
      presentes: todasLasColumnas(),
      ausentesTabla: ['whatsapp_delivery_events'],
    }),
  });
  const eventos = informe.tablas.find((fila) => fila.tabla === 'whatsapp_delivery_events');

  assert.strictEqual(eventos.estado, 'tabla_ausente');
  assert.deepStrictEqual(eventos.columnas_ausentes, []);
});

testAsync('una credencial invalida no se confunde con un esquema incompleto', async () => {
  await assert.rejects(
    () => comprobarEsquemaDecision({ client: clienteFalso({ errorGlobal: 'Invalid API key' }) }),
    (error) => error instanceof CredencialError,
    'debe propagarse como error de credencial, no como falta de columnas'
  );
});

testAsync('un error desconocido queda como indeterminado y no como ausencia', async () => {
  const informe = await comprobarEsquemaDecision({
    client: clienteFalso({ errorGlobal: 'connection reset by peer' }),
  });
  const primera = informe.tablas[0];

  assert.strictEqual(informe.aplicada, false);
  assert.deepStrictEqual(primera.columnas_ausentes, []);
  assert(primera.indeterminadas.length > 0, 'el motivo real queda registrado');
});

setTimeout(() => {
  console.log(`\nResultados decisionSchemaCheck: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}, 100);
