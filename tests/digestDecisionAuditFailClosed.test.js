const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  REQUIRED_CANONICAL_AUDIT_STAGES,
  registrarDigestCandidateDecisionsCanonicas,
} = require('../src/modules/mia/digestCandidateDecisions');

function extractCalls(source, functionName) {
  const marker = `${functionName}(supabase, {`;
  const calls = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) break;
    const open = source.indexOf('(', start);
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      if (source[end] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(start, end + 1));
    cursor = end + 1;
  }
  return calls;
}

function stagesFromCalls(calls) {
  return calls
    .map((call) => call.match(/stage:\s*'([^']+)'/)?.[1] || null)
    .filter(Boolean);
}

async function main() {
  const routeSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'modules', 'digest', 'digest.routes.js'),
    'utf8'
  );
  const required = new Set(REQUIRED_CANONICAL_AUDIT_STAGES);
  const canonicalStages = stagesFromCalls(
    extractCalls(routeSource, 'registrarDigestCandidateDecisionsCanonicas')
  );
  const diagnosticStages = stagesFromCalls(
    extractCalls(routeSource, 'registrarDigestCandidateDecisions')
  );

  for (const stage of required) {
    assert(
      canonicalStages.includes(stage),
      `${stage} debe persistirse con auditoria obligatoria antes de aprobar el digest`
    );
    assert(
      !diagnosticStages.includes(stage),
      `${stage} no puede usar la persistencia diagnostica tolerante a fallos`
    );
  }
  assert(
    diagnosticStages.includes('quality_gate') && diagnosticStages.includes('selection'),
    'las etapas legacy puramente diagnosticas deben conservar su comportamiento tolerante'
  );

  const failingSupabase = {
    from(table) {
      assert.strictEqual(table, 'digest_candidate_decisions');
      return {
        async upsert() {
          return { error: { message: 'fallo_supabase_forzado' } };
        },
      };
    },
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (const stage of REQUIRED_CANONICAL_AUDIT_STAGES) {
      let approved = false;
      let sent = false;
      await assert.rejects(
        async () => {
          await registrarDigestCandidateDecisionsCanonicas(failingSupabase, {
            userId: 12,
            fecha: '2026-08-02',
            stage,
            decisions: [{ id: 34, action: 'include', motivo: 'test' }],
          });
          approved = true;
          sent = true;
        },
        (error) => error.code === 'CANONICAL_DECISION_AUDIT_FAILED' && error.stage === stage,
        `${stage} debe cerrarse ante un fallo de Supabase`
      );
      assert.strictEqual(approved, false, `${stage}: no debe aprobar el digest`);
      assert.strictEqual(sent, false, `${stage}: no debe alcanzar el envio`);
    }
  } finally {
    console.warn = originalWarn;
  }

  await assert.rejects(
    () => registrarDigestCandidateDecisionsCanonicas(null, {
      userId: 12,
      fecha: '2026-08-02',
      stage: 'personal_relevance_judge',
      decisions: [{ id: 34, action: 'include' }],
    }),
    (error) => error.code === 'CANONICAL_DECISION_AUDIT_FAILED',
    'la ausencia del cliente Supabase tambien debe cerrar el flujo'
  );

  const acceptingSupabase = {
    from() {
      return { async upsert() { return { error: null }; } };
    },
  };
  await assert.rejects(
    () => registrarDigestCandidateDecisionsCanonicas(acceptingSupabase, {
      userId: 12,
      fecha: '2026-08-02',
      stage: 'auto_send_gate',
      decisions: [
        { id: 34, action: 'include' },
        { action: 'include' },
      ],
    }),
    (error) => error.code === 'CANONICAL_DECISION_AUDIT_FAILED',
    'una candidata sin fila auditable debe bloquear tambien a las demas'
  );

  console.log('OK: ningun digest canonico se aprueba o envia sin auditoria persistida');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
