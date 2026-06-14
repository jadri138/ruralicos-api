process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { __testing } = require('../src/platform/whatsapp');

function test(name, fn) {
  try {
    fn();
    console.log(`OK: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('\n=== TESTS: admin alert recipients ===\n');

test('lee telefonos admin explicitos y deduplica', () => {
  const phones = __testing.getAdminAlertPhones({
    ADMIN_ALERT_PHONE: '34600000001',
    ADMIN_ALERT_PHONES: '34600000002, 34600000001;34600000003',
  });

  assert.deepStrictEqual(phones, ['34600000001', '34600000002', '34600000003']);
});

test('enmascara telefonos en errores operativos', () => {
  assert.strictEqual(__testing.maskPhone('34612345678'), '****5678');
  assert.strictEqual(__testing.maskPhone(''), null);
});

test('el aviso admin no consulta usuarios free como destinatarios', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/platform/whatsapp/mensajes.js'), 'utf8');
  const start = source.indexOf('async function enviarWhatsAppAdmin');
  const end = source.indexOf('module.exports =', start);
  const block = source.slice(start, end);

  assert(!block.includes(".eq('subscription', 'free')"), 'No debe mandar avisos internos a usuarios free');
  assert(block.includes('getAdminAlertPhones'), 'Debe usar telefonos admin configurados explicitamente');
});
