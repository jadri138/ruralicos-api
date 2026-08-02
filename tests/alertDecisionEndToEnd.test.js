process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const assert = require('assert');
const {
  CONTRACT_VERSIONS,
  DECISION_STATES,
  REASON_CODES,
  buildDecisionProfile,
  createDailyJudgeBudget,
} = require('../src/modules/alertas/decision');
const { decidirAlertasDigest } = require('../src/modules/digest/decisionIntegration');
const { renderDecisionDigestMessage } = require('../src/modules/digest/decisionMessage');
const { encolarDigestsPendientes } = require('../src/modules/digest/digestOutbox');
const { procesarOutboxItemMIA } = require('../src/modules/mia/outbox');
const { procesarAckUltraMsg } = require('../src/modules/delivery/deliveryService');
const {
  construirMemoriasDesdeDecision,
  guardarMemoriasAtomicas,
} = require('../src/modules/aprendizaje/atomicMemory');
const { cargarDigestYAlertas } = require('../src/modules/feedback/feedback.service');
const { crearSupabaseMemoria } = require('./helpers/inMemorySupabase');

function verified(value, evidence) {
  return {
    valor: value,
    evidencia: evidence || `Documento oficial: ${value}`,
    source: 'raw_document.texto_raw',
    confidence: 0.95,
    evidence_level: 'official',
    status: 'verified',
  };
}

function existingAlert(id, province = 'Teruel', { missingBeneficiaries = false } = {}) {
  const factSheet = {
    schema_version: 'fact_sheet_v3',
    builder_version: 'fact_sheet_builder_v6',
    generated_at: '2026-08-01T08:00:00.000Z',
    alerta_id: id,
    raw_document_id: `doc-${id}`,
    content_hash: `hash-${id}`,
    tipo_documento: verified('ayuda'),
    tema_principal: verified('modernización agraria'),
    resumen_neutro: verified('Convocatoria para modernizar explotaciones agrarias.'),
    territorio: [verified(province, `Se aplica en la provincia de ${province}.`)],
    sectores: [verified('agricultura')],
    subsectores: [verified('regadío')],
    accion_requerida: verified('Presentar la solicitud.'),
    accion_codigo: verified('solicitar'),
    application_deadline: verified('2026-09-18'),
    beneficiarios: verified('Titulares de explotaciones agrarias.'),
    url_oficial: verified(`https://example.test/oficial/${id}`),
    truth_score: 96,
    risk_score: 4,
    evidence_coverage: 95,
    status: 'ready_for_digest',
    flags: [],
    reasons: [],
    resumen_estructurado: {},
  };
  if (missingBeneficiaries) {
    delete factSheet.beneficiarios;
    factSheet.status = 'insufficient_evidence';
  }
  return {
    id,
    titulo: `Ayuda agraria ${id}`,
    resumen: 'Convocatoria para modernizar explotaciones agrarias.',
    url: `https://example.test/oficial/${id}`,
    fuente: 'BOA',
    provincias: [province],
    sectores: ['agricultura'],
    subsectores: ['regadio'],
    tipos_alerta: ['ayuda'],
    decision_digest: { score: 94, incluir: true, action: 'include' },
    fact_sheet: factSheet,
  };
}

function sendableDigestItem({ digestId, userId, alertId }) {
  return {
    digest_id: digestId,
    user_id: userId,
    alerta_id: alertId,
    selection_action: 'include',
    selection_decision: { action: 'include' },
    tags_json: {
      final_validation_decision: { status: 'send' },
      effective_send_decision: 'send',
      effective_gate_version: 'final_send_gate_v1',
      automatic_send_allowed: true,
    },
  };
}

async function main() {
  const fecha = '2026-08-01';
  const user = {
    id: 77,
    first_name: 'Ana',
    subscription: 'agricultor',
    preferences: {
      provincias: ['Teruel'],
      sectores: ['agricultura'],
      subsectores: ['regadio'],
      frecuencia: 'daily',
    },
  };
  const positive = existingAlert(1);
  const blocked = existingAlert(2, 'Valencia');
  const held = existingAlert(3, 'Teruel', { missingBeneficiaries: true });
  let judgeCalls = 0;
  const caller = async (request) => {
    judgeCalls += 1;
    const evidence = request.input.untrusted_alert_data.evidence;
    const fields = ['title', 'summary', 'territory', 'beneficiaries', 'action', 'deadline', 'official_url']
      .filter((field) => evidence[field]);
    return {
      contract_version: CONTRACT_VERSIONS.decision,
      policy_version: CONTRACT_VERSIONS.policy,
      decision: DECISION_STATES.ADD_TO_DIGEST,
      applicability: 0.95,
      usefulness: 0.92,
      actionability: 0.88,
      urgency: 0.5,
      novelty: 0.9,
      confidence: 0.93,
      reason_codes: [REASON_CODES.ACTIVITY_MATCH],
      evidence_refs: fields.map((field) => evidence[field].ref),
      missing_information: [],
      user_reason: 'Puede ayudarte a modernizar tu explotación en Teruel.',
      message_facts: fields.map((field) => ({ field, evidence_ref: evidence[field].ref })),
    };
  };

  const decision = await decidirAlertasDigest({
    supabase: null,
    alertas: [positive, blocked, held],
    user,
    perfilOperativo: { atomic_memories: [] },
    context: {
      now: '2026-08-01T10:00:00.000Z',
      recentCommunications: [],
      recentDeliveries: [],
      usedIdempotencyKeys: [],
    },
    caller,
    budget: createDailyJudgeBudget({ maxCalls: 5 }),
    policy: { topK: 10, maxItems: 3 },
  });

  assert.strictEqual(judgeCalls, 1, 'bloqueos y HOLD de evidencia no llegan al juez');
  assert.deepStrictEqual(decision.alertas.map((alerta) => alerta.id), [1]);
  assert.strictEqual(
    decision.audit_decisions.find((item) => item.id === 2).decision,
    DECISION_STATES.BLOCKED
  );
  assert.strictEqual(
    decision.audit_decisions.find((item) => item.id === 3).decision,
    DECISION_STATES.HOLD_FOR_EVIDENCE
  );

  const rendered = renderDecisionDigestMessage({ user, alertas: decision.alertas, fecha });
  assert(rendered.message?.includes('Fuente oficial:'));

  const db = crearSupabaseMemoria({
    users: [
      { id: 77, phone: '34600000077', phone_verified: true },
      { id: 88, phone: '34600000088', phone_verified: true },
    ],
    alertas: [positive, existingAlert(4)],
    digests: [{
      id: 10,
      user_id: 77,
      fecha,
      mensaje: rendered.message,
      enviado: false,
      delivery_status: 'APPROVED',
      created_at: '2026-08-01T10:05:00.000Z',
    }],
    digest_items: [sendableDigestItem({ digestId: 10, userId: 77, alertId: 1 })],
    digest_attempts: [{ id: 100, digest_id: 10, user_id: 77, fecha, status: 'generated' }],
    mia_outbox: [],
    whatsapp_logs: [],
    whatsapp_delivery_events: [],
    user_memory: [],
  });

  const queued = await encolarDigestsPendientes(db, {
    fecha,
    ahora: () => new Date('2026-08-01T10:06:00.000Z'),
  });
  assert.strictEqual(queued.encolados, 1);
  const outbox = db.tables.mia_outbox[0];
  const accepted = await procesarOutboxItemMIA(db, outbox, async () => ({
    providerMessageId: 'provider-e2e-10',
    providerStatus: 'pending',
  }));
  assert.strictEqual(accepted.status, 'provider_accepted');
  assert.strictEqual(db.tables.digests[0].enviado, false);

  await procesarAckUltraMsg(db, {
    event_type: 'message_ack',
    data: { id: 'provider-e2e-10', ack: 'device', time: 1785578760 },
  });
  assert.strictEqual(db.tables.digests[0].delivery_status, 'DELIVERED');
  assert.strictEqual(db.tables.digests[0].enviado, true);

  const memories = construirMemoriasDesdeDecision({
    userId: 77,
    digestId: 10,
    textoOriginal: 'Sí, quiero más ayudas de modernización.',
    decision: {
      version: 'feedback_decision_v1',
      intent: 'preference',
      confidence: 0.95,
      memory_actions: [{
        tipo: 'interes_detectado',
        contenido: 'Le interesan ayudas de modernización agraria',
        scope_type: 'topic',
        scope_value: 'modernizacion agraria',
        polarity: 'positive',
        peso_inicial: 0.9,
      }],
    },
  });
  await guardarMemoriasAtomicas(db, memories);
  const learnedProfile = buildDecisionProfile({
    user,
    memories: db.tables.user_memory,
    now: new Date('2026-08-02T10:00:00.000Z'),
  });
  assert(learnedProfile.memories.positive.some((memory) => memory.key === 'modernizacion_agraria'));

  db.tables.digests.push({
    id: 20,
    user_id: 88,
    fecha,
    mensaje: 'Mensaje que fallará',
    enviado: false,
    delivery_status: 'APPROVED',
    created_at: '2026-08-01T10:10:00.000Z',
  });
  db.tables.digest_items.push(sendableDigestItem({ digestId: 20, userId: 88, alertId: 4 }));
  db.tables.digest_attempts.push({ id: 200, digest_id: 20, user_id: 88, fecha, status: 'generated' });
  const secondQueue = await encolarDigestsPendientes(db, {
    fecha,
    ahora: () => new Date('2026-08-01T10:11:00.000Z'),
  });
  assert.strictEqual(secondQueue.encolados, 1);
  const failedOutbox = db.tables.mia_outbox.find((item) => item.digest_id === 20);
  const providerError = new Error('número inválido');
  providerError.retryable = false;
  providerError.permanent = true;
  providerError.providerCode = 'invalid_number';
  const failed = await procesarOutboxItemMIA(db, failedOutbox, async () => {
    throw providerError;
  });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(db.tables.digests.find((item) => item.id === 20).delivery_status, 'FAILED');

  const failedFeedbackContext = await cargarDigestYAlertas(
    db,
    88,
    { digest_id: 20, contexto_json: { digest_id: 20 } },
    null,
    { fechaHoy: fecha }
  );
  assert.strictEqual(failedFeedbackContext.digest, null);
  assert.deepStrictEqual(failedFeedbackContext.alertasOrdenadas, []);
  assert.strictEqual(db.tables.user_memory.filter((memory) => memory.user_id === 88).length, 0);

  console.log('OK: E2E real cubre decisión, digest, outbox, ACK, feedback, perfil, HOLD, bloqueo y fallo');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
