const assert = require('assert');
const {
  validateRunForPromotion,
  buildProductAlerts,
  promoteShadowV2Digests,
} = require('../src/modules/digest/digestV2Promotion');
const {
  evaluateSendGate,
  SEND_GATE_VERSION,
} = require('../src/modules/alertas/shadow-v2/sendGate');
const { construirDigestItems } = require('../src/modules/mia/digestItems');
const { evaluarDigestItemsParaEnvio } = require('../src/modules/digest/digestOutbox');
const { resolveDigestEngine } = require('../src/modules/digest/digestEngine');

const WORKFLOW_DATE = '2026-08-18';
const WORKFLOW_RUN_KEY = '11111111-1111-5111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

function candidate(overrides = {}) {
  const officialSnapshot = {
    alert_id: 501,
    title: 'Convocatoria de ayudas para explotaciones agrarias',
    source: 'BOA',
    official_url: 'https://example.test/501',
    official_content:
      'Los titulares de explotaciones agrarias podran solicitar la ayuda hasta el 30 de septiembre.',
    ...overrides.official_snapshot,
  };
  const card = {
    relevant: true,
    actionable: true,
    status: 'active',
    territories: { national: false, regions: ['Aragon'], provinces: [], municipalities: [] },
    activities: ['agricultura'],
    beneficiary_types: ['titulares de explotaciones agrarias'],
    content_type: 'aid',
    action: 'solicitar la ayuda',
    deadline: null,
    summary: 'Ayuda abierta para titulares de explotaciones agrarias.',
    evidence: ['titulares de explotaciones agrarias podran solicitar la ayuda'],
    ...overrides.card,
  };
  const result = {
    alert_id: 501,
    official_snapshot: officialSnapshot,
    card,
    send_gate: evaluateSendGate({ officialSnapshot, card, workflowDate: WORKFLOW_DATE }),
  };
  return { ...result, ...overrides, official_snapshot: officialSnapshot, card };
}

function generatedRun(overrides = {}) {
  return {
    id: RUN_ID,
    workflow_run_key: WORKFLOW_RUN_KEY,
    workflow_date: WORKFLOW_DATE,
    user_id: 7,
    profile_snapshot: { subscription: 'agricultor', organization_id: 4 },
    candidate_cards: [candidate()],
    engine_version: 'shadow-v2-5',
    digest_preview: 'Hola Ana\n\nUna oportunidad para ti.\n\nhttps://example.test/501',
    status: 'GENERATED',
    error_code: null,
    error_message: null,
    ...overrides,
  };
}

function selectedItem(overrides = {}) {
  const card = candidate().card;
  return {
    id: 1,
    shadow_digest_run_id: RUN_ID,
    alert_id: 501,
    final_position: 1,
    classification_snapshot: card,
    personal_reason: 'Encaja con tu explotacion agricola en Aragon.',
    title_used: 'Ayuda para tu explotacion',
    summary_used: card.summary,
    action_used: card.action,
    deadline_used: card.deadline,
    rendered_block: 'Ayuda para tu explotacion\nSolicita la ayuda.',
    ...overrides,
  };
}

function memoryRepository({
  runs = [generatedRun()],
  items = [selectedItem()],
  existing = null,
} = {}) {
  const state = { runs, items, digest: existing, inserted: [], approved: [] };
  return {
    state,
    repo: {
      async loadRuns() {
        return state.runs;
      },
      async loadItems() {
        return state.items;
      },
      async findDigest() {
        return state.digest;
      },
      async insertDigest(_supabase, row) {
        state.digest = { ...row, id: 900 };
        state.inserted.push(state.digest);
        return state.digest;
      },
      async approveDigest(_supabase, digestId, patch) {
        state.digest = { ...state.digest, ...patch, id: digestId };
        state.approved.push(state.digest);
        return { id: digestId };
      },
    },
  };
}

async function main() {
  assert.strictEqual(resolveDigestEngine(undefined), 'v2');
  assert.strictEqual(resolveDigestEngine(' V2 '), 'v2');
  assert.throws(() => resolveDigestEngine('shadow'), /DIGEST_ENGINE invalido/);

  const run = generatedRun();
  const item = selectedItem();
  const validation = validateRunForPromotion(run, [item], WORKFLOW_DATE);
  assert.strictEqual(validation.allowed, true, validation.reasons.join(', '));
  assert.strictEqual(run.candidate_cards[0].send_gate.version, SEND_GATE_VERSION);

  const productAlerts = buildProductAlerts(run, validation);
  const productRows = construirDigestItems({
    digestId: 900,
    userId: run.user_id,
    fecha: WORKFLOW_DATE,
    alertas: productAlerts,
    origen: 'shadow-v2-5',
    organizationId: 4,
  });
  assert.strictEqual(productRows.length, 1);
  assert.strictEqual(
    evaluarDigestItemsParaEnvio(productRows).allowed,
    true,
    'la autoridad final de outbox debe aceptar items promovidos por V2'
  );
  assert.strictEqual(productRows[0].tags_json.shadow_decision.engine_version, 'shadow-v2-5');

  const closedCandidate = candidate({
    official_snapshot: {
      title: 'Resolucion provisional de concesion de ayudas a la apicultura',
      official_content:
        'Se publica la relacion provisional de solicitudes y personas beneficiarias.',
    },
    card: {
      action: 'solicitar la ayuda',
      summary: 'Resolucion provisional de ayudas apicolas.',
      evidence: ['relacion provisional de solicitudes y personas beneficiarias'],
    },
  });
  // Simula una clasificacion persistida por una version anterior: la promocion
  // siempre vuelve a ejecutar el gate actual y no confia solo en el snapshot.
  closedCandidate.send_gate = { version: SEND_GATE_VERSION, allowed: true, reasons: [] };
  const closedRun = generatedRun({ candidate_cards: [closedCandidate] });
  const closedItem = selectedItem({
    summary_used: closedCandidate.card.summary,
    action_used: closedCandidate.card.action,
  });
  const blocked = validateRunForPromotion(closedRun, [closedItem], WORKFLOW_DATE);
  assert.strictEqual(blocked.allowed, false);
  assert(blocked.reasons.some((reason) => reason.includes('provisional_award')));

  const memory = memoryRepository();
  const attempts = [];
  const feedback = [];
  const result = await promoteShadowV2Digests({
    supabase: {},
    workflowDate: WORKFLOW_DATE,
    workflowRunKey: WORKFLOW_RUN_KEY,
    repo: memory.repo,
    registerItems: async (_supabase, options) => ({ ok: true, inserted: options.alertas.length }),
    trackMessage: async (_supabase, options) => ({
      ...options,
      enabled: true,
      links: [],
      mensaje: options.mensaje,
    }),
    openFeedback: async (_supabase, options) => {
      feedback.push(options);
    },
    recordAttemptFn: async (_supabase, options) => {
      attempts.push(options);
      return { ok: true };
    },
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.promoted, 1);
  assert.strictEqual(memory.state.inserted.length, 1);
  assert.strictEqual(memory.state.approved[0].delivery_status, 'APPROVED');
  assert(memory.state.approved[0].idempotency_key.startsWith(`digest_daily_v2:${RUN_ID}:`));
  assert.deepStrictEqual(memory.state.approved[0].alerta_ids, [501]);
  assert.strictEqual(attempts[0].status, 'generated');
  assert.strictEqual(feedback.length, 1);

  const repeated = await promoteShadowV2Digests({
    supabase: {},
    workflowDate: WORKFLOW_DATE,
    workflowRunKey: WORKFLOW_RUN_KEY,
    repo: memory.repo,
    registerItems: async () => {
      throw new Error('no debe reinsertar items');
    },
    trackMessage: async () => {
      throw new Error('no debe recrear tracking');
    },
    openFeedback: async () => {
      throw new Error('no debe reabrir feedback');
    },
    recordAttemptFn: async () => ({ ok: true }),
  });
  assert.strictEqual(repeated.already_promoted, 1);
  assert.strictEqual(memory.state.inserted.length, 1, 'la promocion debe ser idempotente');

  const legacy = memoryRepository({
    existing: {
      id: 44,
      user_id: 7,
      fecha: WORKFLOW_DATE,
      delivery_status: 'APPROVED',
      idempotency_key: 'digest_daily:legacy:v1',
    },
  });
  const skipped = await promoteShadowV2Digests({
    supabase: {},
    workflowDate: WORKFLOW_DATE,
    workflowRunKey: WORKFLOW_RUN_KEY,
    repo: legacy.repo,
    registerItems: async () => {
      throw new Error('no debe tocar un digest V1');
    },
    trackMessage: async () => {
      throw new Error('no debe tocar un digest V1');
    },
    openFeedback: async () => {},
    recordAttemptFn: async () => ({ ok: true }),
  });
  assert.strictEqual(skipped.skipped_existing, 1);
  assert.strictEqual(legacy.state.inserted.length, 0);

  console.log('OK: promocion V2 productiva, fail-closed, trazable e idempotente');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
