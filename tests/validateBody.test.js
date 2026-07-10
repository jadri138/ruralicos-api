// Tests del middleware de validacion de borde (zod): aditivo (loose, opcional,
// sin transformar), corta tipos imposibles y tamanos absurdos con 400 uniforme.

const assert = require('assert');
const { validarBody, escalarCorto } = require('../src/middleware/validate');

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

function ejecutar(middleware, body) {
  const req = { body, id: 'req-test-1' };
  const res = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(p) { this.payload = p; return this; },
  };
  let siguio = false;
  middleware(req, res, () => { siguio = true; });
  return { req, res, siguio };
}

const mw = validarBody({
  phone: escalarCorto(32, 'telefono'),
  password: escalarCorto(200, 'contrasena'),
});

console.log('\n=== TESTS: validarBody (validacion de borde con zod) ===\n');

test('cuerpo valido pasa y conserva los campos no declarados (loose)', () => {
  const { req, siguio } = ejecutar(mw, { phone: '634111222', password: 'x', extra: { a: 1 } });
  assert(siguio, 'debe llamar a next()');
  assert.strictEqual(req.body.phone, '634111222');
  assert.deepStrictEqual(req.body.extra, { a: 1 }, 'los campos extra no se pierden');
});

test('campos ausentes pasan (la presencia la decide el handler)', () => {
  const { siguio } = ejecutar(mw, {});
  assert(siguio, 'cuerpo vacio pasa; el handler dara su mensaje de "falta X"');
});

test('telefono como numero JSON pasa (compat con clientes viejos)', () => {
  const { siguio } = ejecutar(mw, { phone: 634111222, password: 'x' });
  assert(siguio);
});

test('body null/undefined se trata como objeto vacio y pasa', () => {
  const { siguio } = ejecutar(mw, undefined);
  assert(siguio);
});

test('password sobredimensionado se corta con 400 antes de llegar a bcrypt', () => {
  const { res, siguio } = ejecutar(mw, { phone: '6', password: 'a'.repeat(5000) });
  assert(!siguio, 'no debe llegar al handler');
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.payload.code, 'validacion');
  assert.strictEqual(res.payload.request_id, 'req-test-1');
  assert(String(res.payload.error).includes('contrasena'), `mensaje inesperado: ${res.payload.error}`);
});

test('un objeto donde va un escalar se rechaza con mensaje en castellano', () => {
  const { res, siguio } = ejecutar(mw, { phone: { $ne: null }, password: 'x' });
  assert(!siguio);
  assert.strictEqual(res.statusCode, 400);
  assert(String(res.payload.error).includes('telefono'), `mensaje inesperado: ${res.payload.error}`);
});

test('cuerpo que no es objeto JSON (array) se rechaza', () => {
  const { res, siguio } = ejecutar(mw, [1, 2, 3]);
  assert(!siguio);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.payload.code, 'validacion');
});

test('los detalles enumeran cada campo invalido', () => {
  const { res } = ejecutar(mw, { phone: 'x'.repeat(50), password: 'y'.repeat(500) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.payload.detalles.length, 2);
  const campos = res.payload.detalles.map((d) => d.campo).sort();
  assert.deepStrictEqual(campos, ['password', 'phone']);
});

console.log(`\nResultados validarBody: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
