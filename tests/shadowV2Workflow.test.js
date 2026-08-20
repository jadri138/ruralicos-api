const assert = require('assert');
const corpus = require('./fixtures/shadow-v2/corpus.json');
const { normalizeLimits } = require('../src/modules/alertas/shadow-v2/config');
const { hasExpiredDeadline, runShadowV2Workflow } = require('../src/modules/alertas/shadow-v2/workflow');
const repository = require('../src/modules/alertas/shadow-v2/repository');

function createMemoryRepo() {
  const state = { classifications: [], digestRuns: [], digestItems: [], limitEvents: [] };
  const alerts = corpus.accepted_by_ai1.slice(0, 3).map((item) => ({
    id: item.id,
    titulo: item.title,
    url: `https://example.test/${item.id}`,
    fecha: '2026-08-12',
    region: item.ai1.territories.regions[0],
    fuente: 'BOLETIN',
    contenido: item.official_content,
    duplicado_de: null,
  }));
  const users = [
    {
      id: 1,
      name: 'Ganadera fixture',
      phone: '000000001',
      email: 'fixture1@example.test',
      subscription: 'corral',
      preferences: {
        provincias: ['Asturias', 'Huesca', 'Segovia'],
        actividades: [],
        tipos_beneficiario: [],
      },
      preferencias_extra: null,
    },
    {
      id: 2,
      name: 'Agricultor fixture',
      phone: '000000002',
      email: 'fixture2@example.test',
      subscription: 'agricultor',
      preferences: {
        provincias: ['Huesca'],
        actividades: ['frutales'],
        tipos_beneficiario: ['agricultor'],
      },
      preferencias_extra: null,
    },
  ];
  const cards = new Map(corpus.accepted_by_ai1.map((item) => [item.id, item.ai1]));
  return {
    state,
    cards,
    repo: {
      async loadExistingClassificationIds(_db, runKey) {
        return new Set(state.classifications.filter((row) => row.workflow_run_key === runKey).map((row) => row.alert_id));
      },
      async loadAlerts() { return alerts; },
      async loadOfficialDocuments() { return new Map(); },
      officialSnapshot(alert, _document, maxChars) {
        return {
          alert_id: alert.id,
          title: alert.titulo,
          organization: 'Consejería de Agricultura',
          source: alert.fuente,
          date: alert.fecha,
          official_url: alert.url,
          official_content: alert.contenido.slice(0, maxChars),
          official_content_original_chars: alert.contenido.length,
          official_content_truncated: alert.contenido.length > maxChars,
          duplicate_of: null,
        };
      },
      async insertClassification(_db, row) { state.classifications.push(row); },
      async loadSuccessfulClassifications(_db, runKey) {
        return state.classifications
          .filter((row) => row.workflow_run_key === runKey && row.status === 'SUCCESS')
          .map((row) => ({
            alert_id: row.alert_id,
            official_snapshot: row.official_snapshot,
            card: row.normalized_response,
            send_gate: row.classification?.send_gate || null,
          }));
      },
      async loadExistingDigestUserIds(_db, runKey) {
        return new Set(state.digestRuns.filter((row) => row.workflow_run_key === runKey).map((row) => row.user_id));
      },
      async loadUsers() { return users; },
      async loadSentHistory(_db, userIds) {
        return new Map(userIds.map((id) => [id, id === 2 ? new Set([202]) : new Set()]));
      },
      async recordLimitEvent(_db, event) { state.limitEvents.push(event); },
      async insertDigestRun(_db, row, items) {
        const id = `run-${state.digestRuns.length + 1}`;
        state.digestRuns.push({ ...row, id });
        state.digestItems.push(...items.map((item) => ({ ...item, shadow_digest_run_id: id })));
        return id;
      },
    },
  };
}

function aiResultFor(card) {
  return {
    status: 'SUCCESS',
    called: true,
    model: 'gpt-5-nano',
    prompt: 'prompt IA 1',
    rawResponse: JSON.stringify(card),
    normalizedResponse: card,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    durationMs: 5,
    error: null,
  };
}

async function main() {
  assert.strictEqual(hasExpiredDeadline({ card: { deadline: '2026-08-11' } }, '2026-08-12'), true);
  assert.strictEqual(hasExpiredDeadline({ card: { deadline: '2026-08-12' } }, '2026-08-12'), false);
  assert.strictEqual(hasExpiredDeadline({ card: { deadline: null } }, '2026-08-12'), false);

  const memory = createMemoryRepo();
  let ai1Calls = 0;
  let ai2Calls = 0;
  const silent = { info() {} };
  const runKey = '11111111-1111-4111-8111-111111111111';
  const options = {
    supabase: {},
    workflowRunKey: runKey,
    workflowDate: '2026-08-12',
    limitOverrides: { maxAlerts: 10, maxUsers: 10, maxCandidatesPerUser: 1, maxTotalCalls: 10 },
    repo: memory.repo,
    logger: silent,
    callAi1: async ({ officialSnapshot }) => {
      ai1Calls += 1;
      return aiResultFor(memory.cards.get(officialSnapshot.alert_id));
    },
    callAi2: async ({ candidates }) => {
      ai2Calls += 1;
      const selected = candidates.map((candidate) => ({
        alert_id: candidate.alert_id,
        reason: 'Puede solicitarlo o está directamente afectada según perfil y ficha.',
        level: 'priority',
      }));
      return {
        status: selected.length > 0 ? 'GENERATED' : 'EMPTY',
        called: true,
        model: 'gpt-5.6-luna',
        prompt: 'prompt IA 2',
        rawResponse: JSON.stringify({ selected, message: 'Digest fixture' }),
        normalizedResponse: { selected, message: 'Digest fixture' },
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        durationMs: 7,
        error: null,
      };
    },
  };

  const first = await runShadowV2Workflow(options);
  assert.strictEqual(first.stopped, null);
  assert.strictEqual(ai1Calls, 3);
  assert.strictEqual(ai2Calls, 1, 'el historial evita la única candidata del segundo usuario');
  assert.strictEqual(memory.state.classifications.length, 3);
  assert.strictEqual(memory.state.classifications[0].classification.send_gate.allowed, true);
  assert.strictEqual(first.ai2.sendGateBlocked, 0);
  assert.strictEqual(memory.state.digestRuns.length, 2);
  assert.strictEqual(memory.state.digestItems.length, 1);
  assert.strictEqual(memory.state.digestRuns[1].status, 'NO_CANDIDATES');
  assert.strictEqual(memory.state.digestRuns[0].profile_snapshot.phone, '000000001');
  assert.deepStrictEqual(memory.state.digestRuns[0].already_sent_alert_ids, []);
  assert.strictEqual(memory.state.digestRuns[0].candidate_alert_ids.length, 3);
  assert.strictEqual(memory.state.digestRuns[0].candidate_cards.length, 1);
  assert.strictEqual(memory.state.digestRuns[0].candidate_overflow_count, 2);
  assert.strictEqual(memory.state.digestRuns[0].usage_json.calls, 1);
  assert.strictEqual(memory.state.digestRuns[0].normalized_response.selected[0].level, 'priority');
  assert.strictEqual(
    memory.state.digestItems[0].title_used,
    memory.state.digestRuns[0].candidate_cards[0].official_snapshot.title,
    'el titulo persistido debe proceder de la candidata seleccionada'
  );
  assert(memory.state.digestRuns[0].usage_json.prompt_chars > 0);
  assert(memory.state.digestRuns[0].digest_preview.startsWith('¡Hola, Ganadera! 👋'));
  assert(memory.state.digestRuns[0].digest_preview.includes(
    '¿Qué te parece esta alerta? Responde brevemente para que el sistema aprenda tus intereses.'
  ));
  assert(memory.state.digestRuns[0].digest_preview.includes('🔗 *Fuente oficial:* https://example.test/201'));
  assert.strictEqual(memory.state.classifications[0].usage_json.calls, 1);
  assert(memory.state.classifications[0].usage_json.official_content_chars > 0);

  const second = await runShadowV2Workflow(options);
  assert.strictEqual(second.calls, 0);
  assert.strictEqual(ai1Calls, 3, 'misma run key no reclasifica alertas');
  assert.strictEqual(ai2Calls, 1, 'misma run key no repite usuarios');
  assert.strictEqual(memory.state.classifications.length, 3);
  assert.strictEqual(memory.state.digestRuns.length, 2);

  const emptyMemory = createMemoryRepo();
  let emptyAi2Calls = 0;
  await runShadowV2Workflow({
    ...options,
    workflowRunKey: '33333333-3333-4333-8333-333333333333',
    repo: emptyMemory.repo,
    callAi1: async ({ officialSnapshot }) => aiResultFor(
      emptyMemory.cards.get(officialSnapshot.alert_id)
    ),
    callAi2: async () => {
      emptyAi2Calls += 1;
      return {
        status: 'EMPTY',
        called: true,
        model: 'gpt-5.6-luna',
        prompt: 'prompt IA 2',
        rawResponse: '{"selected":[],"message":""}',
        normalizedResponse: { selected: [], message: '' },
        usage: null,
        durationMs: 1,
        error: null,
      };
    },
  });
  assert.strictEqual(emptyAi2Calls, 1);
  assert.strictEqual(emptyMemory.state.digestRuns[0].status, 'ERROR');
  assert.strictEqual(emptyMemory.state.digestRuns[0].error_code, 'ai2_empty_selection');
  assert.strictEqual(emptyMemory.state.digestRuns[1].status, 'NO_CANDIDATES');
  assert.strictEqual(emptyMemory.state.digestItems.length, 0);

  const blockedMemory = createMemoryRepo();
  for (const [alertId, card] of blockedMemory.cards) {
    blockedMemory.cards.set(alertId, { ...card, relevant: false });
  }
  let blockedAi2Calls = 0;
  const blockedRun = await runShadowV2Workflow({
    ...options,
    workflowRunKey: '44444444-4444-4444-8444-444444444444',
    repo: blockedMemory.repo,
    callAi1: async ({ officialSnapshot }) => aiResultFor(
      blockedMemory.cards.get(officialSnapshot.alert_id)
    ),
    callAi2: async () => {
      blockedAi2Calls += 1;
      throw new Error('IA 2 no debe recibir candidatas bloqueadas');
    },
  });
  assert.strictEqual(blockedRun.ai2.sendGateBlocked, 3);
  assert.strictEqual(blockedAi2Calls, 0);
  assert(blockedMemory.state.digestRuns.every((run) => run.status === 'NO_CANDIDATES'));

  const limitedMemory = createMemoryRepo();
  let limitedCalls = 0;
  const limited = await runShadowV2Workflow({
    ...options,
    workflowRunKey: '22222222-2222-4222-8222-222222222222',
    repo: limitedMemory.repo,
    limitOverrides: { maxAlerts: 10, maxUsers: 10, maxTotalCalls: 1 },
    callAi1: async ({ officialSnapshot }) => {
      limitedCalls += 1;
      return aiResultFor(limitedMemory.cards.get(officialSnapshot.alert_id));
    },
  });
  assert.strictEqual(limited.stopped, 'max_total_calls');
  assert.strictEqual(limitedCalls, 1);
  assert.strictEqual(limitedMemory.state.classifications.length, 1);
  assert.strictEqual(limitedMemory.state.digestRuns.length, 0);
  assert.strictEqual(limitedMemory.state.limitEvents.length, 1);
  assert.strictEqual(limitedMemory.state.limitEvents[0].reason, 'max_total_calls');

  let cleanupCalls = 0;
  const failingDb = {
    from(table) {
      if (table === repository.TABLES.digestRuns) {
        return {
          insert() {
            return { select() { return { async single() { return { data: { id: 'partial-run' }, error: null }; } }; } };
          },
          delete() {
            return { async eq() { cleanupCalls += 1; return { error: null }; } };
          },
        };
      }
      if (table === repository.TABLES.digestItems) {
        return { async insert() { return { error: { code: 'fixture', message: 'item insert failed' } }; } };
      }
      throw new Error(`tabla inesperada ${table}`);
    },
  };
  await assert.rejects(
    repository.insertDigestRun(failingDb, { workflow_run_key: runKey }, [{ alert_id: 1 }]),
    /No se pudieron persistir items shadow-v2/
  );
  assert.strictEqual(cleanupCalls, 1, 'un fallo de items limpia el run parcial para poder reanudar');

  const limits = normalizeLimits({ maxSelected: 99, maxOfficialCharsPerAlert: 10 });
  assert.strictEqual(limits.maxSelected, 5);
  assert.strictEqual(limits.maxOfficialCharsPerAlert, 1000);

  console.log('OK: workflow por fases, historial, limites, persistencia, idempotencia y reanudacion');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
