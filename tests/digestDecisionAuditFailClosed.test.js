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
    diagnosticStages.includes('selection'),
    'las etapas legacy puramente diagnosticas deben conservar su comportamiento tolerante'
  );
  // quality_gate, organization_visibility y user_filter dejaron de persistirse:
  // nadie las leia y generaban ~32.000 filas al dia. Su explicacion vive ahora
  // en el embudo por barrera del intento (`ranking_funnel.stopped_by`).
  for (const retirada of ['quality_gate', 'organization_visibility', 'user_filter']) {
    assert(
      !diagnosticStages.includes(retirada) && !canonicalStages.includes(retirada),
      `${retirada} no debe volver a persistirse fila a fila`
    );
  }

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

  // Un usuario sin candidatas no tiene nada que auditar. Eso es silencio
  // legitimo y no puede tratarse como fallo: hacerlo tumbaba el lote entero
  // por una sola persona (error observado en produccion el 4-08-2026).
  let upsertLlamado = false;
  const supabaseVigilado = {
    from() {
      return {
        async upsert() {
          upsertLlamado = true;
          return { error: null };
        },
      };
    },
  };
  const vacio = await registrarDigestCandidateDecisionsCanonicas(supabaseVigilado, {
    userId: 12,
    fecha: '2026-08-04',
    stage: 'personal_relevance_judge',
    decisions: [],
  });
  assert.strictEqual(vacio.ok, true, 'una lista vacia no es un fallo de auditoria');
  assert.strictEqual(vacio.stored, 0);
  assert.strictEqual(upsertLlamado, false, 'sin decisiones no se escribe nada');

  // Dos decisiones de la misma alerta comparten fila: Postgres rechazaria el
  // lote entero si se enviaran las dos ("cannot affect row a second time"), y
  // eso tumbaba la auditoria de 24 personas el 5-08-2026.
  const lotes = [];
  const supabaseLotes = {
    from() {
      return {
        async upsert(filas) {
          lotes.push(filas);
          return { error: null };
        },
      };
    },
  };
  const duplicadas = await registrarDigestCandidateDecisionsCanonicas(supabaseLotes, {
    userId: 12,
    fecha: '2026-08-05',
    stage: 'personal_relevance_judge',
    decisions: [
      { id: 34, action: 'blocked', motivo: 'primera' },
      { id: 34, action: 'include', motivo: 'definitiva' },
      { id: 35, action: 'include' },
    ],
  });
  assert.strictEqual(duplicadas.ok, true, 'una alerta repetida no puede tumbar la auditoria');
  assert.strictEqual(lotes[0].length, 2, 'la alerta repetida viaja una sola vez');
  const fila34 = lotes[0].find((row) => Number(row.alerta_id) === 34);
  assert.strictEqual(fila34.action, 'include', 'gana la ultima decision, que es la definitiva');
  assert.strictEqual(fila34.reason, 'definitiva');

  // La garantia sigue viva: en cuanto hay algo que auditar y falla, se cierra.
  await assert.rejects(
    () => registrarDigestCandidateDecisionsCanonicas(
      { from() { return { async upsert() { return { error: { message: 'fallo' } }; } }; } },
      {
        userId: 12,
        fecha: '2026-08-04',
        stage: 'personal_relevance_judge',
        decisions: [{ id: 34, action: 'include' }],
      }
    ),
    (error) => error.code === 'CANONICAL_DECISION_AUDIT_FAILED',
    'con decisiones reales el veto sigue siendo fail-closed'
  );

  // El fallo de auditoria de una persona no puede abortar la ruta completa.
  const rutaSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'modules', 'digest', 'digest.routes.js'),
    'utf8'
  );
  const bloqueJuez = rutaSource.slice(
    rutaSource.indexOf("stage: 'personal_relevance_judge'")
  );
  assert(
    /catch \(auditError\)/.test(bloqueJuez.slice(0, 2000)),
    'la auditoria del juez debe aislar su fallo por usuario'
  );
  assert(
    /motivoNoEnvio: 'canonical_audit_failed'/.test(bloqueJuez.slice(0, 3000)),
    'un fallo de auditoria debe quedar registrado como intento fallido de esa persona'
  );

  console.log('OK: ningun digest canonico se aprueba o envia sin auditoria persistida');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
