const {
  construirOutboxDesdeDecision,
  encolarRespuestaMIA,
  procesarOutboxItemMIA,
  calcularNextAttemptAt,
  calcularOutboxHealthMIA,
} = require('../src/modules/mia/outbox');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

function crearSupabaseOutboxMock({ existing = null, claim = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const query = {
        table,
        op: 'select',
        patch: null,
        rows: null,
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        lte() { return this; },
        lt() { return this; },
        order() { return this; },
        limit() { return this; },
        insert(rows) {
          calls.push({ table, op: 'insert', rows });
          this.op = 'insert';
          this.rows = rows;
          return this;
        },
        update(patch) {
          calls.push({ table, op: 'update', patch });
          this.op = 'update';
          this.patch = patch;
          return this;
        },
        maybeSingle() {
          if (this.op === 'update') return Promise.resolve({ data: claim || null, error: null });
          return Promise.resolve({ data: existing || null, error: null });
        },
        single() {
          if (this.op === 'insert') return Promise.resolve({ data: { id: 55 }, error: null });
          return Promise.resolve({ data: existing || null, error: null });
        },
        then(resolve, reject) {
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

console.log('\n=== TESTS: mia outbox ===\n');

(async () => {
  const outbox = construirOutboxDesdeDecision({
    userId: 141,
    inboundId: 72,
    decisionId: 9,
    toPhone: '34644899647',
    organizationId: 12,
    decision: {
      version: 'mia_decision_v1',
      intent: 'pregunta_usuario',
      confidence: 0.8,
      risk_flags: ['knowledge_partial_answer'],
      knowledge_context: { evidence_level: 'media' },
      reply_action: { canal: 'whatsapp', texto: 'Te aviso cuando haya una fecha clara.' },
    },
  });

  assert(outbox.status === 'queued', 'Crea outbox en estado queued');
  assert(outbox.to_phone === '34644899647', 'Conserva telefono destino');
  assert(outbox.organization_id === 12, 'Propaga organization_id al outbox');
  assert(outbox.body.startsWith('*Ruralicos*'), 'Aplica cabecera profesional de marca');
  assert(outbox.body.includes('_Respuesta autom'), 'Incluye descargo breve en cursiva');
  assert(outbox.body.includes('fecha clara'), 'Conserva cuerpo de respuesta');
  assert(outbox.metadata_json.intent === 'pregunta_usuario', 'Guarda metadata de decision');
  assert(outbox.metadata_json.risk_flags.includes('knowledge_partial_answer'), 'Guarda risk_flags en metadata');

  const outboxMarca = construirOutboxDesdeDecision({
    userId: 141,
    toPhone: '34644899647',
    decision: {
      organization_context: {
        reply_sender: 'Cooperativa Los Olivos',
        support_label: 'el equipo tecnico de Cooperativa Los Olivos',
      },
      reply_action: {
        canal: 'whatsapp',
        texto: 'Soy Jaime y mi pareja y yo lo revisamos.',
      },
    },
  });
  assert(outboxMarca.body.includes('Cooperativa Los Olivos'), 'Outbox usa remitente de organizacion al limpiar respuesta');
  assert(outboxMarca.metadata_json.organization_context.reply_sender === 'Cooperativa Los Olivos', 'Outbox conserva contexto de organizacion en metadata');

  const outboxSinInternos = construirOutboxDesdeDecision({
    userId: 141,
    toPhone: '34644899647',
    decision: {
      intent: 'pregunta_usuario',
      reply_action: { canal: 'whatsapp', texto: 'No hay novedades sobre tractores en el digest.' },
    },
  });
  assert(!/\bdigest\b/i.test(outboxSinInternos.body), 'Outbox elimina terminos internos antes de enviar');
  assert(outboxSinInternos.body.includes('resumen de alertas'), 'Outbox reemplaza digest por lenguaje entendible');

  const sinRespuesta = construirOutboxDesdeDecision({
    userId: 141,
    toPhone: '34644899647',
    decision: { intent: 'trivial' },
  });

  assert(sinRespuesta === null, 'No crea outbox si no hay reply_action');

  const supabaseInsert = crearSupabaseOutboxMock();
  const encolado = await encolarRespuestaMIA(supabaseInsert, {
    userId: 141,
    inboundId: 72,
    decisionId: 9,
    toPhone: '34644899647',
    decision: {
      intent: 'pregunta_usuario',
      reply_action: { canal: 'whatsapp', texto: 'Mensaje nuevo.' },
    },
  });

  assert(encolado.queued === true && encolado.id === 55, 'Encola respuesta nueva');
  assert(supabaseInsert.calls.some((call) => call.op === 'insert'), 'Inserta en mia_outbox cuando no existe');

  const supabaseExistente = crearSupabaseOutboxMock({
    existing: { id: 77, status: 'queued', attempts: 0, body: 'Mensaje existente.', to_phone: '34644899647' },
  });
  const existente = await encolarRespuestaMIA(supabaseExistente, {
    userId: 141,
    inboundId: 72,
    decisionId: 9,
    toPhone: '34644899647',
    decision: {
      intent: 'pregunta_usuario',
      reply_action: { canal: 'whatsapp', texto: 'Mensaje existente.' },
    },
  });

  assert(existente.existing === true && existente.id === 77, 'Reutiliza outbox existente para evitar doble envio');
  assert(!supabaseExistente.calls.some((call) => call.op === 'insert'), 'No inserta outbox duplicado');

  let enviadoA = null;
  const supabaseClaim = crearSupabaseOutboxMock({
    claim: { id: 88, to_phone: '34644899647', body: 'Hola desde MIA', attempts: 0 },
  });
  const enviado = await procesarOutboxItemMIA(supabaseClaim, { id: 88 }, async (phone, body) => {
    enviadoA = { phone, body };
  });

  assert(enviado.status === 'sent', 'Procesa outbox reclamado y lo marca enviado');
  assert(enviadoA.phone === '34644899647' && enviadoA.body.includes('MIA'), 'Llama a la funcion de envio con telefono y cuerpo');
  assert(supabaseClaim.calls.filter((call) => call.op === 'update').length >= 2, 'Actualiza sending y sent');

  const supabaseNoClaim = crearSupabaseOutboxMock({ claim: null });
  const omitido = await procesarOutboxItemMIA(supabaseNoClaim, { id: 99 }, async () => {
    throw new Error('No deberia enviar');
  });

  assert(omitido.skipped === true && omitido.status === 'not_claimed', 'No envia si no consigue reclamar el outbox');

  const supabaseFail = crearSupabaseOutboxMock({
    claim: { id: 90, to_phone: '34644899647', body: 'Falla', attempts: 0 },
  });
  const fallido = await procesarOutboxItemMIA(supabaseFail, { id: 90 }, async () => {
    throw new Error('UltraMsg temporal');
  });

  assert(fallido.status === 'failed' && fallido.attempts === 1, 'Marca fallo con intento incrementado');
  assert(calcularNextAttemptAt(1, 0) > new Date(0).toISOString(), 'Calcula siguiente reintento');

  const health = calcularOutboxHealthMIA([
    {
      id: 1,
      status: 'sent',
      attempts: 1,
      created_at: '2026-05-24T08:00:00Z',
      updated_at: '2026-05-24T08:00:10Z',
    },
    {
      id: 2,
      status: 'failed',
      attempts: 5,
      created_at: '2026-05-24T07:00:00Z',
      updated_at: '2026-05-24T07:05:00Z',
      next_attempt_at: null,
    },
    {
      id: 3,
      status: 'sending',
      attempts: 1,
      created_at: '2026-05-24T07:30:00Z',
      updated_at: '2026-05-24T07:35:00Z',
    },
    {
      id: 4,
      status: 'queued',
      attempts: 0,
      created_at: '2026-05-24T08:50:00Z',
      updated_at: '2026-05-24T08:50:00Z',
      next_attempt_at: '2026-05-24T08:55:00Z',
    },
  ], {
    now: new Date('2026-05-24T09:00:00Z'),
    maxAttempts: 5,
    sendingTimeoutMs: 10 * 60 * 1000,
  });

  assert(health.ok === false, 'Outbox health falla si hay mensajes agotados o atascados');
  assert(health.metrics.dead_letter === 1, 'Cuenta mensajes agotados');
  assert(health.metrics.stuck_sending === 1, 'Cuenta mensajes en sending atascados');
  assert(health.metrics.due_now === 1, 'Cuenta mensajes listos para enviar ahora');
  assert(health.recommendations.some((item) => item.priority === 'alta'), 'Genera recomendaciones de prioridad alta');

  console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
