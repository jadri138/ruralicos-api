const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DECISION_STATES,
  REASON_CODES,
  createHoldRecoveryState,
  recoverHoldFromStoredMaterial,
} = require('../src/modules/alertas/decision');
const {
  applyRecoveredEvidence,
  loadDueRecoveryRows,
  loadStoredRawDocument,
  processDueEvidenceRecovery,
  processRecoveryQueueRow,
  recoverDecisionHolds,
} = require('../src/modules/digest/decisionEvidenceRecovery');

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

function rawDocumentsSupabase(rows) {
  return {
    from(table) {
      assert.strictEqual(table, 'raw_documents');
      const filters = [];
      return {
        select() { return this; },
        eq(column, value) { filters.push([column, value]); return this; },
        order() { return this; },
        limit() { return this; },
        async maybeSingle() {
          const found = rows.find((row) => filters.every(([column, value]) => (
            String(row[column]) === String(value)
          )));
          return { data: found || null, error: null };
        },
      };
    },
  };
}

async function main() {
  await test('aplica evidencia recuperada con su fragmento y fuente', async () => {
    const patched = applyRecoveredEvidence({}, {
      deadline: {
        value: '2026-09-15',
        fragment: 'PLAZO: 2026-09-15',
        source: 'stored_text:structured',
        confidence: 0.72,
      },
    });
    assert.strictEqual(patched.application_deadline.valor, '2026-09-15');
    assert.strictEqual(patched.application_deadline.status, 'supported');
  });

  await test('HOLD se recupera una vez con material almacenado y queda listo para reevaluar', async () => {
    const stored = [];
    const result = await recoverDecisionHolds({
      supabase: {},
      alertas: [{
        id: 8,
        contenido: 'PLAZO: 2026-09-15\nURL_OFICIAL: https://example.test/8',
        url: 'https://example.test/8',
        fact_sheet: { alerta_id: 8, status: 'insufficient_evidence' },
      }],
      result: {
        holds: [{
          alert_id: 8,
          truth_card: { identity: { content_hash: 'hash-8' } },
          eligibility: {
            state: DECISION_STATES.HOLD_FOR_EVIDENCE,
            reason_codes: [
              REASON_CODES.DEADLINE_EVIDENCE_MISSING,
              REASON_CODES.OFFICIAL_URL_MISSING,
            ],
            trace: { missing_evidence: ['deadline', 'official_url'] },
          },
        }],
      },
      now: new Date('2026-08-01T10:00:00.000Z'),
      loadRowFn: async () => ({
        id: 44,
        alerta_id: 8,
        recovery_attempts: 0,
        fact_sheet: { alerta_id: 8, status: 'insufficient_evidence' },
        shadow_decision: {},
      }),
      persistRowFn: async (_supabase, id, row) => {
        stored.push({ id, row });
        return { ok: true };
      },
    });
    assert.strictEqual(result.reevaluate, true);
    assert.strictEqual(result.recovered, 1);
    assert.strictEqual(result.alertas[0].fact_sheet.status, 'ready_for_digest');
    assert.strictEqual(result.alertas[0].fact_sheet.recovery_state, 'READY_FOR_REEVALUATION');
    assert.strictEqual(stored[0].row.recovery_status, 'RECOVERED');
    assert.strictEqual(stored[0].row.recovery_attempts, 1);
    assert.strictEqual(stored[0].row.shadow_decision.hold_recovery.attempts.length, 1);
  });

  await test('nunca persiste HOLD personales o tÃ©cnicos como recuperaciÃ³n global', async () => {
    let loadCalls = 0;
    let persistCalls = 0;
    let recoveryCalls = 0;
    const technicalReasons = [
      REASON_CODES.LLM_UNAVAILABLE,
      REASON_CODES.LLM_BUDGET_EXHAUSTED,
      REASON_CODES.SECOND_OPINION_DISAGREEMENT,
    ];
    const alertas = technicalReasons.map((reason, index) => ({ id: 100 + index, titulo: reason }));
    const result = await recoverDecisionHolds({
      supabase: {},
      alertas,
      result: {
        holds: technicalReasons.map((reason, index) => ({
          candidate: {
            alert_id: 100 + index,
            eligibility: {
              state: DECISION_STATES.HOLD_FOR_EVIDENCE,
              reason_codes: [reason],
              trace: { missing_evidence: ['deadline'] },
            },
          },
          judged: { decision: { reason_codes: [reason], missing_information: ['evaluaciÃ³n'] } },
          authorized: { state: DECISION_STATES.HOLD_FOR_EVIDENCE, reason_codes: [reason] },
        })),
      },
      loadRowFn: async () => { loadCalls += 1; return null; },
      persistRowFn: async () => { persistCalls += 1; },
      recoverFn: async () => { recoveryCalls += 1; },
    });

    assert.strictEqual(loadCalls, 0);
    assert.strictEqual(persistCalls, 0);
    assert.strictEqual(recoveryCalls, 0);
    assert.strictEqual(result.recovered, 0);
    assert.strictEqual(result.diagnostics.length, technicalReasons.length);
    assert(result.diagnostics.every((item) => (
      item.skipped === true && item.reason === 'hold_not_global_fact_sheet_evidence'
    )));
  });

  await test('la cola consulta solo PENDING/FAILED vencidos y limita el lote', async () => {
    const trace = {};
    const supabase = {
      from(table) {
        trace.table = table;
        return {
          select(value) { trace.select = value; return this; },
          in(column, values) { trace.in = [column, values]; return this; },
          lte(column, value) { trace.lte = [column, value]; return this; },
          order(column) { (trace.order ||= []).push(column); return this; },
          limit(value) {
            trace.limit = value;
            return Promise.resolve({ data: [{ id: 1, alerta_id: 9 }], error: null });
          },
        };
      },
    };
    const rows = await loadDueRecoveryRows(supabase, {
      now: new Date('2026-08-02T08:00:00.000Z'),
      limit: 500,
    });
    assert.strictEqual(trace.table, 'alert_fact_sheets');
    assert.deepStrictEqual(trace.in, ['recovery_status', ['PENDING', 'FAILED']]);
    assert.deepStrictEqual(trace.lte, ['recovery_next_at', '2026-08-02T08:00:00.000Z']);
    assert.strictEqual(trace.limit, 50);
    assert.strictEqual(rows.length, 1);
  });

  await test('carga raw_documents por stored_document_id y valida que pertenezca a la alerta', async () => {
    const supabase = rawDocumentsSupabase([
      { id: 70, inserted_alerta_id: 5, texto_raw: 'documento incorrecto' },
      { id: 71, inserted_alerta_id: 9, texto_raw: 'PLAZO: 2026-09-20' },
    ]);
    const loaded = await loadStoredRawDocument(supabase, {
      alerta_id: 9,
      fact_sheet: { raw_document_id: 71 },
    });
    assert.strictEqual(loaded.rawDocument.id, 71);
    assert.strictEqual(loaded.lookup, 'stored_document_id');
  });

  await test('si no hay id almacenado usa raw_documents.inserted_alerta_id', async () => {
    const supabase = rawDocumentsSupabase([
      { id: 80, inserted_alerta_id: 12, texto_raw: 'BENEFICIARIOS: explotaciones agrarias' },
    ]);
    const loaded = await loadStoredRawDocument(supabase, { alerta_id: 12, fact_sheet: {} });
    assert.strictEqual(loaded.rawDocument.id, 80);
    assert.strictEqual(loaded.lookup, 'inserted_alerta_id');
  });

  await test('el worker recupera material raw ya guardado antes de preparar el digest', async () => {
    const row = {
      id: 20,
      alerta_id: 9,
      recovery_status: 'PENDING',
      recovery_attempts: 0,
      recovery_missing_fields: ['deadline'],
      recovery_next_at: '2026-08-02T07:00:00.000Z',
      fact_sheet: { alerta_id: 9, status: 'insufficient_evidence', raw_document_id: 71 },
      shadow_decision: {},
    };
    const persisted = [];
    const result = await processDueEvidenceRecovery({
      supabase: {},
      now: new Date('2026-08-02T08:00:00.000Z'),
      limit: 25,
      concurrency: 2,
      requeueStaleFn: async () => 0,
      loadRowsFn: async () => [row],
      workerOptions: {
        claimRowFn: async () => ({ ...row, recovery_status: 'PROCESSING' }),
        loadContextFn: async () => ({
          alerta: { id: 9, fact_sheet: row.fact_sheet },
          candidate: { alert_id: 9, truth_card: { identity: { document_id: 71 } } },
          material: {
            text: 'PLAZO: 2026-09-20',
            alert: { id: 9 },
            stored_document_id: 71,
            content_hash: 'hash-raw-71',
          },
          warnings: [],
          raw_lookup: 'stored_document_id',
        }),
        persistRowFn: async (_supabase, id, patch) => persisted.push({ id, patch }),
      },
    });
    assert.strictEqual(result.processed, 1);
    assert.strictEqual(result.has_more, false);
    assert.strictEqual(result.recovered, 1);
    assert.strictEqual(persisted[0].patch.recovery_status, 'RECOVERED');
    assert.strictEqual(persisted[0].patch.status, 'ready_for_digest');
    assert.strictEqual(persisted[0].patch.fact_sheet.recovery_state, 'READY_FOR_REEVALUATION');
    assert.strictEqual(persisted[0].patch.fact_sheet.application_deadline.valor, '2026-09-20');
  });

  await test('seÃ±ala has_more tras un lote completo y finaliza con lote corto', async () => {
    const processRowFn = async ({ row }) => ({ alert_id: row.alerta_id, status: 'PENDING' });
    const common = {
      supabase: {},
      limit: 2,
      concurrency: 1,
      requeueStaleFn: async () => 0,
      processRowFn,
    };
    const full = await processDueEvidenceRecovery({
      ...common,
      loadRowsFn: async () => [
        { id: 1, alerta_id: 1 },
        { id: 2, alerta_id: 2 },
        { id: 99, alerta_id: 99 },
      ],
    });
    const short = await processDueEvidenceRecovery({
      ...common,
      loadRowsFn: async () => [{ id: 3, alerta_id: 3 }],
    });

    assert.strictEqual(full.processed, 2);
    assert.strictEqual(full.has_more, true);
    assert.strictEqual(short.processed, 1);
    assert.strictEqual(short.has_more, false);
  });

  await test('conserva evidencia parcial entre estrategias y solo reevalúa al completar', async () => {
    let row = {
      id: 21,
      alerta_id: 10,
      recovery_status: 'PENDING',
      recovery_attempts: 0,
      recovery_missing_fields: ['deadline', 'beneficiaries'],
      recovery_next_at: '2026-08-02T08:00:00.000Z',
      fact_sheet: { alerta_id: 10, status: 'insufficient_evidence' },
      shadow_decision: {},
    };
    const material = {
      text: 'PLAZO: 2026-09-30\nLa convocatoria está dirigida a beneficiarios que sean titulares de explotaciones.',
      alert: { id: 10 },
      stored_document_id: 72,
      content_hash: 'hash-raw-72',
    };
    const run = async (now) => {
      let patch = null;
      const result = await processRecoveryQueueRow({
        supabase: {},
        row,
        now,
        claimRowFn: async () => ({ ...row, recovery_status: 'PROCESSING' }),
        loadContextFn: async () => ({
          alerta: { id: 10, fact_sheet: row.fact_sheet },
          candidate: { alert_id: 10, truth_card: { identity: { document_id: 72 } } },
          material,
          warnings: [],
          raw_lookup: 'stored_document_id',
        }),
        persistRowFn: async (_supabase, _id, value) => { patch = value; },
      });
      row = { ...row, ...patch };
      return result;
    };

    const first = await run(new Date('2026-08-02T08:00:00.000Z'));
    assert.strictEqual(first.status, 'PENDING');
    assert.strictEqual(row.fact_sheet.application_deadline.valor, '2026-09-30');
    assert.strictEqual(row.fact_sheet.beneficiarios, undefined);

    const second = await run(new Date('2026-08-02T08:16:00.000Z'));
    assert.strictEqual(second.status, 'RECOVERED');
    assert.strictEqual(row.fact_sheet.application_deadline.valor, '2026-09-30');
    assert(row.fact_sheet.beneficiarios.valor.includes('beneficiarios'));
    assert.strictEqual(row.fact_sheet.recovery_state, 'READY_FOR_REEVALUATION');
  });

  await test('sin material aplica backoff, no consume estrategias y termina EXHAUSTED', async () => {
    let state = createHoldRecoveryState({
      candidate: { alert_id: 30 },
      missingFields: ['territory'],
      now: new Date('2026-08-02T08:00:00.000Z'),
    });
    for (const now of [
      new Date('2026-08-02T08:00:00.000Z'),
      new Date('2026-08-02T08:16:00.000Z'),
      new Date('2026-08-02T10:17:00.000Z'),
    ]) {
      const recovery = await recoverHoldFromStoredMaterial({ state, storedMaterial: {}, now });
      state = recovery.state;
    }
    assert.strictEqual(state.exhausted, true);
    assert.strictEqual(state.next_attempt_at, null);
    assert.strictEqual(state.attempts.length, 3);
    assert(state.attempts.every((attempt) => attempt.strategy === 'stored_material_lookup'));
    assert(state.attempts.every((attempt) => attempt.counts_toward_strategy_limit === false));
  });

  await test('un HOLD sin campos recuperables se agota de forma segura y nunca se aprueba', async () => {
    const state = createHoldRecoveryState({
      candidate: { alert_id: 32 },
      missingFields: [],
      now: new Date('2026-08-02T08:00:00.000Z'),
    });
    const recovery = await recoverHoldFromStoredMaterial({
      state,
      storedMaterial: { text: 'Documento almacenado sin un objetivo de recuperación concreto.' },
      now: new Date('2026-08-02T08:00:00.000Z'),
    });
    assert.strictEqual(recovery.plan.scheduled, false);
    assert.strictEqual(recovery.state.exhausted, true);
    assert.notStrictEqual(recovery.state.status, 'READY_FOR_REEVALUATION');
  });

  await test('si aparece material después de un lookup empieza por la primera estrategia real', async () => {
    const initialState = createHoldRecoveryState({
      candidate: { alert_id: 31 },
      missingFields: ['deadline'],
      now: new Date('2026-08-02T08:00:00.000Z'),
    });
    const missing = await recoverHoldFromStoredMaterial({
      state: initialState,
      storedMaterial: {},
      now: new Date('2026-08-02T08:00:00.000Z'),
    });
    let row = {
      id: 31,
      alerta_id: 31,
      recovery_status: 'PENDING',
      recovery_attempts: 1,
      recovery_strategy: 'stored_material_lookup',
      recovery_missing_fields: ['deadline'],
      recovery_next_at: missing.state.next_attempt_at,
      fact_sheet: { alerta_id: 31, status: 'insufficient_evidence' },
      shadow_decision: { hold_recovery: missing.state },
    };
    let patch = null;
    const result = await processRecoveryQueueRow({
      supabase: {},
      row,
      now: new Date('2026-08-02T08:16:00.000Z'),
      claimRowFn: async () => ({ ...row, recovery_status: 'PROCESSING' }),
      loadContextFn: async () => ({
        alerta: { id: 31, fact_sheet: row.fact_sheet },
        candidate: { alert_id: 31, truth_card: { identity: { document_id: 90 } } },
        material: { text: 'PLAZO: 2026-10-01', alert: { id: 31 }, stored_document_id: 90 },
        warnings: [],
        raw_lookup: 'stored_document_id',
      }),
      persistRowFn: async (_supabase, _id, value) => { patch = value; },
    });
    row = { ...row, ...patch };
    assert.strictEqual(result.status, 'RECOVERED');
    assert.strictEqual(result.strategy, 'structured_reparse');
    assert.deepStrictEqual(
      row.shadow_decision.hold_recovery.attempts.map((attempt) => attempt.strategy),
      ['stored_material_lookup', 'structured_reparse'],
    );
  });

  await test('fallos técnicos de carga persisten FAILED y acaban EXHAUSTED sin marcar irrelevancia', async () => {
    let row = {
      id: 50,
      alerta_id: 40,
      recovery_status: 'PENDING',
      recovery_attempts: 0,
      recovery_missing_fields: ['beneficiaries'],
      recovery_next_at: '2026-08-02T08:00:00.000Z',
      fact_sheet: { alerta_id: 40, status: 'insufficient_evidence' },
      shadow_decision: {},
    };
    const statuses = [];
    for (const now of [
      new Date('2026-08-02T08:00:00.000Z'),
      new Date('2026-08-02T08:16:00.000Z'),
      new Date('2026-08-02T10:17:00.000Z'),
    ]) {
      let patch = null;
      const result = await processRecoveryQueueRow({
        supabase: {},
        row,
        now,
        claimRowFn: async () => ({ ...row, recovery_status: 'PROCESSING' }),
        loadContextFn: async () => { throw new TypeError('fallo simulado'); },
        persistRowFn: async (_supabase, _id, value) => { patch = value; },
      });
      statuses.push(result.status);
      row = { ...row, ...patch };
    }
    assert.deepStrictEqual(statuses, ['FAILED', 'FAILED', 'EXHAUSTED']);
    assert.strictEqual(row.recovery_next_at, null);
    assert.strictEqual(row.fact_sheet.status, 'insufficient_evidence');
    assert.strictEqual(row.shadow_decision.hold_recovery.attempts.length, 3);
  });

  await test('el worker no importa WhatsApp ni puede enviar mensajes', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'modules', 'digest', 'decisionEvidenceRecovery.js'),
      'utf8',
    );
    assert(!source.includes("require('../../platform/whatsapp"));
    assert(!source.includes('enviarWhatsApp'));
    assert(!source.includes('fetch('));
    assert(!source.includes('/boletines/'));
  });

  await test('el endpoint del worker exige CRON_TOKEN', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'modules', 'tareas', 'tareas.routes.js'),
      'utf8',
    );
    const routeIndex = source.indexOf("app.post('/tareas/hold-evidence-recovery'");
    const authIndex = source.indexOf('if (!checkCronToken(req, res)) return;', routeIndex);
    assert(routeIndex > 0);
    assert(authIndex > routeIndex && authIndex < routeIndex + 220);
  });

  console.log(`\nResultados decisionEvidenceRecovery: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
