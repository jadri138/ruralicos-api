const assert = require('assert');
const { validarEntorno, asegurarEntorno } = require('../src/config/env');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

const ENV_COMPLETO = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  JWT_SECRET: 'un-secreto-suficientemente-largo',
  CRON_TOKEN: 'token-cron-largo',
  OPENAI_API_KEY: 'sk-test',
  PUBLIC_BASE_URL: 'https://ruralicos-api.onrender.com',
  ULTRAMSG_INSTANCE_ID: 'instance',
  ULTRAMSG_TOKEN: 'token',
  ULTRAMSG_WEBHOOK_TOKEN: 'webhook',
  ADMIN_ALERT_PHONE: '34600000000',
};

console.log('\n=== TESTS: config de entorno ===\n');

test('entorno completo valida ok sin avisos', () => {
  const r = validarEntorno(ENV_COMPLETO);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.faltantes, []);
  assert.deepStrictEqual(r.invalidas, []);
  assert.deepStrictEqual(r.avisos, []);
});

test('detecta variables criticas ausentes', () => {
  const { SUPABASE_URL: _url, CRON_TOKEN: _tok, ...resto } = ENV_COMPLETO;
  const r = validarEntorno(resto);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.faltantes.length, 2);
  assert(r.faltantes.some((f) => f.startsWith('SUPABASE_URL')));
  assert(r.faltantes.some((f) => f.startsWith('CRON_TOKEN')));
});

test('detecta formatos invalidos (URL sin http, secretos cortos)', () => {
  const r = validarEntorno({
    ...ENV_COMPLETO,
    PUBLIC_BASE_URL: 'ruralicos-api.onrender.com',
    JWT_SECRET: 'corto',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.invalidas.length, 2);
});

test('las recomendadas ausentes generan aviso pero no invalidan', () => {
  const { ULTRAMSG_INSTANCE_ID: _a, ADMIN_ALERT_PHONE: _b, ...resto } = ENV_COMPLETO;
  const r = validarEntorno(resto);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.avisos.length, 2);
});

test('ADMIN_ALERT_PHONES (alias plural) satisface la recomendada', () => {
  const { ADMIN_ALERT_PHONE: _a, ...resto } = ENV_COMPLETO;
  const r = validarEntorno({ ...resto, ADMIN_ALERT_PHONES: '34600000000,34600000001' });
  assert.deepStrictEqual(r.avisos, []);
});

test('detecta placeholders de plantilla sin rellenar', () => {
  const r = validarEntorno({
    ...ENV_COMPLETO,
    SUPABASE_SERVICE_ROLE_KEY: '<<< PEGA AQUI TU SERVICE ROLE KEY >>>',
    OPENAI_API_KEY: 'CHANGEME',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.invalidas.length, 2);
  assert(r.invalidas.every((i) => i.includes('placeholder')));
});

test('asegurarEntorno no mata el proceso fuera de produccion', () => {
  const r = asegurarEntorno({ NODE_ENV: 'development' }, { exitOnError: false });
  assert.strictEqual(r.ok, false);
});

console.log(`\nResultados envConfig: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
