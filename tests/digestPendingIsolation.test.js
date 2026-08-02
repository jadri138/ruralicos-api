const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'modules', 'digest', 'digest.routes.js'),
  'utf8'
);

assert(
  !source.includes('pendientes_ia') && !source.includes('ESTADOS_PENDIENTES_AUTOMATICOS'),
  'una alerta aún pendiente no debe bloquear el digest de todas las demás'
);
assert(
  source.includes('cargarAlertasListasDigest'),
  'el digest debe continuar leyendo únicamente las alertas que ya están listas'
);

console.log('OK: una alerta pendiente queda aislada y no bloquea todo el digest');
