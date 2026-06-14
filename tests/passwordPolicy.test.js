const assert = require('assert');
const { validarPassword } = require('../src/shared/passwordPolicy');

function ok(password, message) {
  assert.strictEqual(validarPassword(password).ok, true, message);
}

function ko(password, missing, message) {
  const result = validarPassword(password);
  assert.strictEqual(result.ok, false, message);
  assert(result.missing.includes(missing), `${message}: falta ${missing}`);
}

console.log('\n=== TESTS: password policy ===\n');

ok('Ruralicos1!', 'Acepta 8+ caracteres con mayuscula, numero y simbolo');
ko('ruralicos1!', 'uppercase', 'Rechaza sin mayuscula');
ko('Ruralicos!', 'number', 'Rechaza sin numero');
ko('Ruralicos1', 'special_character', 'Rechaza sin simbolo');
ko('Rura1!', 'min_length', 'Rechaza menos de 8 caracteres');

console.log('Resultados passwordPolicy: 5 aprobados, 0 fallidos');
