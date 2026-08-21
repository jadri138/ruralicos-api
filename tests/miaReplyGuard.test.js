const {
  limpiarRespuestaMIA,
  limpiarTerminosInternosMIA,
  formatearRespuestaWhatsAppMIA,
  hacerReferenciasVisiblesMIA,
  evaluarRespuestaMIA,
  contienePatronProhibido,
} = require('../src/modules/mia/replyGuard');
const { construirOutboxDesdeDecision } = require('../src/modules/mia/outbox');

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
assert(whatsapp.text.startsWith('*Ruralicos · MIA*'), 'Identifica de forma breve a MIA y Ruralicos');
assert(!whatsapp.text.includes('_Respuesta autom'), 'No repite un descargo generico en cada respuesta');
assert(!/\bdigest\b/i.test(whatsapp.text), 'No deja digest en la respuesta final');

const referenciasVisibles = hacerReferenciasVisiblesMIA('He encontrado una referencia [E1].', [{
  ref: 'E1',
  titulo: 'Ayuda agraria',
  url: 'https://example.com/ayuda',
}]);
assert(!referenciasVisibles.text.includes('[E1]'), 'No muestra etiquetas internas de evidencia');
assert(referenciasVisibles.text.includes('Fuente oficial: https://example.com/ayuda'), 'Muestra la fuente oficial al usuario');

const audit = evaluarRespuestaMIA('MIA ha encontrado referencias relacionadas.', {
  decision: {
    auto_answered: true,
    policy: { outcome: 'auto_answer', requires_agent: false },
    knowledge_context: { answered: true, tipo_pregunta: 'general' },
  },
});
assert(audit.flags.includes('auto_answer_without_visible_evidence'), 'Audita auto-respuesta sin evidencia visible');

const emptySearchAudit = evaluarRespuestaMIA('No he encontrado alertas publicadas ayer.', {
  decision: {
    auto_answered: true,
    policy: { outcome: 'auto_answer', requires_agent: false },
    knowledge_context: {
      answered: true,
      tipo_pregunta: 'general',
      answer_source: 'alerts_search_no_results',
      search_completed: true,
      retrieval: { scope: 'alertas', search_completed: true },
    },
  },
});
assert(!emptySearchAudit.flags.includes('auto_answer_without_visible_evidence'), 'No exige un enlace cuando la busqueda comprobada no devuelve alertas');

const emptyToolSearchAudit = evaluarRespuestaMIA('No he encontrado alertas publicadas el dia 13.', {
  decision: {
    auto_answered: true,
    policy: { outcome: 'auto_answer', requires_agent: false },
    knowledge_context: {
      answered: true,
      tipo_pregunta: 'fecha_publicacion',
      answer_source: 'mia_tool_agent_no_results',
      search_completed: true,
      retrieval: { scope: 'alertas', search_completed: true },
    },
  },
});
assert(!emptyToolSearchAudit.flags.includes('auto_answer_without_visible_evidence'), 'Acepta la ausencia comprobada por la herramienta de alertas');

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
    knowledge_context: {
      answered: true,
      grounded_evidences: [{ ref: 'E1', titulo: 'Ayuda agraria', url: 'https://example.com/ayuda' }],
    },
  },
});
assert(outbox.body.startsWith('*Ruralicos · MIA*'), 'Outbox aplica cabecera breve antes de enviar');
assert(!outbox.body.includes('_Respuesta autom'), 'Outbox no anade texto generico repetitivo');
assert(!outbox.body.includes('[E1]'), 'Outbox elimina referencias internas');
assert(outbox.body.includes('Fuente oficial: https://example.com/ayuda'), 'Outbox conserva una fuente verificable');
assert(outbox.body.includes('He encontrado'), 'Outbox conserva el cuerpo limpio de respuesta');
assert(!outbox.body.includes('MIA ha encontrado'), 'Outbox evita autorreferencias poco naturales');
assert(outbox.metadata_json.reply_guard.flags.includes('removed_personal_greeting'), 'Outbox guarda flags del guard');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
