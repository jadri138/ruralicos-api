const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const free = fs.readFileSync(path.join(root, 'src/modules/alertas/alertasFree.routes.js'), 'utf8');
const exploration = fs.readFileSync(path.join(root, 'src/modules/aprendizaje/cerebro.routes.js'), 'utf8');
const digest = fs.readFileSync(path.join(root, 'src/modules/digest/digest.routes.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, 'scripts/run_digest_workflow.js'), 'utf8');

for (const [name, source] of [['FREE', free], ['exploración', exploration], ['digest', digest]]) {
  assert(source.includes('encolarComunicacionWhatsApp') || source.includes('encolarDigestsPendientes'), `${name} debe usar la cola única`);
  assert(!source.includes('enviarMensajeUltraMsg'), `${name} no debe llamar al proveedor directamente`);
  assert(!source.includes('enviarDigestPro'), `${name} no debe usar un emisor paralelo`);
}

assert(
  workflow.indexOf("'/alertas/enviar-resumen-free'") < workflow.indexOf('const entregarOutbox = await runOutboxStep()'),
  'FREE debe quedar encolado antes de drenar la única cola',
);
assert.strictEqual(
  (workflow.match(/async function runOutboxStep/g) || []).length,
  1,
  'solo debe existir una implementación del drenador',
);
assert.strictEqual(
  (workflow.match(/runOutboxStep\(\)/g) || []).length,
  2,
  'el mismo drenador se usa tras el digest y, si hace falta, tras la exploración',
);
assert(
  workflow.includes('Number(exploracionDiaria?.encoladas || 0) > 0'),
  'la segunda llamada solo se permite cuando la exploración ha encolado preguntas',
);

console.log('OK: digest, FREE y exploración comparten el mismo controlador de comunicaciones.');
