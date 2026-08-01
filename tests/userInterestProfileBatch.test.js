const assert = require('assert');

const {
  aplicarClickAlPerfil,
  aplicarFeedbackAlPerfil,
} = require('../src/modules/aprendizaje/userInterestProfile');

function fakeSupabase(existing = []) {
  const calls = { select: 0, upsert: 0, rows: [] };

  return {
    calls,
    from(table) {
      assert.strictEqual(table, 'user_interest_profile');
      return {
        select() {
          calls.select += 1;
          return {
            eq() {
              return {
                async in() {
                  return { data: existing, error: null };
                },
              };
            },
          };
        },
        async upsert(rows, options) {
          calls.upsert += 1;
          calls.rows = rows;
          assert.deepStrictEqual(options, { onConflict: 'user_id,tag' });
          return { error: null };
        },
      };
    },
  };
}

async function main() {
  const alerta = {
    titulo: 'Ayuda para modernizar olivar',
    subsectores: ['olivar'],
    tipos_alerta: ['ayudas'],
    taxonomy_tags: ['concepto:modernizacion'],
  };

  const feedbackDb = fakeSupabase([
    { tag: 'subsector:olivar', score: 1, positivos: 2, negativos: 0 },
  ]);
  const feedback = await aplicarFeedbackAlPerfil(feedbackDb, {
    userId: 5,
    alerta,
    delta: 1,
    rawText: 'Me interesa el olivar y la modernizacion',
  });

  assert.strictEqual(feedbackDb.calls.select, 1);
  assert.strictEqual(feedbackDb.calls.upsert, 1);
  assert(feedback.updated >= 2);
  assert(feedbackDb.calls.rows.some((row) => row.tag === 'subsector:olivar' && row.score === 2));

  const clickDb = fakeSupabase();
  const click = await aplicarClickAlPerfil(clickDb, { userId: 5, alerta });

  assert.strictEqual(clickDb.calls.select, 1);
  assert.strictEqual(clickDb.calls.upsert, 1);
  assert(click.updated >= 1);

  console.log('OK: feedback y clic actualizan todas las etiquetas en dos operaciones');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
