process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  CLICK_INTEREST_WEIGHT,
} = require('../src/modules/feedback/clicks.routes');

assert(CLICK_INTEREST_WEIGHT > 0 && CLICK_INTEREST_WEIGHT < 0.5);

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'modules', 'feedback', 'clicks.routes.js'),
  'utf8'
);
assert(!source.includes('aplicarFeedbackAlPerfil'));
assert(source.includes('peso_inicial: CLICK_INTEREST_WEIGHT'));

console.log('OK: los clicks siguen siendo una senal positiva debil y no refuerzan todos los tags');
