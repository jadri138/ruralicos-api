// Test e2e del alias de versionado /v1: cada ruta responde IGUAL con y sin
// prefijo. Arranca la app real en un puerto efimero con env placeholder (sin
// tocar servicios: las comprobaciones usan rutas que responden antes de la BD,
// y /health responde aunque supabase no conteste).

const assert = require('assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'placeholder-jwt';
process.env.CRON_TOKEN = process.env.CRON_TOKEN || 'placeholder-cron';

const app = require('../src/app.js');

let passed = 0;
let failed = 0;
const pendientes = [];

function test(name, fn) {
  pendientes.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        passed += 1;
        console.log(`OK: ${name}`);
      })
      .catch((err) => {
        failed += 1;
        console.error(`FAIL: ${name}`);
        console.error(err.stack || err.message);
        process.exitCode = 1;
      })
  );
}

console.log('\n=== TESTS: alias de versionado /v1 ===\n');

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;

  test('POST /v1/login-phone responde igual que POST /login-phone (400 faltan datos)', async () => {
    const [conV1, sinV1] = await Promise.all([
      fetch(`${base}/v1/login-phone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      fetch(`${base}/login-phone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    ]);
    assert.strictEqual(conV1.status, 400);
    assert.strictEqual(conV1.status, sinV1.status);
    const [bodyV1, bodySin] = await Promise.all([conV1.json(), sinV1.json()]);
    assert.deepStrictEqual(bodyV1, bodySin, 'misma respuesta con y sin prefijo');
  });

  test('GET /v1/health llega a la ruta /health (mismo status y forma)', async () => {
    const [conV1, sinV1] = await Promise.all([
      fetch(`${base}/v1/health`),
      fetch(`${base}/health`),
    ]);
    assert.strictEqual(conV1.status, sinV1.status);
    const body = await conV1.json();
    assert(typeof body.ok === 'boolean', 'respuesta de /health con forma esperada');
  });

  test('una ruta inexistente bajo /v1 sigue siendo 404', async () => {
    const res = await fetch(`${base}/v1/no-existe-esta-ruta`);
    assert.strictEqual(res.status, 404);
  });

  test('el prefijo solo se quita a /v1 exacto (no a /v1x...)', async () => {
    const res = await fetch(`${base}/v1x/health`);
    assert.strictEqual(res.status, 404);
  });

  await Promise.allSettled(pendientes);
  server.close(() => {
    console.log(`\nResultados v1Alias: ${passed} aprobados, ${failed} fallidos`);
  });
});
