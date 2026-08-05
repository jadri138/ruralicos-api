const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { diagnosticarCoberturaDigest } = require('../scripts/diagnostico_cobertura_digest');

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

console.log('\n=== TESTS: diagnostico de cobertura del digest ===\n');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'diagnostico_cobertura_digest.js'),
  'utf8'
);

// Se comprueba el codigo real: los comentarios sí nombran WhatsApp o la IA
// justamente para decir que no se usan.
const codigo = source
  .split('\n')
  .filter((linea) => !/^\s*(\/\/|\*|\/\*)/.test(linea))
  .join('\n');

test('el diagnostico no puede enviar, escribir ni llamar a la IA', () => {
  for (const prohibido of [
    'whatsapp', 'ultramsg', 'openai', 'llamarIA',
    '.insert(', '.upsert(', '.update(', '.delete(', '.rpc(',
    'construirFactSheetAlerta', 'guardarFactSheet',
  ]) {
    assert(
      !codigo.toLowerCase().includes(prohibido.toLowerCase()),
      `el diagnostico no debe usar ${prohibido}: es de solo lectura`
    );
  }
  // Lo unico que toca la base son lecturas.
  assert(codigo.includes('.select('), 'debe leer de Supabase');
});

// Supabase doble: devuelve alertas, usuarios y fichas sin red.
function supabaseFalso({ alertas = [], usuarios = [], fichas = [] } = {}) {
  const tabla = (filas) => {
    const query = {
      select: () => query,
      eq: () => query,
      gte: () => query,
      lte: () => query,
      in: () => query,
      or: () => query,
      then: (resolve) => resolve({ data: filas, error: null }),
    };
    return query;
  };
  return {
    from(nombre) {
      if (nombre === 'alertas') return tabla(alertas);
      if (nombre === 'users') return tabla(usuarios);
      if (nombre === 'alert_fact_sheets') return tabla(fichas);
      return tabla([]);
    },
  };
}

const alertaAragon = {
  id: 900,
  titulo: 'Convocatoria de ayudas a la modernizacion de explotaciones en Aragon',
  contenido: 'Convocatoria de ayudas agrarias con ambito en Aragon. Beneficiarios: titulares de explotaciones.',
  resumen_final: 'Ayudas para agricultura en Aragon dirigidas a titulares de explotaciones agrarias.',
  url: 'https://example.org/oficial/900',
  fecha: '2026-08-05',
  fuente: 'BOA',
  provincias: ['Aragón'],
  sectores: ['agricultura'],
  subsectores: ['cereal'],
  tipos_alerta: ['ayudas_subvenciones'],
  estado_ia: 'listo',
};

testAsync('cuenta personas con material y explica donde cae el resto', async () => {
  const informe = await diagnosticarCoberturaDigest({
    supabase: supabaseFalso({
      alertas: [alertaAragon],
      usuarios: [{
        id: 1,
        subscription: 'agricultor',
        preferences: { provincias: ['Teruel'], sectores: ['agricultura'] },
      }],
    }),
    fecha: '2026-08-05',
    now: new Date('2026-08-05T09:00:00.000Z'),
  });

  assert.strictEqual(informe.alertas_del_dia, 1);
  assert.strictEqual(informe.usuarios, 1);
  assert.strictEqual(typeof informe.usuarios_con_alerta_aprobada, 'number');
  assert.strictEqual(typeof informe.bloqueos, 'object');
  // Una convocatoria aragonesa debe considerarse candidata para Teruel.
  assert.strictEqual(informe.usuarios_sin_candidatas, 0, 'Aragón cubre Teruel');
});

testAsync('un dia sin alertas no rompe el informe', async () => {
  const informe = await diagnosticarCoberturaDigest({
    supabase: supabaseFalso({ alertas: [], usuarios: [] }),
    fecha: '2026-08-05',
  });

  assert.strictEqual(informe.alertas_del_dia, 0);
  assert.strictEqual(informe.parejas_evaluadas, 0);
  assert.strictEqual(informe.usuarios_con_alerta_aprobada, 0);
});

setTimeout(() => {
  console.log(`\nResultados diagnosticoCobertura: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}, 200);
