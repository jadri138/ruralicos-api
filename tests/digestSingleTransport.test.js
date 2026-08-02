const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routeSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'modules', 'digest', 'digest.routes.js'),
  'utf8'
);

assert(routeSource.includes('encolarDigestsPendientes'));
assert(!routeSource.includes('enviarDigestPro'));
assert(!routeSource.includes('digestViaOutboxHabilitado'));
assert(!routeSource.includes('DIGEST_VIA_OUTBOX'));
assert(
  routeSource.includes('encolados: encolado.encolados') &&
    routeSource.includes('enviados: 0'),
  'encolar no debe presentarse como entrega'
);

console.log('OK: el digest usa una sola vía de transporte y encolar no equivale a entregar');
