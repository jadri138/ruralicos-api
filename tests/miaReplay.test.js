const {
  analizarWebhookEventParaReplay,
  filtrarEventosReplay,
  ocultarTelefono,
  resumirTexto,
} = require('../src/mia/replay');

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

console.log('\n=== TESTS: mia replay ===\n');

const tokenMissingEvent = {
  id: 72,
  source: 'ultramsg',
  processed: false,
  result_json: { ok: false, ignored: true, reason: 'webhook_token_no_configurado' },
  body_json: {
    event_type: 'message',
    data: {
      from: '34644899647@c.us',
      body: 'Me gustaria recibir avisos sobre la PAC y tractores',
      id: 'wamid.TEST-72',
    },
  },
  created_at: '2026-05-22T18:10:00Z',
};

const candidate = analizarWebhookEventParaReplay(tokenMissingEvent);
assert(candidate.eligible === true, 'Marca como replay seguro un webhook bloqueado por token');
assert(candidate.phone === undefined, 'Oculta telefono completo por defecto');
assert(candidate.phone_preview === '3464...647', 'Devuelve telefono enmascarado');
assert(candidate.text_preview.includes('PAC'), 'Devuelve preview de texto util');

const rawCandidate = analizarWebhookEventParaReplay(tokenMissingEvent, { includeRaw: true });
assert(rawCandidate.phone === '34644899647', 'Permite incluir telefono completo bajo includeRaw');

const newsletterEvent = {
  ...tokenMissingEvent,
  id: 73,
  body_json: {
    event_type: 'message',
    data: {
      from: '120363215146551718@newsletter',
      body: 'Boletin externo',
    },
  },
};

const newsletter = analizarWebhookEventParaReplay(newsletterEvent);
assert(newsletter.eligible === false, 'No replayea newsletters');
assert(newsletter.blockers.includes('canal_no_usuario'), 'Explica bloqueo por canal no usuario');

const unknownReason = {
  ...tokenMissingEvent,
  id: 74,
  result_json: { ok: true, ignored: true, reason: 'usuario_no_encontrado' },
};
const forceable = analizarWebhookEventParaReplay(unknownReason);
assert(forceable.eligible === false && forceable.forceable === true, 'Permite forzar casos validos no seguros por defecto');

const replayables = filtrarEventosReplay([tokenMissingEvent, newsletterEvent, unknownReason]);
assert(replayables.length === 1 && replayables[0].id === 72, 'Filtra solo replayables seguros por defecto');

const replayablesForce = filtrarEventosReplay([tokenMissingEvent, newsletterEvent, unknownReason], { force: true });
assert(replayablesForce.length === 2, 'Con force incluye candidatos forceables sin blockers');

const invalidToken = {
  ...tokenMissingEvent,
  id: 75,
  result_json: { ok: false, ignored: true, reason: 'webhook_token_invalido' },
};
const invalidTokenCandidate = analizarWebhookEventParaReplay(invalidToken);
assert(invalidTokenCandidate.eligible === false && invalidTokenCandidate.forceable === true, 'Token invalido requiere force');

assert(ocultarTelefono('34644899647') === '3464...647', 'Oculta telefono de forma estable');
assert(resumirTexto('a '.repeat(200)).length <= 220, 'Recorta textos largos para la consola');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
