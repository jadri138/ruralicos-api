const {
  extraerUltraMsg,
  esEventoMensajeUltraMsg,
  parseBoolean,
} = require('../src/shared/ultramsgParser');

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

console.log('\n=== TESTS: ultramsgParser ===\n');

assert(parseBoolean(false) === false, 'Respeta boolean false');
assert(parseBoolean('false') === false, 'Interpreta string "false" como false');
assert(parseBoolean('0') === false, 'Interpreta string "0" como false');
assert(parseBoolean(true) === true, 'Respeta boolean true');
assert(parseBoolean('true') === true, 'Interpreta string "true" como true');

const payloadObjeto = extraerUltraMsg({
  event_type: 'message_received',
  data: {
    id: 'wamid.TEST-1',
    from: '34600000000@c.us',
    body: 'Me interesa la ayuda de olivar',
    fromMe: 'false',
    timestamp: 1779472800,
  },
});

assert(payloadObjeto.eventType === 'message_received', 'Extrae event_type de UltraMsg');
assert(payloadObjeto.fromMe === false, 'No marca fromMe "false" como mensaje propio');
assert(payloadObjeto.messageId === 'wamid.TEST-1', 'Extrae id del mensaje de UltraMsg');
assert(payloadObjeto.timestamp === '1779472800', 'Extrae timestamp del mensaje de UltraMsg');
assert(payloadObjeto.senderKind === 'user', 'Clasifica contactos normales como usuario');
assert(payloadObjeto.telefono === '34600000000', 'Limpia telefono con sufijo @c.us');
assert(payloadObjeto.texto === 'Me interesa la ayuda de olivar', 'Extrae texto de data.body');

const payloadJson = extraerUltraMsg({
  data: JSON.stringify({
    from: '+34 600 000 000@c.us',
    body: 'Quiero saber mas de la PAC',
    fromMe: false,
    type: 'message',
  }),
});

assert(payloadJson.fromMe === false, 'Parsea data JSON string');
assert(payloadJson.telefono === '34600000000', 'Normaliza telefono desde data JSON string');
assert(payloadJson.texto === 'Quiero saber mas de la PAC', 'Extrae texto desde data JSON string');

const payloadNewsletter = extraerUltraMsg({
  data: {
    from: '120363215146551718@newsletter',
    body: 'Contenido de canal',
  },
});
assert(payloadNewsletter.senderKind === 'newsletter', 'Clasifica newsletters de WhatsApp');

assert(esEventoMensajeUltraMsg('message_received') === true, 'Acepta message_received');
assert(esEventoMensajeUltraMsg('message') === true, 'Acepta message');
assert(esEventoMensajeUltraMsg('ack') === false, 'Rechaza eventos no conversacionales');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
