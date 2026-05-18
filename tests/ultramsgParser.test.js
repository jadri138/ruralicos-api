const {
  extraerUltraMsg,
  esEventoMensajeUltraMsg,
  parseBoolean,
} = require('../src/utils/ultramsgParser');

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
    from: '34600000000@c.us',
    body: 'Me interesa la ayuda de olivar',
    fromMe: 'false',
  },
});

assert(payloadObjeto.eventType === 'message_received', 'Extrae event_type de UltraMsg');
assert(payloadObjeto.fromMe === false, 'No marca fromMe "false" como mensaje propio');
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

assert(esEventoMensajeUltraMsg('message_received') === true, 'Acepta message_received');
assert(esEventoMensajeUltraMsg('message') === true, 'Acepta message');
assert(esEventoMensajeUltraMsg('ack') === false, 'Rechaza eventos no conversacionales');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
