const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  runOfflineReplay,
  validateReplayCorpus,
} = require('../src/modules/alertas/decision/replay');
const {
  gradeReplayReport,
  validateAuxiliaryGrade,
} = require('../src/modules/alertas/decision/replayGrader');
const {
  SELECTS,
  buildHistoricalReplayCorpus,
  collectHistoricalReplayRows,
  inspectHistoricalExporterSource,
} = require('../src/modules/alertas/decision/replaySnapshotExporter');

const fixturePath = path.join(__dirname, 'fixtures', 'decision', 'golden-corpus.json');
const exporterPath = path.join(
  __dirname,
  '..',
  'src',
  'modules',
  'alertas',
  'decision',
  'replaySnapshotExporter.js'
);
const exporterScript = path.join(__dirname, '..', 'scripts', 'export_alert_decision_replay_snapshots.js');
const graderScript = path.join(__dirname, '..', 'scripts', 'grade_alert_decision_replay.js');
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

class FakeQuery {
  constructor(rows, log) {
    this.rows = rows;
    this.log = log;
    this.filters = [];
    this.slice = [0, Number.MAX_SAFE_INTEGER];
    this.ordering = null;
  }

  select(fields) {
    this.log.push({ method: 'select', fields });
    return this;
  }

  gte(column, value) {
    this.log.push({ method: 'gte', column, value });
    this.filters.push((row) => String(row[column] || '') >= String(value));
    return this;
  }

  lte(column, value) {
    this.log.push({ method: 'lte', column, value });
    this.filters.push((row) => String(row[column] || '') <= String(value));
    return this;
  }

  in(column, values) {
    this.log.push({ method: 'in', column });
    const allowed = new Set(values.map(String));
    this.filters.push((row) => allowed.has(String(row[column])));
    return this;
  }

  order(column, options) {
    this.log.push({ method: 'order', column, options });
    this.ordering = { column, ascending: options?.ascending !== false };
    return this;
  }

  range(from, to) {
    this.log.push({ method: 'range', from, to });
    this.slice = [from, to + 1];
    return this;
  }

  then(resolve, reject) {
    try {
      let values = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
      if (this.ordering) {
        const direction = this.ordering.ascending ? 1 : -1;
        values = [...values].sort((a, b) => (
          String(a[this.ordering.column] || '').localeCompare(String(b[this.ordering.column] || ''))
          * direction
        ));
      }
      resolve({ data: values.slice(...this.slice), error: null });
    } catch (error) {
      reject(error);
    }
  }
}

function fakeClient(tables) {
  const log = [];
  return {
    log,
    from(table) {
      log.push({ method: 'from', table });
      return new FakeQuery(tables[table] || [], log);
    },
  };
}

function historicalRows() {
  return {
    decisions: [{
      id: 7001,
      user_id: 81,
      alerta_id: 91,
      fecha: '2026-07-03',
      stage: 'personal_relevance_judge',
      action: 'include',
      decision_state: 'ADD_TO_DIGEST',
      reason_codes: ['APPROVED_DIGEST'],
      decision_json: {},
      metadata_json: {},
      llm_calls: 1,
      digest_id: 501,
      created_at: '2026-07-03T10:00:00.000Z',
    }],
    users: [{
      id: 81,
      phone: '612345678',
      email: 'persona@example.com',
      name: 'Persona Real',
      subscription: 'premium',
      preferences: {
        provincias: ['Teruel'],
        sectores: ['agricultura'],
        intereses: ['persona@example.com', 'regadio'],
        comentario_privado: 'No debe salir',
      },
      created_at: '2026-01-01T00:00:00.000Z',
    }],
    alerts: [{
      id: 91,
      titulo: 'Ayuda para regadio de Teruel',
      resumen_final: 'Contactar con Doña Maria Lopez, DNI 12345678Z, telefono 612 345 678.',
      contenido: 'Texto original que no debe salir',
      url: 'https://example.invalid/alerta/91?token=secreto',
      fecha: '2026-07-03',
      region: 'Aragon',
      provincias: ['Teruel'],
      sectores: ['agricultura'],
      subsectores: ['regadio'],
      tipos_alerta: ['ayuda'],
      fuente: 'BOA',
      taxonomy_tags: ['regadio'],
      created_at: '2026-07-03T07:00:00.000Z',
    }],
    factSheets: [{
      id: 301,
      alerta_id: 91,
      status: 'ready_for_digest',
      fact_sheet: {
        tema_principal: { valor: 'modernizacion de regadio' },
        resumen_neutro: { valor: 'Ayuda agraria estructurada.' },
        beneficiarios: { valor: 'Explotaciones agrarias.' },
        accion_requerida: { valor: 'Presentar solicitud.' },
        accion_codigo: { valor: 'solicitar' },
        application_deadline: { valor: '2026-08-30' },
        importe: { valor: 'Hasta 10000 euros' },
        requisitos: [{ valor: 'Explotacion registrada.' }],
      },
      flags: [],
      reasons: [],
      generated_at: '2026-07-03T08:00:00.000Z',
      created_at: '2026-07-03T08:00:00.000Z',
    }],
    digests: [{
      id: 501,
      user_id: 81,
      fecha: '2026-07-03',
      alerta_ids: [91],
      mensaje: 'Hola Persona Real, mensaje privado',
      enviado: true,
      created_at: '2026-07-03T12:00:00.000Z',
    }],
    feedback: [{
      id: 601,
      user_id: 81,
      alerta_id: 91,
      digest_id: 501,
      valor: 1,
      feedback_category: 'useful',
      feedback_confidence: 0.95,
      raw_text: 'Mi correo es persona@example.com',
      created_at: '2026-07-04T09:00:00.000Z',
    }],
    clicks: [{
      id: 701,
      user_id: 81,
      alerta_id: 91,
      digest_id: 501,
      token: 'secreto',
      ip_hash: 'privado',
      created_at: '2026-07-05T09:00:00.000Z',
    }],
    memories: [{
      id: 801,
      user_id: 81,
      alerta_id: 91,
      contenido: 'persona@example.com',
      memory_key: 'regadio',
      scope_type: 'topic',
      scope_value: 'regadio',
      polarity: 'positive',
      source: 'feedback',
      strength: 0.9,
      confidence: 0.9,
      status: 'active',
      created_at: '2026-07-04T10:00:00.000Z',
    }],
  };
}

test('reproduce todos los dias y aplica señales solo a fechas posteriores', async () => {
  const report = await runOfflineReplay(corpus);
  assert.strictEqual(report.period.distinct_days, report.period.span_days);
  assert(report.period.span_days >= 22);
  assert.strictEqual(report.timeline.length, report.period.span_days);

  const sameDay = resultById(report, 'other-province-hard-block');
  assert.strictEqual(sameDay.history.memory_before_count, 0);
  const nextWeek = resultById(report, 'national-pac-opportunity');
  assert(nextWeek.history.memory_before.some((memory) => (
    memory.source === 'feedback' && memory.key === '9101'
  )));
  assert(nextWeek.history.memory_before.some((memory) => (
    memory.source === 'click' && memory.key === '9101'
  )));
  assert(report.metrics.memory.effects_applied >= 6);
  assert(report.metrics.memory.cases_with_prior_memory > 0);
  assert(report.timeline.some((day) => day.date === '2026-07-04'
    && day.memory_effects_applied.length > 0));
});

test('compara mensajes actuales, propuestos y ausentes de forma explicita', async () => {
  const report = await runOfflineReplay(corpus);
  const comparable = resultById(report, 'relevant-teruel-aid');
  assert.strictEqual(comparable.message_comparison.state, 'changed');
  assert.strictEqual(comparable.message_comparison.exact_match, false);
  assert(report.metrics.messages.current_available >= 1);
  assert(report.metrics.messages.proposed_available >= 1);
});

test('el grader LLM esta apagado por defecto y una simulacion nunca cambia la aceptacion', async () => {
  const disabled = await runOfflineReplay(corpus);
  assert.strictEqual(disabled.auxiliary_grader.status, 'disabled');
  assert.strictEqual(disabled.auxiliary_grader.affects_acceptance, false);
  let calls = 0;
  const before = JSON.stringify(disabled.acceptance);
  const graded = await gradeReplayReport(disabled, {
    enabled: true,
    caller: async ({ input, schema }) => {
      calls += 1;
      assert(input.cases.length === corpus.cases.length);
      assert.strictEqual(schema.strict, true);
      assert.strictEqual(schema.schema.additionalProperties, false);
      return {
        parsed: {
          score: 0.91,
          severity: 'low',
          summary: 'No se observan anomalías graves en la simulación.',
          anomalies: [],
        },
        metadata: { model: 'fake-local-grader' },
      };
    },
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(graded.status, 'completed');
  assert.strictEqual(graded.affects_acceptance, false);
  assert.strictEqual(JSON.stringify(disabled.acceptance), before);
  assert.deepStrictEqual(validateAuxiliaryGrade(graded.grade), { valid: true, errors: [] });

  const integrated = await runOfflineReplay(corpus, {
    auxiliaryGrader: {
      enabled: true,
      caller: async () => ({
        parsed: {
          score: 0.8,
          severity: 'none',
          summary: 'Señal auxiliar simulada.',
          anomalies: [],
        },
      }),
    },
  });
  assert.strictEqual(integrated.auxiliary_grader.status, 'completed');
  assert.strictEqual(integrated.acceptance.passed, true);

  const failedAuxiliary = await runOfflineReplay(corpus, {
    auxiliaryGrader: {
      enabled: true,
      caller: async () => {
        throw new Error('fallo simulado');
      },
    },
  });
  assert.strictEqual(failedAuxiliary.auxiliary_grader.status, 'failed');
  assert.strictEqual(failedAuxiliary.acceptance.passed, true);
});

test('el constructor historico elimina PII y produce un corpus reproducible', async () => {
  const rows = historicalRows();
  const built = buildHistoricalReplayCorpus(rows, {
    from: '2026-07-03',
    to: '2026-07-24',
    signalThrough: '2026-08-07',
    generatedAt: '2026-08-02T10:00:00.000Z',
    salt: 'sal-local-de-pruebas-muy-larga',
  });
  assert.strictEqual(validateReplayCorpus(built, { strictGolden: false }).valid, true);
  assert.strictEqual(built.cases.length, 1);
  assert.strictEqual(built.profiles.length, 1);
  assert.strictEqual(built.cases[0].observed.feedback.recorded_at, '2026-07-04T09:00:00.000Z');
  assert.strictEqual(built.cases[0].observed.clicked_at, '2026-07-05T09:00:00.000Z');
  assert.strictEqual(built.cases[0].current.message_available, true);
  assert(/^\[mensaje_historico:digest_[a-f0-9]+\]$/.test(built.cases[0].current.message));
  const serialized = JSON.stringify(built);
  assert(!/persona@example\.com|612(?:\s)?345(?:\s)?678|12345678Z|Persona Real|token=secreto/.test(serialized));
  assert(!/comentario_privado|raw_text|ip_hash|"contenido"|"mensaje"\s*:/.test(serialized));
  const report = await runOfflineReplay(built, { strictGolden: false, metamorphic: false });
  assert.strictEqual(report.mode, 'offline_read_only');
  assert.strictEqual(report.acceptance.passed, true);
});

test('el colector usa solo lecturas Supabase y columnas permitidas', async () => {
  const rows = historicalRows();
  const client = fakeClient({
    digest_candidate_decisions: rows.decisions,
    users: rows.users,
    alertas: rows.alerts,
    alert_fact_sheets: rows.factSheets,
    digests: rows.digests,
    alerta_feedback: rows.feedback,
    alerta_clicks: rows.clicks,
    user_memory: rows.memories,
  });
  const originalFetch = global.fetch;
  let networkCalls = 0;
  global.fetch = async () => {
    networkCalls += 1;
    throw new Error('Red no permitida');
  };
  let collected;
  try {
    collected = await collectHistoricalReplayRows({
      client,
      from: '2026-07-03',
      to: '2026-07-24',
      signalThrough: '2026-08-07T23:59:59.999Z',
      pageSize: 10,
      maxRows: 100,
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.strictEqual(networkCalls, 0);
  assert.strictEqual(collected.decisions.length, 1);
  assert(client.log.every((entry) => !['insert', 'upsert', 'update', 'delete', 'rpc'].includes(entry.method)));
  const selections = Object.values(SELECTS).join(',');
  assert(!/raw_text|token|user_agent|referer|ip_hash|phone|email|name|contenido|mensaje/i.test(selections));
  const inspection = inspectHistoricalExporterSource(fs.readFileSync(exporterPath, 'utf8'));
  assert.strictEqual(inspection.safe, true, JSON.stringify(inspection));
});

test('los dos comandos sensibles muestran ayuda sin credenciales ni red', () => {
  for (const script of [exporterScript, graderScript]) {
    const execution = spawnSync(process.execPath, [script, '--help'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });
    assert.strictEqual(execution.status, 0, execution.stderr || execution.stdout);
    assert(/Uso:/.test(execution.stdout));
  }
});

(async () => {
  let passed = 0;
  let failed = 0;
  console.log('\n=== TESTS: alert decision historical replay ===\n');
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
