// Tests de responderError + requestContext: los errores 5xx nunca filtran
// detalle interno al cliente; los 4xx intencionados conservan su mensaje; y
// toda respuesta lleva request_id para cruzar con los logs.

const assert = require('assert');
const { responderError } = require('../src/shared/responderError');
const { requestContext } = require('../src/middleware/requestContext');
const { inicializarSentry, sentryActivo, capturarExcepcion } = require('../src/platform/sentry');

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
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
  };
  return res;
}

console.log('\n=== TESTS: responderError + requestContext ===\n');

test('un error inesperado devuelve 500 generico SIN el mensaje interno', () => {
  const res = fakeRes();
  const err = new Error('duplicate key value violates unique constraint "users_phone_key"');
  responderError({ id: 'abc123', method: 'GET', path: '/partner/members' }, res, err);

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.error, 'Error interno');
  assert.strictEqual(res.body.request_id, 'abc123');
  assert(!JSON.stringify(res.body).includes('unique constraint'), 'el detalle de Postgres no debe viajar al cliente');
});

test('un error intencionado con status 4xx conserva su mensaje', () => {
  const res = fakeRes();
  const err = Object.assign(new Error('Telefono no valido'), { status: 400 });
  responderError({ id: 'abc123' }, res, err);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'Telefono no valido');
  assert.strictEqual(res.body.request_id, 'abc123');
});

test('un err.status 5xx tambien se enmascara', () => {
  const res = fakeRes();
  const err = Object.assign(new Error('detalle interno'), { status: 502 });
  responderError({ id: 'x' }, res, err);
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.error, 'Error interno');
});

test('sin req.id responde igualmente (request_id null)', () => {
  const res = fakeRes();
  responderError(undefined, res, new Error('boom'));
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.request_id, null);
});

test('requestContext asigna req.id hex y lo expone en x-request-id', () => {
  const req = {};
  const res = fakeRes();
  let siguio = false;
  requestContext(req, res, () => { siguio = true; });

  assert(siguio, 'debe llamar a next()');
  assert(/^[0-9a-f]{16}$/.test(req.id), `req.id inesperado: ${req.id}`);
  assert.strictEqual(res.headers['x-request-id'], req.id);
});

test('cada peticion recibe un id distinto', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const req = {};
    requestContext(req, fakeRes(), () => {});
    ids.add(req.id);
  }
  assert.strictEqual(ids.size, 50);
});

test('sentry sin SENTRY_DSN: inactivo y capturarExcepcion es no-op seguro', () => {
  delete process.env.SENTRY_DSN;
  assert.strictEqual(inicializarSentry(), false);
  assert.strictEqual(sentryActivo(), false);
  // responderError la llama en cada 500: no debe lanzar nunca sin init.
  capturarExcepcion(new Error('x'), { request_id: 'r1', path: '/x' });
});

test('responderError sigue funcionando con la captura sentry integrada (500)', () => {
  const res = fakeRes();
  responderError({ id: 'zz', method: 'POST', path: '/webhooks/ultramsg/feedback' }, res, new Error('detalle'));
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.error, 'Error interno');
  assert.strictEqual(res.body.request_id, 'zz');
});

console.log(`\nResultados responderError: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
