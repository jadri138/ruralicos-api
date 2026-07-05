const assert = require('assert');
const {
  getInternalBaseUrl,
  getRequestBaseUrl,
  normalizarBaseUrl,
} = require('../src/shared/internalBaseUrl');

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

function fakeReq(headers = {}, protocol = 'https') {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    protocol,
    headers: lowerHeaders,
    get(name) {
      return lowerHeaders[String(name).toLowerCase()];
    },
  };
}

console.log('\n=== TESTS: internal base url ===\n');

test('normaliza URL valida y quita barra final', () => {
  assert.strictEqual(normalizarBaseUrl('https://ruralicos-api.onrender.com///'), 'https://ruralicos-api.onrender.com');
  assert.strictEqual(normalizarBaseUrl('ftp://ruralicos-api.onrender.com'), '');
  assert.strictEqual(normalizarBaseUrl('no-es-url'), '');
});

test('construye base desde request y x-forwarded-proto', () => {
  const req = fakeReq({
    host: 'ruralicos-api.onrender.com',
    'x-forwarded-proto': 'https',
  }, 'http');

  assert.strictEqual(getRequestBaseUrl(req), 'https://ruralicos-api.onrender.com');
});

test('PIPELINE_INTERNAL_BASE_URL gana si esta configurada', () => {
  const req = fakeReq({ host: 'ruralicos-api.onrender.com' });
  const env = {
    PIPELINE_INTERNAL_BASE_URL: 'https://internal.example.com/',
    PUBLIC_BASE_URL: 'https://api.ruralicos.es',
  };

  assert.strictEqual(getInternalBaseUrl(req, env), 'https://internal.example.com');
});

test('sin override usa host real de la peticion antes que PUBLIC_BASE_URL', () => {
  const req = fakeReq({
    host: 'ruralicos-api.onrender.com',
    'x-forwarded-proto': 'https',
  });
  const env = {
    PUBLIC_BASE_URL: 'https://api.ruralicos.es',
  };

  assert.strictEqual(getInternalBaseUrl(req, env), 'https://ruralicos-api.onrender.com');
});

test('sin request cae a PUBLIC_BASE_URL y despues localhost', () => {
  assert.strictEqual(
    getInternalBaseUrl(null, { PUBLIC_BASE_URL: 'https://api.ruralicos.es/' }),
    'https://api.ruralicos.es'
  );
  assert.strictEqual(getInternalBaseUrl(null, { PORT: 4000 }), 'http://localhost:4000');
});

console.log(`\nResultados internalBaseUrl: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
