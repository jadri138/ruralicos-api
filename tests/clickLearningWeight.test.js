process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  CLICK_INTEREST_WEIGHT,
} = require('../src/modules/feedback/clicks.routes');
const {
  calcularAjusteClickTag,
  limitarScore,
} = require('../src/modules/aprendizaje/userInterestProfile');

assert(CLICK_INTEREST_WEIGHT > 0 && CLICK_INTEREST_WEIGHT < 0.5);

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'modules', 'feedback', 'clicks.routes.js'),
  'utf8'
);
assert(source.includes('aplicarClickAlPerfil'));
assert(source.includes('strength: CLICK_INTEREST_WEIGHT'));
assert(source.includes("source: 'click'"));
assert.strictEqual(calcularAjusteClickTag('provincia:teruel'), 0);
assert.strictEqual(calcularAjusteClickTag('sector:agricultura'), 0);
assert.strictEqual(calcularAjusteClickTag('fuente:boe'), 0);
assert.strictEqual(calcularAjusteClickTag('concepto:agua_riego'), 0.12);
assert.strictEqual(calcularAjusteClickTag('tipo:ayudas_subvenciones'), 0.06);
assert.strictEqual(limitarScore(20), 5);
assert.strictEqual(limitarScore(-20), -5);

console.log('OK: los clicks aprenden temas concretos con peso debil y limites seguros');
