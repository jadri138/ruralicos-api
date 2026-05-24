const {
  limpiarRespuestaMIA,
  limpiarTerminosInternosMIA,
  formatearRespuestaWhatsAppMIA,
  evaluarRespuestaMIA,
  contienePatronProhibido,
} = require('../src/mia/replyGuard');
const { construirOutboxDesdeDecision } = require('../src/mia/outbox');

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

console.log('\n=== TESTS: mia reply guard ===\n');

assert(contienePatronProhibido('Que tengas buen dia en tu granja con tus vacas') === true, 'Detecta personalizacion rara');

const cleaned = limpiarRespuestaMIA('Hola Jorge Eduardo Garcia Sanchez\nMIA ha encontrado una referencia.\nQue tengas buen dia en tu granja con tus vacas.');
assert(!cleaned.text.includes('Hola Jorge'), 'Elimina saludo con nombre completo');
assert(!/granja|vacas/i.test(cleaned.text), 'Elimina despedida rara');
assert(cleaned.flags.includes('removed_weird_personalization'), 'Marca flag de personalizacion eliminada');
assert(cleaned.flags.includes('removed_personal_greeting'), 'Marca flag de saludo eliminado');

const sender = limpiarRespuestaMIA('Soy Jaime y te confirmo que lo reviso.');
assert(sender.text.includes('Ruralicos'), 'Sustituye Jaime por Ruralicos');
assert(sender.flags.includes('replaced_personal_sender'), 'Marca sustitucion de remitente personal');

const senderCooperativa = limpiarRespuestaMIA('Soy Jaime y mi pareja y yo lo miramos.', {
  senderName: 'Cooperativa Los Olivos',
  supportLabel: 'el equipo tecnico de Cooperativa Los Olivos',
});
assert(senderCooperativa.text.includes('Cooperativa Los Olivos'), 'Sustituye remitente personal por marca configurada');
assert(senderCooperativa.text.includes('equipo tecnico'), 'Sustituye referencias personales por equipo configurado');

const internos = limpiarTerminosInternosMIA('No hay novedades en el digest ni en outbox.');
assert(!/\bdigest\b|\boutbox\b/i.test(internos.text), 'Limpia terminos internos del texto visible');
assert(internos.text.includes('resumen de alertas'), 'Sustituye digest por lenguaje de usuario');

const whatsapp = formatearRespuestaWhatsAppMIA('No hay novedades en el digest.', {
  assistantName: 'MIA',
  senderName: 'Ruralicos',
  supportLabel: 'un agente de Ruralicos',
});
assert(whatsapp.text.startsWith('*MIA de Ruralicos*'), 'Anade cabecera de MIA en negrita');
assert(whatsapp.text.includes('_Respuesta autom'), 'Anade descargo en cursiva');
assert(!/\bdigest\b/i.test(whatsapp.text), 'No deja digest en la respuesta final');

const audit = evaluarRespuestaMIA('MIA ha encontrado referencias relacionadas.', {
  decision: {
    auto_answered: true,
    policy: { outcome: 'auto_answer', requires_agent: false },
    knowledge_context: { answered: true, tipo_pregunta: 'general' },
  },
});
assert(audit.flags.includes('auto_answer_without_visible_evidence'), 'Audita auto-respuesta sin evidencia visible');

const sensitive = evaluarRespuestaMIA('Te garantizo que pagan el 15 de junio [E1].', {
  decision: {
    policy: { outcome: 'auto_answer', requires_agent: false },
    knowledge_context: { answered: true, tipo_pregunta: 'pago' },
  },
});
assert(sensitive.flags.includes('sensitive_answer_without_agent_review'), 'Audita respuesta sensible sin agente');
assert(sensitive.flags.includes('overconfident_language'), 'Audita lenguaje demasiado seguro');

const outbox = construirOutboxDesdeDecision({
  userId: 1,
  toPhone: '34600000000',
  decision: {
    intent: 'pregunta_usuario',
    reply_action: {
      canal: 'whatsapp',
      texto: 'Hola Jose Luis Gomez Lorente\nMIA ha encontrado una referencia [E1].',
    },
    policy: { outcome: 'auto_answer', requires_agent: false },
    knowledge_context: { answered: true },
  },
});
assert(outbox.body.startsWith('*MIA de Ruralicos*'), 'Outbox aplica cabecera final antes de enviar');
assert(outbox.body.includes('_Respuesta autom'), 'Outbox aplica descargo antes de enviar');
assert(outbox.body.includes('MIA ha encontrado'), 'Outbox conserva el cuerpo limpio de respuesta');
assert(outbox.metadata_json.reply_guard.flags.includes('removed_personal_greeting'), 'Outbox guarda flags del guard');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
