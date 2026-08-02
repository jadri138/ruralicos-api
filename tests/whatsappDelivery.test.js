const assert = require('assert');
process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.ULTRAMSG_WEBHOOK_TOKEN = 'webhook-test-secret';
const {
  DELIVERY_STATUS,
  resolverTransicionEntrega,
  deliveryStatusDesdeProveedor,
  parsearAckUltraMsg,
} = require('../src/modules/delivery/deliveryState');
const {
  procesarAckUltraMsg,
  conciliarEntregasUltraMsg,
  registrarFalloProveedor,
  fechaReconciliacion,
} = require('../src/modules/delivery/deliveryService');
const {
  procesarOutboxItemMIA,
  recuperarOutboxSendingAtascadoMIA,
} = require('../src/modules/mia/outbox');
const { clasificarFalloUltraMsg } = require('../src/platform/whatsapp/errorClassification');
const { normalizarRespuestaUltraMsg, crearErrorUltraMsg } = require('../src/platform/whatsapp/client');
const feedbackRoutes = require('../src/modules/feedback/feedback.routes');
const { crearSupabaseMemoria } = require('./helpers/inMemorySupabase');

async function main() {
  console.log('\n=== TESTS: entrega WhatsApp y ACK ===\n');

  assert.strictEqual(resolverTransicionEntrega('QUEUED', 'PROVIDER_ACCEPTED').apply, true);
  assert.strictEqual(resolverTransicionEntrega('DELIVERED', 'SENT_TO_WHATSAPP').reason, 'out_of_order');
  assert.strictEqual(resolverTransicionEntrega('READ', 'DELIVERED').status, 'READ');
  assert.strictEqual(resolverTransicionEntrega('DELIVERED', 'DELIVERED').reason, 'duplicate');
  assert.strictEqual(deliveryStatusDesdeProveedor('unsent', 'SENT_TO_WHATSAPP'), 'UNDELIVERED');
  const previousDelay = process.env.ULTRAMSG_RECONCILE_ACCEPTED_MS;
  process.env.ULTRAMSG_RECONCILE_ACCEPTED_MS = 'valor-invalido';
  assert.ok(Number.isFinite(new Date(fechaReconciliacion('PROVIDER_ACCEPTED', 'fecha-invalida')).getTime()));
  if (previousDelay === undefined) delete process.env.ULTRAMSG_RECONCILE_ACCEPTED_MS;
  else process.env.ULTRAMSG_RECONCILE_ACCEPTED_MS = previousDelay;
  console.log('OK: transiciones monotónicas e idempotentes');

  const providerResponse = normalizarRespuestaUltraMsg(
    { sent: true, id: 98765 },
    200,
    { idempotencyKey: 'digest:10:v1' }
  );
  assert.strictEqual(providerResponse.providerMessageId, '98765');
  assert.strictEqual(providerResponse.providerStatus, 'pending');
  assert.strictEqual(providerResponse.idempotencyKey, 'digest:10:v1');
  console.log('OK: cliente UltraMsg conserva ID y clave idempotente');

  const ackCases = [
    ['pending', DELIVERY_STATUS.PROVIDER_ACCEPTED],
    ['server', DELIVERY_STATUS.SENT_TO_WHATSAPP],
    ['device', DELIVERY_STATUS.DELIVERED],
    ['read', DELIVERY_STATUS.READ],
    ['played', DELIVERY_STATUS.READ],
  ];
  for (const [ack, expected] of ackCases) {
    const parsed = parsearAckUltraMsg({
      event_type: 'message_ack',
      token: 'no-guardar',
      data: JSON.stringify({ id: 'provider-1', ack, from: '34600000000@c.us', body: 'privado' }),
    }, { now: new Date('2026-08-01T10:00:00Z') });
    assert.strictEqual(parsed.valid, true);
    assert.strictEqual(parsed.deliveryStatus, expected);
    assert.strictEqual(parsed.payloadJson.token, '[redacted]');
    assert.strictEqual(parsed.payloadJson.data.from, '[redacted]');
    assert.strictEqual(parsed.payloadJson.data.body, '[redacted]');
  }
  console.log('OK: ACK pending/server/device/read/played flexible y sanitizado');

  const supabase = crearSupabaseMemoria({
    mia_outbox: [{
      id: 1,
      digest_id: 10,
      user_id: 20,
      status: 'sent',
      attempts: 1,
      delivery_status: 'QUEUED',
      provider_message_id: 'provider-1',
      idempotency_key: 'digest:10:v1',
      message_version: 'v1',
      metadata_json: { digest_id: 10 },
    }],
    digests: [{ id: 10, enviado: false }],
    digest_attempts: [{ id: 30, digest_id: 10, kind: 'daily', status: 'generated', created_at: '2026-08-01T08:00:00Z' }],
    whatsapp_logs: [{ id: 40, outbox_id: 1, provider_message_id: 'provider-1', status: 'provider_accepted' }],
    whatsapp_delivery_events: [],
  });

  const pending = await procesarAckUltraMsg(supabase, {
    event_type: 'message_ack', data: { id: 'provider-1', ack: 'pending', time: 1785578400 },
  });
  assert.strictEqual(pending.delivery_status, DELIVERY_STATUS.PROVIDER_ACCEPTED);

  const server = await procesarAckUltraMsg(supabase, {
    event_type: 'message_ack', data: { id: 'provider-1', ack: 'server', time: 1785578460 },
  });
  assert.strictEqual(server.delivery_status, DELIVERY_STATUS.SENT_TO_WHATSAPP);

  const delivered = await procesarAckUltraMsg(supabase, {
    event_type: 'message_ack', data: { id: 'provider-1', ack: 'device', time: 1785578520 },
  });
  assert.strictEqual(delivered.delivery_status, DELIVERY_STATUS.DELIVERED);
  assert.strictEqual(supabase.tables.digests[0].enviado, true);
  assert.strictEqual(supabase.tables.digest_attempts[0].status, 'sent');
  assert.strictEqual(supabase.tables.digest_attempts[0].delivered_count, 1);

  // Simula un fallo parcial después de persistir el outbox. El ACK repetido
  // debe reparar las proyecciones sin crear otro efecto.
  supabase.tables.digests[0].enviado = false;
  supabase.tables.digests[0].delivery_status = 'QUEUED';
  const duplicate = await procesarAckUltraMsg(supabase, {
    event_type: 'message_ack', data: { id: 'provider-1', ack: 'device', time: 1785578520 },
  });
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(supabase.tables.digests[0].enviado, true);
  assert.strictEqual(supabase.tables.digests[0].delivery_status, DELIVERY_STATUS.DELIVERED);
  assert.strictEqual(supabase.tables.digest_attempts[0].delivered_count, 1);

  const oldServer = await procesarAckUltraMsg(supabase, {
    event_type: 'message_ack', data: { id: 'provider-1', ack: 'server', time: 1785578460 },
  });
  assert.strictEqual(oldServer.changed, false);
  assert.strictEqual(oldServer.delivery_status, DELIVERY_STATUS.DELIVERED);

  const read = await procesarAckUltraMsg(supabase, {
    event_type: 'message_ack', data: { id: 'provider-1', ack: 'read', time: 1785578580 },
  });
  assert.strictEqual(read.delivery_status, DELIVERY_STATUS.READ);
  assert(supabase.tables.digests[0].read_at);
  console.log('OK: ACK persistido, duplicado y desordenado no repite efectos');

  const learningDb = crearSupabaseMemoria({
    mia_outbox: [{
      id: 8,
      user_id: 41,
      organization_id: 12,
      to_phone: '34600000041',
      body: '¿Te interesan más avisos sobre riego?',
      status: 'sent',
      attempts: 1,
      delivery_status: 'SENT_TO_WHATSAPP',
      provider_message_id: 'provider-learning-8',
      idempotency_key: 'mia_exploration_question:8:v1',
      message_version: 'v1',
      metadata_json: {
        intent: 'learning_question',
        topic: 'riego',
        confidence: 0.7,
        zona_incertidumbre: { topic: 'riego', confidence: 0.7 },
      },
    }],
    whatsapp_logs: [{ id: 48, outbox_id: 8, provider_message_id: 'provider-learning-8' }],
    whatsapp_delivery_events: [],
    user_memory: [],
    user_conversations: [],
  });
  await procesarAckUltraMsg(learningDb, {
    event_type: 'message_ack', data: { id: 'provider-learning-8', ack: 'device' },
  });
  assert.strictEqual(learningDb.tables.user_memory.length, 1);
  assert.strictEqual(learningDb.tables.user_memory[0].tipo, 'pregunta_sistema');
  assert.strictEqual(learningDb.tables.user_conversations.length, 1);
  assert.strictEqual(learningDb.tables.user_conversations[0].contexto_json.outbox_id, 8);
  assert.strictEqual(
    learningDb.tables.mia_outbox[0].metadata_json.delivery_effects.learning_question.status,
    'done'
  );
  await procesarAckUltraMsg(learningDb, {
    event_type: 'message_ack', data: { id: 'provider-learning-8', ack: 'device' },
  });
  await procesarAckUltraMsg(learningDb, {
    event_type: 'message_ack', data: { id: 'provider-learning-8', ack: 'read' },
  });
  assert.strictEqual(learningDb.tables.user_memory.length, 1);
  assert.strictEqual(learningDb.tables.user_memory[0].duplicate_count, 0);
  assert.strictEqual(learningDb.tables.user_conversations.length, 1);
  console.log('OK: una pregunta de aprendizaje crea memoria y conversacion solo tras la primera entrega');

  const restartedLearningDb = crearSupabaseMemoria({
    mia_outbox: [{
      id: 9,
      user_id: 42,
      organization_id: 12,
      to_phone: '34600000042',
      body: '¿Quieres priorizar avisos sobre secano?',
      status: 'sent',
      attempts: 1,
      delivery_status: 'DELIVERED',
      provider_message_id: 'provider-learning-9',
      idempotency_key: 'mia_exploration_question:9:v1',
      message_version: 'v1',
      delivered_at: '2026-08-01T10:00:00Z',
      updated_at: '2026-08-01T10:01:00Z',
      metadata_json: {
        intent: 'learning_question',
        topic: 'secano',
        delivery_effects: {
          learning_question: {
            version: 'learning_question_delivery_v1',
            status: 'processing',
            attempts: 1,
            claimed_at: '2026-08-01T10:01:00Z',
            lease_expires_at: '2026-08-01T10:06:00Z',
            claim_token: 'worker-que-se-reinicio',
          },
        },
      },
    }],
    whatsapp_logs: [{ id: 49, outbox_id: 9, provider_message_id: 'provider-learning-9' }],
    whatsapp_delivery_events: [],
    user_memory: [{
      id: 71,
      user_id: 42,
      memory_key: 'learning_question_delivery:9',
      tipo: 'pregunta_sistema',
      duplicate_count: 0,
    }],
    user_conversations: [],
  });
  await procesarAckUltraMsg(restartedLearningDb, {
    event_type: 'message_ack', data: { id: 'provider-learning-9', ack: 'device' },
  });
  const recoveredMarker = restartedLearningDb.tables.mia_outbox[0]
    .metadata_json.delivery_effects.learning_question;
  assert.strictEqual(recoveredMarker.status, 'done');
  assert.strictEqual(recoveredMarker.attempts, 2);
  assert.strictEqual(recoveredMarker.stale_reclaims, 1);
  assert.notStrictEqual(recoveredMarker.claim_token, 'worker-que-se-reinicio');
  assert.strictEqual(restartedLearningDb.tables.user_memory.length, 1, 'reutiliza la memoria creada antes del crash');
  assert.strictEqual(restartedLearningDb.tables.user_conversations.length, 1);
  await procesarAckUltraMsg(restartedLearningDb, {
    event_type: 'message_ack', data: { id: 'provider-learning-9', ack: 'device' },
  });
  assert.strictEqual(restartedLearningDb.tables.user_memory.length, 1);
  assert.strictEqual(restartedLearningDb.tables.user_conversations.length, 1);
  console.log('OK: un ACK duplicado recupera el postproceso tras vencer el lease de un proceso reiniciado');

  const activeLeaseDb = crearSupabaseMemoria({
    mia_outbox: [{
      id: 10,
      user_id: 43,
      body: '¿Quieres priorizar ayudas para olivar?',
      status: 'sent',
      delivery_status: 'DELIVERED',
      provider_message_id: 'provider-learning-10',
      updated_at: '2026-08-02T10:00:00Z',
      metadata_json: {
        intent: 'learning_question',
        delivery_effects: {
          learning_question: {
            version: 'learning_question_delivery_v1',
            status: 'processing',
            attempts: 1,
            claimed_at: '2026-08-02T10:00:00Z',
            lease_expires_at: '2099-01-01T00:00:00Z',
            claim_token: 'worker-activo',
          },
        },
      },
    }],
    whatsapp_logs: [{ id: 50, outbox_id: 10, provider_message_id: 'provider-learning-10' }],
    whatsapp_delivery_events: [],
    user_memory: [],
    user_conversations: [],
  });
  await procesarAckUltraMsg(activeLeaseDb, {
    event_type: 'message_ack', data: { id: 'provider-learning-10', ack: 'device' },
  });
  assert.strictEqual(
    activeLeaseDb.tables.mia_outbox[0].metadata_json.delivery_effects.learning_question.claim_token,
    'worker-activo',
    'un ACK repetido no roba un lease que sigue activo'
  );
  assert.strictEqual(activeLeaseDb.tables.user_memory.length, 0);
  assert.strictEqual(activeLeaseDb.tables.user_conversations.length, 0);

  const handlers = new Map();
  const app = {};
  for (const method of ['get', 'post', 'all', 'delete', 'put', 'patch']) {
    app[method] = (path, ...callbacks) => handlers.set(`${method} ${path}`, callbacks.at(-1));
  }
  feedbackRoutes(app, supabase);
  const webhookHandler = handlers.get('all /webhooks/ultramsg/feedback');
  let webhookStatus = 200;
  let webhookBody = null;
  const response = {
    status(value) { webhookStatus = value; return this; },
    json(value) { webhookBody = value; return value; },
  };
  await webhookHandler({
    headers: {},
    query: { token: 'webhook-test-secret' },
    body: { event_type: 'message_ack', data: { id: 'provider-1', ack: 'read' } },
  }, response);
  assert.strictEqual(webhookStatus, 200);
  assert.strictEqual(webhookBody.handled, true);
  assert.strictEqual(webhookBody.delivery_status, DELIVERY_STATUS.READ);
  console.log('OK: endpoint ACK reutiliza autenticación del webhook');

  const unmatched = await procesarAckUltraMsg(supabase, {
    event_type: 'message_ack', data: { id: 'provider-desconocido', ack: 'device' },
  });
  assert.strictEqual(unmatched.matched, false);
  assert(supabase.tables.whatsapp_delivery_events.some((event) => event.provider_message_id === 'provider-desconocido'));
  console.log('OK: ACK sin correlación queda auditado sin inventar destinatario');

  const acceptedDb = crearSupabaseMemoria({
    mia_outbox: [{
      id: 2,
      user_id: 21,
      to_phone: '34600000001',
      body: 'Mensaje seguro',
      status: 'queued',
      attempts: 0,
      next_attempt_at: '2026-01-01T00:00:00Z',
      delivery_status: 'QUEUED',
      idempotency_key: 'mia:2:v1',
      message_version: 'v1',
      metadata_json: {},
    }],
    whatsapp_logs: [],
    whatsapp_delivery_events: [],
  });
  let sendCalls = 0;
  const accepted = await procesarOutboxItemMIA(acceptedDb, acceptedDb.tables.mia_outbox[0], async (_phone, _body, context) => {
    sendCalls += 1;
    assert.strictEqual(context.idempotencyKey, 'mia:2:v1');
    return { providerMessageId: 'provider-2', providerStatus: 'pending' };
  });
  assert.strictEqual(accepted.status, 'provider_accepted');
  assert.strictEqual(accepted.provider_message_id, 'provider-2');
  const notRepeated = await procesarOutboxItemMIA(acceptedDb, acceptedDb.tables.mia_outbox[0], async () => { sendCalls += 1; });
  assert.strictEqual(notRepeated.status, 'requires_reconciliation');
  assert.strictEqual(sendCalls, 1);
  console.log('OK: provider ID e idempotencia propagados; aceptado no se reenvía');

  const transientDb = crearSupabaseMemoria({
    mia_outbox: [{ id: 3, status: 'sending', attempts: 0, delivery_status: 'QUEUED', idempotency_key: 'k3' }],
    whatsapp_logs: [],
    whatsapp_delivery_events: [],
  });
  const transientError = new Error('UltraMsg temporal');
  transientError.retryable = true;
  const transient = await registrarFalloProveedor(transientDb, transientDb.tables.mia_outbox[0], transientError, {
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: '2026-08-01T11:00:00Z',
  });
  assert.strictEqual(transient.retryable, true);
  assert.strictEqual(transientDb.tables.mia_outbox[0].delivery_status, 'QUEUED');
  assert.strictEqual(transientDb.tables.mia_outbox[0].next_attempt_at, '2026-08-01T11:00:00Z');

  const permanentDb = crearSupabaseMemoria({
    mia_outbox: [{ id: 4, status: 'sending', attempts: 0, delivery_status: 'QUEUED', idempotency_key: 'k4' }],
    whatsapp_logs: [],
    whatsapp_delivery_events: [],
  });
  const permanentError = new Error('numero invalid');
  permanentError.retryable = false;
  permanentError.providerCode = 'invalid_number';
  const permanent = await registrarFalloProveedor(permanentDb, permanentDb.tables.mia_outbox[0], permanentError, {
    attempts: 1,
    maxAttempts: 5,
  });
  assert.strictEqual(permanent.retryable, false);
  assert.strictEqual(permanentDb.tables.mia_outbox[0].delivery_status, DELIVERY_STATUS.FAILED);
  assert.strictEqual(permanentDb.tables.mia_outbox[0].next_attempt_at, null);

  assert.strictEqual(clasificarFalloUltraMsg({ httpStatus: 503 }).retryable, true);
  assert.strictEqual(clasificarFalloUltraMsg({ httpStatus: 400 }).permanent, true);
  assert.strictEqual(clasificarFalloUltraMsg({ message: 'socket timeout' }).ambiguous, true);
  const invalidSuccessBody = crearErrorUltraMsg('respuesta no JSON tras HTTP 200', {
    httpStatus: 200,
    code: 'invalid_json_response',
    ambiguous: true,
    permanent: false,
    retryable: false,
  });
  assert.strictEqual(invalidSuccessBody.ambiguous, true);
  assert.strictEqual(invalidSuccessBody.retryable, false);
  console.log('OK: fallos reintentables, definitivos y ambiguos se separan');

  const restartDb = crearSupabaseMemoria({
    mia_outbox: [{
      id: 5,
      status: 'sending',
      attempts: 0,
      delivery_status: 'QUEUED',
      updated_at: '2020-01-01T00:00:00Z',
    }],
  });
  const recovered = await recuperarOutboxSendingAtascadoMIA(restartDb, { timeoutMs: 60 * 1000, limit: 10 });
  assert.strictEqual(recovered.recovered, 1);
  assert.strictEqual(restartDb.tables.mia_outbox[0].next_attempt_at, null);
  assert.strictEqual(restartDb.tables.mia_outbox[0].provider_error_code, 'sending_timeout_ambiguous');

  const restartTrackedDb = crearSupabaseMemoria({
    mia_outbox: [{
      id: 51,
      status: 'sending',
      attempts: 0,
      delivery_status: 'QUEUED',
      provider_message_id: 'provider-restart-51',
      updated_at: '2020-01-01T00:00:00Z',
    }],
  });
  await recuperarOutboxSendingAtascadoMIA(restartTrackedDb, { timeoutMs: 60 * 1000, limit: 10 });
  assert.strictEqual(
    restartTrackedDb.tables.mia_outbox[0].delivery_status,
    DELIVERY_STATUS.PROVIDER_ACCEPTED
  );
  assert.strictEqual(restartTrackedDb.tables.mia_outbox[0].next_attempt_at, null);
  console.log('OK: reinicio durante envío no provoca un segundo mensaje');

  const reconcileDb = crearSupabaseMemoria({
    mia_outbox: [{
      id: 6,
      digest_id: 60,
      user_id: 61,
      status: 'sent',
      attempts: 1,
      delivery_status: 'PROVIDER_ACCEPTED',
      provider_message_id: 'provider-6',
      idempotency_key: 'digest:60:v1',
      message_version: 'v1',
      reconcile_after: '2026-08-01T09:00:00Z',
      reconciliation_attempts: 0,
      metadata_json: { digest_id: 60 },
    }],
    digests: [{ id: 60, enviado: false }],
    digest_attempts: [{ id: 62, digest_id: 60, kind: 'daily', status: 'generated', created_at: '2026-08-01T08:00:00Z' }],
    whatsapp_logs: [{ id: 63, outbox_id: 6, provider_message_id: 'provider-6', status: 'provider_accepted' }],
    whatsapp_delivery_events: [],
  });
  let fetchCalls = 0;
  const reconciled = await conciliarEntregasUltraMsg(reconcileDb, {
    instanceId: 'instance-test',
    token: 'token-test',
    now: new Date('2026-08-01T10:00:00Z'),
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ messages: [{ id: 'provider-6', status: 'sent', ack: 'device', sent_at: '2026-08-01T09:30:00Z' }] }),
      };
    },
  });
  assert.strictEqual(reconciled.reconciled, 1);
  assert.strictEqual(fetchCalls, 1);
  assert.strictEqual(reconcileDb.tables.mia_outbox[0].delivery_status, DELIVERY_STATUS.DELIVERED);

  const dryRun = await conciliarEntregasUltraMsg(reconcileDb, {
    dryRun: true,
    now: new Date('2026-08-01T10:00:00Z'),
    fetchImpl: async () => { throw new Error('No debe consultar proveedor'); },
  });
  assert.strictEqual(dryRun.dry_run, true);
  assert.strictEqual(fetchCalls, 1);
  console.log('OK: conciliación usa fetch inyectable y dry-run no consulta UltraMsg');

  console.log('\nResultados entrega WhatsApp: OK');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
