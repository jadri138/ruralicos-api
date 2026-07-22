const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  INVENTORY_SQL,
  assertReadOnlyStatement,
  buildSchemaReport,
  collectFixtureInventory,
  withReadOnlyTransaction,
} = require('../scripts/p0-acceptance/readOnlyInventory');
const {
  EXIT_CODES,
  assessGate,
  parseArgs,
  resolveExternalCommand,
  sanitizeError,
} = require('../scripts/p0_acceptance_gate');

const corpus = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'p0', 'acceptance-corpus.json'),
  'utf8'
));

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(error.stack || error.message);
  }
}

function passingAssessment(overrides = {}) {
  const diagnostic = {
    status: 'pass',
    ...collectFixtureInventory(corpus),
    ...overrides.diagnostic,
  };
  return assessGate({
    candidate: { sha: 'abc123', clean: true, sha_changed: false },
    quality: [{ id: 'lint', status: 'pass' }],
    matrix: { status: 'pass' },
    localMigrations: { status: 'pass' },
    diagnostic,
    ...overrides,
  });
}

(async () => {
  await test('todas las consultas de inventario son SELECT, WITH o SHOW de una sola sentencia', () => {
    for (const [name, sql] of Object.entries(INVENTORY_SQL)) {
      assert.strictEqual(assertReadOnlyStatement(sql), true, name);
    }
  });

  await test('el guard de solo lectura rechaza escrituras incluso despues de un SELECT', () => {
    for (const sql of [
      'UPDATE public.alertas SET estado_ia = \'listo\'',
      'SELECT 1; DELETE FROM public.alertas',
      'WITH changed AS (DELETE FROM public.alertas RETURNING id) SELECT * FROM changed',
      'SELECT nextval(\'public.alertas_id_seq\')',
      'CALL public.repair_alertas()',
    ]) {
      assert.throws(() => assertReadOnlyStatement(sql), /p0_read_only_violation/);
    }
  });

  await test('la sesion diagnostica abre READ ONLY y siempre termina con ROLLBACK', async () => {
    const statements = [];
    const fakeClient = {
      async query(sql) {
        statements.push(sql);
        if (sql === 'SHOW transaction_read_only') {
          return { rows: [{ transaction_read_only: 'on' }] };
        }
        return { rows: [{ one: 1 }] };
      },
    };
    const result = await withReadOnlyTransaction(fakeClient, async (client) => {
      assert.strictEqual(assertReadOnlyStatement('SELECT 1'), true);
      return client.query('SELECT 1');
    });
    assert.deepStrictEqual(result.rows, [{ one: 1 }]);
    assert.strictEqual(
      statements[0],
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    assert.strictEqual(statements[1], 'SHOW transaction_read_only');
    assert.strictEqual(statements.at(-1), 'ROLLBACK');
    assert(!statements.includes('COMMIT'));
    assert(!statements.some((sql) => /\b(?:insert|update|delete|alter|drop|truncate)\b/i.test(sql)));
  });

  await test('el inventario fixture solo emite agregados y deja el backfill pendiente sin bloquearlo', () => {
    const diagnostic = collectFixtureInventory(corpus);
    assert.strictEqual(diagnostic.connection.transaction_read_only, true);
    assert.strictEqual(diagnostic.connection.has_write_privileges, false);
    assert.strictEqual(diagnostic.schema.status, 'pass');
    assert.strictEqual(diagnostic.schema.constraint.exists, true);
    assert.strictEqual(diagnostic.schema.constraint.validated, false);
    assert.strictEqual(diagnostic.inventory.retained.pendiente_revision_manual, 1);
    assert.strictEqual(diagnostic.inventory.retained.needs_evidence, 1);
    assert.strictEqual(diagnostic.inventory.discards.incomplete, 1);
    assert.strictEqual(diagnostic.inventory.anomalies.no_importa_outside_discard, 0);
    assert.strictEqual(diagnostic.inventory.anomalies.listo_with_discard_fields, 0);

    const assessment = passingAssessment();
    assert.strictEqual(assessment.result.exit_code, EXIT_CODES.ACCEPTABLE);
    assert.strictEqual(assessment.discard_backfill_readiness.status, 'ready');
    assert(assessment.discard_backfill_readiness.pending_work.some((item) => item.includes('incomplete')));
    assert(assessment.discard_backfill_readiness.pending_work.some((item) => item.includes('validate')));
  });

  await test('esquema no aplicado usa un estado y codigo distintos de un fallo de comprobacion', () => {
    const schema = buildSchemaReport({
      tables: ['alertas'],
      columns: { alertas: [] },
      migrations: [],
      constraint: { exists: false, validated: false },
    });
    const fixture = collectFixtureInventory(corpus);
    const schemaAssessment = passingAssessment({
      diagnostic: {
        ...fixture,
        schema,
        inventory: { status: 'unavailable', reason: 'schema_not_applied' },
      },
    });
    assert.strictEqual(schemaAssessment.result.status, 'schema_not_applied');
    assert.strictEqual(schemaAssessment.result.exit_code, EXIT_CODES.SCHEMA_NOT_APPLIED);

    const failedAssessment = passingAssessment({
      quality: [{ id: 'lint', status: 'failed' }],
    });
    assert.strictEqual(failedAssessment.result.status, 'check_failed');
    assert.strictEqual(failedAssessment.result.exit_code, EXIT_CODES.CHECK_FAILED);
  });

  await test('el gate resuelve npm en Windows sin ejecutar npm.cmd directamente', () => {
    const viaNode = resolveExternalCommand(
      { command: 'npm', args: ['run', 'lint'] },
      { platform: 'win32', npmExecPath: __filename }
    );
    assert.strictEqual(viaNode.command, process.execPath);
    assert.deepStrictEqual(viaNode.args, [__filename, 'run', 'lint']);

    const viaCmd = resolveExternalCommand(
      { command: 'npm', args: ['run', 'lint'] },
      { platform: 'win32', npmExecPath: 'Z:\\missing\\npm-cli.js', comSpec: 'cmd.exe' }
    );
    assert.strictEqual(viaCmd.command, 'cmd.exe');
    assert.deepStrictEqual(viaCmd.args, ['/d', '/s', '/c', 'npm.cmd', 'run', 'lint']);
  });

  await test('el CLI bloquea produccion y solo admite PostgreSQL staging', () => {
    assert.throws(
      () => parseArgs(['--source=postgres', '--target=production']),
      /solo admite --target=staging/
    );
    const options = parseArgs(['--source=postgres', '--target=staging']);
    assert.strictEqual(options.source, 'postgres');
    assert.strictEqual(options.target, 'staging');
  });

  await test('los errores eliminan URLs y tokens antes de entrar en el informe', () => {
    const sanitized = sanitizeError(
      'fallo postgresql://user:secret@host/db password=hunter2 eyJabcdefghijklmnopqrstuv.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuv'
    );
    assert(!sanitized.includes('secret'));
    assert(!sanitized.includes('hunter2'));
    assert(!sanitized.includes('eyJabcdefghijklmnopqrstuv'));
  });

  console.log(`\nResultados p0AcceptanceInventory: ${passed} aprobados, ${failed} fallidos`);
  process.exit(failed === 0 ? 0 : 1);
})();
