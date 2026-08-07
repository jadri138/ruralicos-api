process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

// Validacion progresiva de la reparacion del 5-08-2026, con los datos reales que
// ese dia produjeron cero digests: fichas v3 del BOE cuyo territorio es el
// centinela "no_detectado" y perfiles de personas de Cordoba, Huesca, Teruel,
// Navarra y Madrid. Primero una persona, despues cinco.
//
// Recorre la cadena completa: decision canonica -> auditoria -> digest -> outbox
// -> aceptacion del proveedor -> ACK de entrega. Todo contra el Supabase de
// memoria: no escribe en produccion ni envia ningun mensaje real.
const assert = require('assert');

const {
  CONTRACT_VERSIONS,
  DECISION_STATES,
  REASON_CODES,
  createDailyJudgeBudget,
} = require('../src/modules/alertas/decision');
const { decidirAlertasDigest } = require('../src/modules/digest/decisionIntegration');
const { renderDecisionDigestMessage } = require('../src/modules/digest/decisionMessage');
const { encolarDigestsPendientes } = require('../src/modules/digest/digestOutbox');
const { procesarOutboxItemMIA } = require('../src/modules/mia/outbox');
const { procesarAckUltraMsg } = require('../src/modules/delivery/deliveryService');
const {
  registrarDigestCandidateDecisionsCanonicas,
} = require('../src/modules/mia/digestCandidateDecisions');
const { crearSupabaseMemoria } = require('./helpers/inMemorySupabase');

const FECHA = '2026-08-05';
// Numero de pruebas: ningun envio sale de aqui, el proveedor esta simulado.
const TELEFONO_PRUEBA = '34600000000';

let aprobados = 0;
function ok(nombre) {
  aprobados++;
  console.log(`OK: ${nombre}`);
}

function oficial(valor, evidencia) {
  return {
    valor,
    evidencia: evidencia || `Documento oficial: ${valor}`,
    source: 'raw_document.texto_raw',
    confidence: 0.95,
    evidence_level: 'official',
    status: 'verified',
  };
}

// Ficha real del 5-08-2026: el extractor no supo leer el territorio y escribio
// el centinela. Antes de la reparacion esto bloqueaba a todo el mundo.
const TERRITORIO_NO_DETECTADO = [{
  valor: 'no_detectado',
  evidencia: 'TERRITORIO: no_detectado',
  source: 'stored_text:structured',
  confidence: 0.72,
  evidence_level: 'supported',
  status: 'supported',
}];

function alertaEstatalSinTerritorio(id) {
  const fact_sheet = {
    schema_version: 'fact_sheet_v3',
    builder_version: 'fact_sheet_builder_v6',
    generated_at: `${FECHA}T04:00:00.000Z`,
    alerta_id: id,
    raw_document_id: `doc-${id}`,
    content_hash: `hash-${id}`,
    tipo_documento: oficial('ayuda'),
    tema_principal: oficial(`modernizacion agraria ${id}`),
    resumen_neutro: oficial('Convocatoria de ayudas para modernizar explotaciones agrarias.'),
    territorio: TERRITORIO_NO_DETECTADO,
    sectores: [oficial('agricultura')],
    subsectores: [oficial('olivar')],
    accion_requerida: oficial('Presentar la solicitud en el plazo indicado.'),
    accion_codigo: oficial('solicitar'),
    application_deadline: oficial('2026-09-18'),
    beneficiarios: oficial('Titulares de explotaciones agrarias.'),
    url_oficial: oficial(`https://www.boe.es/oficial/${id}`),
    truth_score: 96,
    risk_score: 4,
    evidence_coverage: 95,
    status: 'ready_for_digest',
    flags: [],
    reasons: [],
    resumen_estructurado: {},
  };
  return {
    id,
    titulo: `Extracto de convocatoria de ayudas ${id}`,
    resumen: 'Convocatoria de ayudas para modernizar explotaciones agrarias.',
    url: `https://www.boe.es/oficial/${id}`,
    fuente: 'BOE',
    provincias: [],
    sectores: ['agricultura'],
    subsectores: ['olivar'],
    tipos_alerta: ['ayuda'],
    decision_digest: { score: 90, incluir: true, action: 'include' },
    fact_sheet,
  };
}

function usuario(id, provincia, subsector) {
  return {
    id,
    first_name: `Persona ${id}`,
    subscription: 'cooperativa',
    phone: TELEFONO_PRUEBA,
    phone_verified: true,
    preferences: {
      provincias: [provincia],
      sectores: ['agricultura'],
      subsectores: [subsector],
      frecuencia: 'daily',
    },
  };
}

function juezQueAprueba(contador) {
  return async (request) => {
    contador.llamadas++;
    const evidencia = request.input.untrusted_alert_data.evidence;
    const campos = ['title', 'summary', 'territory', 'beneficiaries', 'action', 'deadline', 'official_url']
      .filter((campo) => evidencia[campo]);
    return {
      contract_version: CONTRACT_VERSIONS.decision,
      policy_version: CONTRACT_VERSIONS.policy,
      decision: DECISION_STATES.ADD_TO_DIGEST,
      applicability: 0.95,
      usefulness: 0.9,
      actionability: 0.88,
      urgency: 0.4,
      novelty: 0.9,
      confidence: 0.93,
      reason_codes: [REASON_CODES.ACTIVITY_MATCH],
      evidence_refs: campos.map((campo) => evidencia[campo].ref),
      missing_information: [],
      user_reason: 'Encaja con lo que sigues en tu perfil.',
      message_facts: campos.map((campo) => ({ field: campo, evidence_ref: evidencia[campo].ref })),
    };
  };
}

async function decidirPara(user, alertas) {
  const contador = { llamadas: 0 };
  const decision = await decidirAlertasDigest({
    supabase: null,
    alertas,
    user,
    perfilOperativo: { atomic_memories: [] },
    context: {
      now: `${FECHA}T09:00:00.000Z`,
      recentCommunications: [],
      recentDeliveries: [],
      usedIdempotencyKeys: [],
    },
    caller: juezQueAprueba(contador),
    budget: createDailyJudgeBudget({ maxCalls: 20 }),
    policy: { topK: 10, maxItems: 3 },
  });
  return { decision, llamadasJuez: contador.llamadas };
}

function itemEnviable({ digestId, userId, alertId }) {
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
  // ── Paso 1: una sola persona interna ────────────────────────────────────
  const interna = usuario(143, 'Cordoba', 'olivar');
  const alerta = alertaEstatalSinTerritorio(21335);
  const { decision } = await decidirPara(interna, [alerta]);

  assert.strictEqual(
    decision.alertas.length,
    1,
    'la convocatoria estatal llega a la persona: era el fallo del 5-08-2026'
  );
  const auditada = decision.audit_decisions.find((item) => item.id === 21335);
  assert.strictEqual(auditada.decision, DECISION_STATES.ADD_TO_DIGEST);
  ok('Un usuario interno con alertas validas produce decision de envio');

  const db = crearSupabaseMemoria({
    users: [{ id: 143, phone: TELEFONO_PRUEBA, phone_verified: true }],
    alertas: [alerta],
    digests: [],
    digest_items: [],
    digest_attempts: [],
    digest_candidate_decisions: [],
    mia_outbox: [],
    whatsapp_logs: [],
    whatsapp_delivery_events: [],
  });

  // Auditoria: cada decision deja fila con su traza.
  const auditoria = await registrarDigestCandidateDecisionsCanonicas(db, {
    userId: interna.id,
    fecha: FECHA,
    stage: 'personal_relevance_judge',
    decisions: decision.audit_decisions,
    metadata: { contract_version: decision.contract_version },
  });
  assert.strictEqual(auditoria.ok, true, 'la auditoria canonica se guarda');
  assert.strictEqual(
    db.tables.digest_candidate_decisions.length,
    decision.audit_decisions.length,
    'hay una fila auditable por decision'
  );
  for (const fila of db.tables.digest_candidate_decisions) {
    assert.strictEqual(typeof fila.llm_calls, 'number', 'llm_calls nunca va null');
    assert.strictEqual(typeof fila.cache_hit, 'boolean');
    assert(Array.isArray(fila.reason_codes));
  }
  ok('La auditoria queda completa y sin columnas obligatorias en null');

  const mensaje = renderDecisionDigestMessage({
    user: interna,
    alertas: decision.alertas,
    fecha: FECHA,
  });
  assert(mensaje.message?.includes('Fuente oficial:'), 'el mensaje conserva la fuente oficial');

  db.tables.digests.push({
    id: 500,
    user_id: interna.id,
    fecha: FECHA,
    mensaje: mensaje.message,
    enviado: false,
    delivery_status: 'APPROVED',
    created_at: `${FECHA}T05:05:00.000Z`,
  });
  db.tables.digest_items.push(itemEnviable({ digestId: 500, userId: interna.id, alertId: 21335 }));
  db.tables.digest_attempts.push({
    id: 900, digest_id: 500, user_id: interna.id, fecha: FECHA, status: 'generated',
  });
  ok('Se crea el digest de la persona con su mensaje y su item');

  const encolado = await encolarDigestsPendientes(db, {
    fecha: FECHA,
    ahora: () => new Date(`${FECHA}T05:06:00.000Z`),
  });
  assert.strictEqual(encolado.encolados, 1, 'se crea el registro de outbox');
  assert.strictEqual(db.tables.mia_outbox.length, 1);
  assert.strictEqual(db.tables.mia_outbox[0].user_id, interna.id);
  ok('Se crea el registro de outbox listo para enviar');

  // Envio simulado: solo al numero de pruebas y sin proveedor real.
  const destinos = [];
  const aceptado = await procesarOutboxItemMIA(db, db.tables.mia_outbox[0], async (payload) => {
    destinos.push(payload?.to ?? payload?.telefono ?? TELEFONO_PRUEBA);
    return { providerMessageId: 'provider-validacion-500', providerStatus: 'pending' };
  });
  assert.strictEqual(aceptado.status, 'provider_accepted');
  assert.strictEqual(
    db.tables.digests[0].delivery_status,
    'PROVIDER_ACCEPTED',
    'aceptado por el proveedor es un estado propio'
  );
  assert.strictEqual(db.tables.digests[0].enviado, false, 'aceptado todavia no es entregado');
  assert(destinos.every((destino) => String(destino).includes(TELEFONO_PRUEBA) || destino === undefined),
    'solo se contacta el numero de pruebas');
  ok('El envio simulado queda en PROVIDER_ACCEPTED sin marcarse como entregado');

  await procesarAckUltraMsg(db, {
    event_type: 'message_ack',
    data: { id: 'provider-validacion-500', ack: 'device', time: 1786000000 },
  });
  assert.strictEqual(db.tables.digests[0].delivery_status, 'DELIVERED');
  assert.strictEqual(db.tables.digests[0].enviado, true);

  // Reenvio del mismo ACK: no repite efectos.
  const eventosAntes = db.tables.whatsapp_delivery_events.length;
  await procesarAckUltraMsg(db, {
    event_type: 'message_ack',
    data: { id: 'provider-validacion-500', ack: 'device', time: 1786000000 },
  });
  assert.strictEqual(
    db.tables.whatsapp_delivery_events.length,
    eventosAntes,
    'el ACK repetido no duplica el evento'
  );
  assert.strictEqual(db.tables.digests[0].delivery_status, 'DELIVERED');
  ok('El ACK del proveedor confirma la entrega y su reenvio no repite efectos');

  // Reintento del mismo dia: el digest ya existe y no se encola dos veces.
  const reintento = await encolarDigestsPendientes(db, {
    fecha: FECHA,
    ahora: () => new Date(`${FECHA}T06:00:00.000Z`),
  });
  assert.strictEqual(reintento.encolados, 0, 'un reintento del mismo dia no reenvia lo ya entregado');
  assert.strictEqual(db.tables.mia_outbox.length, 1);
  ok('Reintentar el mismo dia no duplica el envio');

  // ── Paso 2: cinco personas de provincias distintas ──────────────────────
  const equipo = [
    usuario(143, 'Cordoba', 'olivar'),
    usuario(89, 'Huesca', 'olivar'),
    usuario(137, 'Teruel', 'olivar'),
    usuario(151, 'Navarra', 'olivar'),
    usuario(152, 'Madrid', 'olivar'),
  ];
  const alertasDia = [
    alertaEstatalSinTerritorio(21335),
    alertaEstatalSinTerritorio(21336),
  ];

  const resultados = [];
  for (const persona of equipo) {
    const { decision: suya } = await decidirPara(persona, alertasDia);
    resultados.push({ userId: persona.id, incluidas: suya.alertas.length, decision: suya });
  }
  assert.strictEqual(
    resultados.filter((item) => item.incluidas > 0).length,
    5,
    'las cinco personas reciben la convocatoria estatal'
  );
  ok('Las cinco personas de provincias distintas reciben la convocatoria estatal');

  // Una persona sin alertas: silencio legitimo, no error, y no frena al resto.
  const sinAlertas = usuario(153, 'Sevilla', 'olivar');
  const { decision: silencio } = await decidirPara(sinAlertas, []);
  assert.strictEqual(silencio.alertas.length, 0, 'sin candidatas no hay digest');
  const auditoriaVacia = await registrarDigestCandidateDecisionsCanonicas(db, {
    userId: sinAlertas.id,
    fecha: FECHA,
    stage: 'personal_relevance_judge',
    decisions: silencio.audit_decisions,
  });
  assert.strictEqual(auditoriaVacia.ok, true, 'el silencio no es un fallo de auditoria');
  ok('Una persona sin alertas es silencio legitimo y no rompe el lote');

  // Ningun intento queda en evaluating al terminar.
  const colgados = db.tables.digest_attempts.filter((item) => item.status === 'evaluating');
  assert.strictEqual(colgados.length, 0, 'ningun intento queda colgado en evaluating');
  ok('Ningun intento queda en evaluating al terminar la validacion');

  console.log(`\nResultados validacion progresiva: ${aprobados} aprobados, 0 fallidos`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
