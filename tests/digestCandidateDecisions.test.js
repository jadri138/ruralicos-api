const assert = require('assert');

const {
  construirDigestCandidateDecisionRow,
  registrarDigestCandidateDecisions,
  vincularDigestCandidateDecisions,
} = require('../src/modules/mia/digestCandidateDecisions');

async function main() {
  const row = construirDigestCandidateDecisionRow({
    userId: 12,
    alertaId: 34,
    fecha: '2026-06-25',
    kind: 'daily',
    stage: 'selection',
    digestAttemptId: 56,
    decision: {
      action: 'review_only',
      score: 71,
      riesgo: 'medio',
      motivo: 'evidencia_incompleta',
    },
  });

  assert.strictEqual(row.user_id, 12);
  assert.strictEqual(row.alerta_id, 34);
  assert.strictEqual(row.action, 'review_only');
  assert.strictEqual(row.digest_attempt_id, 56);
  assert.strictEqual(row.score, 71);

  const calls = [];
  const supabase = {
    from(table) {
      return {
        async upsert(rows, options) {
          calls.push({ op: 'upsert', table, rows, options });
          return { error: null };
        },
        update(patch) {
          calls.push({ op: 'update', table, patch });
          const chain = {
            eq(column, value) {
              calls.push({ op: 'eq', table, column, value });
              return chain;
            },
            then(resolve) {
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
  };

  const stored = await registrarDigestCandidateDecisions(supabase, {
    userId: 12,
    fecha: '2026-06-25',
    stage: 'user_filter',
    decisions: [
      { id: 34, action: 'include', motivo: 'perfil_coincide' },
      { id: 35, action: 'exclude', motivo: 'provincia_no_coincide' },
    ],
  });
  assert.strictEqual(stored.ok, true);
  assert.strictEqual(stored.stored, 2);
  assert.strictEqual(calls[0].options.onConflict, 'user_id,fecha,kind,alerta_id,stage');

  const linked = await vincularDigestCandidateDecisions(supabase, {
    userId: 12,
    fecha: '2026-06-25',
    kind: 'daily',
    digestId: 78,
    digestAttemptId: 56,
  });
  assert.strictEqual(linked.ok, true);
  assert(calls.some((call) => call.op === 'update' && call.patch.digest_id === 78));

  console.log('OK: auditoria idempotente de todos los candidatos del digest');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
