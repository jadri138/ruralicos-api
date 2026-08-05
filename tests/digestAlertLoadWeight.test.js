const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { cargarAlertasListasDigest } = require('../src/modules/digest/digest.service');

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

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

console.log('\n=== TESTS: peso de la carga de alertas del digest ===\n');

// Supabase doble que solo recuerda que columnas se pidieron.
function supabaseEspia(registro) {
  const query = {
    select(columnas) { registro.push(columnas); return query; },
    eq: () => query,
    gte: () => query,
    lte: () => query,
    in: () => query,
    then: (resolve) => resolve({ data: [], error: null }),
  };
  return { from: () => query };
}

testAsync('por defecto trae el vector, para no cambiar a quien ya lo usa', async () => {
  const columnas = [];
  await cargarAlertasListasDigest(supabaseEspia(columnas), { fecha: '2026-08-05' });
  assert(columnas[0].includes('embedding'), 'el comportamiento por defecto se conserva');
});

testAsync('withEmbedding:false no pide el vector', async () => {
  const columnas = [];
  await cargarAlertasListasDigest(supabaseEspia(columnas), {
    fecha: '2026-08-05',
    withEmbedding: false,
  });
  // `embedding_generated_at` sí puede estar: lo que no debe venir es el vector.
  const pedidas = columnas[0].split(',').map((c) => c.trim());
  assert(!pedidas.includes('embedding'), 'el vector no debe pedirse');
  assert(pedidas.includes('id') && pedidas.includes('titulo'), 'el resto de columnas se conserva');
});

test('preparar-digest decide el peso segun el perfil vectorial de las personas', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'modules', 'digest', 'digest.routes.js'),
    'utf8'
  );
  assert(
    /necesitaVectores\s*=\s*\(usuarios[^\n]*perfil_embedding/.test(source),
    'debe calcularse a partir de perfil_embedding'
  );
  // Las tres cargas de alertas del handler deben respetar esa decision: la del
  // dia, la de holds reclamados y la del rescate, que abarca varios dias.
  const ocurrencias = source.match(/withEmbedding:\s*necesitaVectores/g) || [];
  assert.strictEqual(
    ocurrencias.length,
    3,
    `las tres cargas deben pasar withEmbedding (encontradas ${ocurrencias.length})`
  );
  // Los usuarios se cargan antes que las alertas: si no, no se puede decidir.
  assert(
    source.indexOf('cargarUsuariosPagoDigest(supabase)') < source.indexOf('cargarAlertasListasDigest(supabase, {'),
    'los usuarios deben cargarse antes que las alertas'
  );
});

setTimeout(() => {
  console.log(`\nResultados digestAlertLoadWeight: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}, 150);
