const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  DISCARD_REQUIRED_FIELDS,
  construirDescarteAuditable,
  esAlertaDescartada,
  esDescarteAuditable,
  obtenerCamposFaltantesDescarte,
} = require('../src/modules/alertas/clasificacion/discardDecision');
const {
  prepararReparacionDescarteHistorico,
  repararDescartesHistoricos,
} = require('../src/modules/alertas/clasificacion/legacyDiscardRepair');
const {
  VALIDATION_SQL_PATH,
  parsearArgumentos,
  puedeValidarConstraint,
} = require('../scripts/repair_legacy_alert_discards');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function listarJavaScript(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? listarJavaScript(absolute) : [absolute];
  }).filter((file) => file.endsWith('.js'));
}

function crearSupabaseFalso(rows) {
  const updates = [];
  return {
    updates,
    from() {
      let operation = 'select';
      let cursorId = null;
      let pageSize = rows.length;
      const builder = {
        select() { return builder; },
        update(patch) {
          operation = 'update';
          updates.push(patch);
          return builder;
        },
        eq() { return builder; },
        gt(column, value) {
          if (operation === 'select' && column === 'id') cursorId = value;
          return builder;
        },
        order() { return builder; },
        limit(value) {
          if (operation === 'select') pageSize = value;
          return builder;
        },
        then(onFulfilled, onRejected) {
          const result = operation === 'select'
            ? {
              data: rows
                .filter((row) => cursorId === null || row.id > cursorId)
                .slice(0, pageSize),
              error: null,
            }
            : { data: null, error: null };
          return Promise.resolve(result).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

test('el constructor comun siempre entrega los cinco campos estructurados y conserva la auditoria previa', () => {
  const patch = construirDescarteAuditable({
    code: 'actividad_cultural_no_rural',
    stage: 'review_ai',
    confidence: 0.91,
    previousAudit: { official_rural_gate: { version: 'test' } },
  });

  assert(esAlertaDescartada(patch));
  assert(esDescarteAuditable(patch));
  assert.deepStrictEqual(obtenerCamposFaltantesDescarte(patch), []);
  for (const field of DISCARD_REQUIRED_FIELDS) {
    assert(Object.hasOwn(patch, field), `falta ${field}`);
  }
  assert.deepStrictEqual(patch.decision_audit.official_rural_gate, { version: 'test' });
});

test('un descarte historico desconocido usa legacy_unstructured_discard sin inventar evidencia', () => {
  const alerta = {
    id: 1,
    estado_ia: 'descartado',
    resumen: 'NO IMPORTA',
    decision_audit: { imported_from: 'legacy' },
  };
  const plan = prepararReparacionDescarteHistorico(alerta);

  assert.strictEqual(plan.status, 'repair_unknown_reason');
  assert.strictEqual(plan.patch.discard_reason_code, 'legacy_unstructured_discard');
  assert.strictEqual(plan.patch.discard_stage, 'legacy_unknown');
  assert.strictEqual(plan.patch.discard_confidence, 0);
  assert.strictEqual(plan.patch.resumen, undefined);
  assert.deepStrictEqual(plan.patch.decision_audit.imported_from, 'legacy');
  assert(esDescarteAuditable({ ...alerta, ...plan.patch }));

  const secondPlan = prepararReparacionDescarteHistorico({ ...alerta, ...plan.patch });
  assert.strictEqual(secondPlan.status, 'already_structured');
  assert.strictEqual(secondPlan.patch, null);

  const partialPlan = prepararReparacionDescarteHistorico({
    estado_ia: 'descartado',
    discard_reason: 'Motivo literal conservado por el sistema antiguo.',
  });
  assert.strictEqual(partialPlan.patch.discard_reason_code, 'legacy_unstructured_discard');
  assert.strictEqual(
    partialPlan.patch.discard_reason,
    'Motivo literal conservado por el sistema antiguo.'
  );
});

test('la reparacion reutiliza un motivo deducible conservado en decision_audit', () => {
  const plan = prepararReparacionDescarteHistorico({
    id: 2,
    estado_ia: 'descartado',
    decision_audit: {
      classification: {
        es_relevante: false,
        discard_reason_code: 'actividad_cultural_no_rural',
        discard_reason: 'Premio musical sin alcance agrario.',
        discard_stage: 'classifier_ai',
        discard_confidence: 0.88,
      },
    },
  });

  assert.strictEqual(plan.status, 'repair_deduced_reason');
  assert.strictEqual(plan.patch.discard_reason_code, 'actividad_cultural_no_rural');
  assert.strictEqual(plan.patch.discard_reason, 'Premio musical sin alcance agrario.');
  assert.strictEqual(plan.patch.discard_stage, 'classifier_ai');
  assert.strictEqual(plan.patch.discard_confidence, 0.88);
  assert(esDescarteAuditable({ estado_ia: 'descartado', ...plan.patch }));
});

test('NO IMPORTA por si solo nunca convierte una alerta en descartada', () => {
  const plan = prepararReparacionDescarteHistorico({
    id: 3,
    estado_ia: 'listo',
    resumen: 'NO IMPORTA',
  });

  assert.strictEqual(esAlertaDescartada({ estado_ia: 'listo', resumen: 'NO IMPORTA' }), false);
  assert.deepStrictEqual(plan, { status: 'not_discarded', patch: null });
});

test('la reparacion es dry-run por defecto y --apply escribe solo planes incompletos', async () => {
  const complete = {
    id: 4,
    ...construirDescarteAuditable({
      code: 'sin_senal_rural',
      stage: 'classifier_local',
      confidence: 0.9,
    }),
  };
  const incomplete = { id: 5, estado_ia: 'descartado', resumen: 'NO IMPORTA' };

  assert.deepStrictEqual(parsearArgumentos([]), { dryRun: true, pageSize: 500 });
  assert.deepStrictEqual(
    parsearArgumentos(['--apply', '--page-size=25']),
    { dryRun: false, pageSize: 25 }
  );
  assert.throws(
    () => parsearArgumentos(['--apply', '--limit=20']),
    /--limit ya no existe/
  );

  const drySupabase = crearSupabaseFalso([complete, incomplete]);
  const dryResult = await repararDescartesHistoricos(drySupabase);
  assert.strictEqual(dryResult.mode, 'dry-run');
  assert.strictEqual(dryResult.repairable, 1);
  assert.strictEqual(dryResult.repaired, 0);
  assert.deepStrictEqual(drySupabase.updates, []);

  const applySupabase = crearSupabaseFalso([complete, incomplete]);
  const applyResult = await repararDescartesHistoricos(applySupabase, { dryRun: false });
  assert.strictEqual(applyResult.mode, 'apply');
  assert.strictEqual(applyResult.repaired, 1);
  assert.strictEqual(applySupabase.updates.length, 1);
  assert(esDescarteAuditable({ ...incomplete, ...applySupabase.updates[0] }));

  const paginatedSupabase = crearSupabaseFalso([
    { id: 10, estado_ia: 'descartado' },
    { id: 11, estado_ia: 'descartado' },
    { id: 12, estado_ia: 'descartado' },
  ]);
  const paginatedResult = await repararDescartesHistoricos(paginatedSupabase, {
    dryRun: false,
    pageSize: 1,
  });
  assert.strictEqual(paginatedResult.scanned, 3);
  assert.strictEqual(paginatedResult.repaired, 3);
  assert.strictEqual(paginatedSupabase.updates.length, 3);
});

test('la validacion solo se anuncia tras apply completo y el SQL se protege a si mismo', () => {
  assert.strictEqual(
    puedeValidarConstraint(
      { dryRun: true },
      { repairable: 1, repaired: 1, failed: [] }
    ),
    false
  );
  assert.strictEqual(
    puedeValidarConstraint(
      { dryRun: false },
      { repairable: 2, repaired: 1, failed: [{ id: 9 }] }
    ),
    false
  );
  assert.strictEqual(
    puedeValidarConstraint(
      { dryRun: false },
      { repairable: 2, repaired: 2, failed: [] }
    ),
    true
  );

  const validationSql = fs.readFileSync(path.join(__dirname, '..', VALIDATION_SQL_PATH), 'utf8');
  assert.match(validationSql, /where estado_ia = 'descartado'/);
  assert.match(validationSql, /raise exception/);
  assert.match(
    validationSql,
    /alter table public\.alertas\s+validate constraint alertas_structured_discard_check;/
  );
});

test('ningun productor nuevo puede escribir un descarte o NO IMPORTA fuera del contrato comun', () => {
  const root = path.join(__dirname, '..');
  const files = [
    ...listarJavaScript(path.join(root, 'src')),
    ...listarJavaScript(path.join(root, 'scripts')),
  ];
  const writer = path.normalize(
    path.join(root, 'src', 'modules', 'alertas', 'clasificacion', 'discardDecision.js')
  );
  const stateWriters = [];
  const sentinelWriters = [];
  const sentinelDecisions = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (/estado_ia\s*:\s*['"]descartado['"]/.test(source) && path.normalize(file) !== writer) {
      stateWriters.push(path.relative(root, file));
    }
    if (/resumen\s*:\s*['"]NO IMPORTA['"]/.test(source) && path.normalize(file) !== writer) {
      sentinelWriters.push(path.relative(root, file));
    }
    if (
      /\.neq\(\s*['"]resumen['"]\s*,\s*['"]NO IMPORTA['"]/.test(source)
      || /resumen\s*={2,3}\s*['"]NO IMPORTA['"]/.test(source)
    ) {
      sentinelDecisions.push(path.relative(root, file));
    }
  }

  assert.deepStrictEqual(stateWriters, []);
  assert.deepStrictEqual(sentinelWriters, []);
  assert.deepStrictEqual(sentinelDecisions, []);
});

test('la base de datos rechaza descartes nuevos sin el contrato estructurado', () => {
  const migration = fs.readFileSync(path.join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260720120000_enforce_structured_alert_discards.sql'
  ), 'utf8');

  assert.match(migration, /alertas_structured_discard_check/);
  assert.match(migration, /estado_ia is distinct from 'descartado'/);
  assert.match(migration, /not valid/i);
  for (const field of DISCARD_REQUIRED_FIELDS) {
    assert(migration.includes(field), `la restriccion no cubre ${field}`);
  }
});

(async () => {
  let passed = 0;
  let failed = 0;

  console.log('\n=== TESTS: discard traceability contract ===\n');
  for (const current of tests) {
    try {
      await current.fn();
      passed += 1;
      console.log(`OK: ${current.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL: ${current.name}`);
      console.error(error);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
