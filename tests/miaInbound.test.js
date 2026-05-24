const {
  crearIdentidadMensajeMIA,
  normalizarTextoFingerprint,
  getFallbackDedupeMs,
} = require('../src/mia/inbound');

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

console.log('\n=== TESTS: mia inbound ===\n');

assert(
  normalizarTextoFingerprint('  Me GUSTARIA   recibir avisos  ') === 'me gustaria recibir avisos',
  'Normaliza espacios y mayusculas para fingerprint'
);

assert(getFallbackDedupeMs() >= 15 * 1000, 'Expone ventana minima de deduplicacion fallback');

const conId1 = crearIdentidadMensajeMIA({
  telefono: '34600000000',
  texto: '1',
  ultra: { messageId: 'wamid.TEST-1', timestamp: 1779472800 },
});

const conId2 = crearIdentidadMensajeMIA({
  telefono: '34600000000',
  texto: 'texto distinto',
  ultra: { messageId: 'wamid.TEST-1', timestamp: 1779472810 },
});

assert(
  conId1.message_fingerprint === conId2.message_fingerprint,
  'El mismo messageId genera el mismo fingerprint aunque cambie el texto'
);

const sinId1 = crearIdentidadMensajeMIA({
  telefono: '34600000000',
  texto: 'Me interesa la PAC',
  ultra: { timestamp: 1779472800 },
});

const sinId2 = crearIdentidadMensajeMIA({
  telefono: '34600000000',
  texto: '  me interesa   la pac ',
  ultra: { timestamp: 1779472810 },
});

assert(
  sinId1.message_fingerprint === sinId2.message_fingerprint,
  'Sin messageId detecta reintentos con mismo telefono/texto en la misma ventana temporal'
);

const sinId3 = crearIdentidadMensajeMIA({
  telefono: '34600000000',
  texto: 'Me interesa la PAC',
  ultra: { timestamp: 1779476400 },
});

assert(
  sinId1.message_fingerprint !== sinId3.message_fingerprint,
  'Sin messageId permite repetir el mismo texto pasado el bucket temporal'
);

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
