// Tests de la revocacion de sesiones por version de credencial: el JWT lleva
// `tv`; si no coincide con token_version en BD la sesion esta revocada. Los
// tokens antiguos (sin tv) equivalen a version 0 para no desconectar a nadie
// en el deploy.

const assert = require('assert');
const {
  verificarVersionCredencial,
  bumpTokenVersion,
  invalidar,
} = require('../src/middleware/credentialVersion');

let passed = 0;
let failed = 0;

function test(name, fn) {
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
    });
}

// Supabase falso: from(tabla).select().eq().maybeSingle() -> respuesta fijada;
// update() registra las escrituras.
function fakeSupabase({ version = 0, filaExiste = true, selectError = null } = {}) {
  const escrituras = [];
  let consultas = 0;
  return {
    escrituras,
    get consultas() { return consultas; },
    from(tabla) {
      return {
        select() {
          consultas++;
          return {
            eq() {
              return {
                maybeSingle: async () => {
                  if (selectError) return { data: null, error: { message: selectError } };
                  return { data: filaExiste ? { token_version: version } : null, error: null };
                },
              };
            },
          };
        },
        update(patch) {
          return {
            eq: async () => {
              escrituras.push({ tabla, patch });
              return { error: null };
            },
          };
        },
      };
    },
  };
}

console.log('\n=== TESTS: credentialVersion (revocacion de sesiones) ===\n');

test('token con tv vigente pasa', async () => {
  const db = fakeSupabase({ version: 3 });
  const r = await verificarVersionCredencial(db, { role: 'user', sub: 101, tv: 3 });
  assert.strictEqual(r.ok, true);
});

test('token con tv antiguo queda revocado', async () => {
  const db = fakeSupabase({ version: 4 });
  const r = await verificarVersionCredencial(db, { role: 'user', sub: 102, tv: 3 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'sesion_revocada');
});

test('token legacy SIN tv equivale a version 0 (no desconecta en el deploy)', async () => {
  const db = fakeSupabase({ version: 0 });
  const r = await verificarVersionCredencial(db, { role: 'user', sub: 103 });
  assert.strictEqual(r.ok, true);
});

test('cuenta borrada: token de fila inexistente queda fuera', async () => {
  const db = fakeSupabase({ filaExiste: false });
  const r = await verificarVersionCredencial(db, { role: 'user', sub: 104, tv: 0 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'cuenta_inexistente');
});

test('error de BD: fail-open (un blip no desconecta a los usuarios)', async () => {
  const db = fakeSupabase({ selectError: 'timeout' });
  const r = await verificarVersionCredencial(db, { role: 'user', sub: 105, tv: 9 });
  assert.strictEqual(r.ok, true);
});

test('impersonacion de soporte (org + impersonated_by) no comprueba version', async () => {
  const db = fakeSupabase({ version: 99 });
  const r = await verificarVersionCredencial(db, {
    role: 'org', sub: 'admin:1', impersonated_by: 1, tv: 0,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.consultas, 0, 'no debe tocar BD');
});

test('rol sin tabla asociada pasa sin tocar BD (p.ej. firstLogin legacy)', async () => {
  const db = fakeSupabase({});
  const r = await verificarVersionCredencial(db, { firstLogin: true, sub: 7 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.consultas, 0);
});

// OJO: los tests corren en paralelo y la cache es compartida a nivel de modulo;
// se usan ids unicos por test y se asierta por numero de consultas, no por
// tamano total de la cache.
test('la cache evita una segunda consulta dentro del TTL', async () => {
  const db = fakeSupabase({ version: 2 });
  await verificarVersionCredencial(db, { role: 'user', sub: 701, tv: 2 });
  await verificarVersionCredencial(db, { role: 'user', sub: 701, tv: 2 });
  assert.strictEqual(db.consultas, 1, 'la segunda comprobacion debe salir de cache');
});

test('bumpTokenVersion incrementa, escribe en la tabla del rol e invalida cache', async () => {
  const db = fakeSupabase({ version: 2 });
  const nueva = await bumpTokenVersion(db, 'org', 5);
  assert.strictEqual(nueva, 3);
  assert.strictEqual(db.escrituras[0].tabla, 'organization_staff');
  assert.strictEqual(db.escrituras[0].patch.token_version, 3);
});

test('invalidar fuerza a releer de BD en la siguiente comprobacion', async () => {
  const db = fakeSupabase({ version: 1 });
  await verificarVersionCredencial(db, { role: 'user', sub: 901, tv: 1 });
  assert.strictEqual(db.consultas, 1);
  invalidar('user', 901);
  await verificarVersionCredencial(db, { role: 'user', sub: 901, tv: 1 });
  assert.strictEqual(db.consultas, 2, 'tras invalidar debe volver a consultar BD');
});

process.on('exit', () => {
  console.log(`\nResultados credentialVersion: ${passed} aprobados, ${failed} fallidos`);
});
