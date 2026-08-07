// Invariantes de la auditoria canonica y del ciclo de vida de un HOLD.
//
// Incidente 5-08-2026: 24 personas se quedaron con `canonical_audit_failed`
// porque el lote llevaba filas con distinto juego de columnas (PostgREST manda
// NULL en la que falta, no el DEFAULT) y porque el cierre de un HOLD reclamado
// podia producir una combinacion que rompe
// `digest_candidate_decisions_hold_lifecycle_check`.
const assert = require('assert');

const {
  construirDigestCandidateDecisionRows,
  registrarDigestCandidateDecisionsCanonicas,
} = require('../src/modules/mia/digestCandidateDecisions');
const {
  HOLD_RETRY_STATUS,
  construirPatchHold,
  finalizarHoldsDecision,
} = require('../src/modules/digest/decisionHoldRetry');

let aprobados = 0;
function ok(nombre) {
  aprobados++;
  console.log(`OK: ${nombre}`);
}

// Reproduce la restriccion real de Supabase sobre las columnas de HOLD.
function cumpleHoldLifecycleCheck(fila = {}) {
  const estado = fila.hold_status ?? null;
  if (Number(fila.hold_attempts ?? 0) < 0) return false;
  const resolucion = fila.hold_resolution_json;
  if (resolucion !== undefined && (typeof resolucion !== 'object' || resolucion === null || Array.isArray(resolucion))) {
    return false;
  }
  if (estado === null) return true;
  if (!['PENDING', 'PROCESSING', 'FAILED', 'RESOLVED', 'EXHAUSTED', 'EXPIRED'].includes(estado)) return false;
  if (['PENDING', 'FAILED'].includes(estado)) return fila.hold_next_at != null;
  if (estado === 'PROCESSING') return fila.hold_claim_token != null && fila.hold_claimed_at != null;
  return fila.hold_next_at == null;
}

// Supabase de memoria minimo: guarda el lote tal cual llega y aplica los NOT
// NULL de la tabla, que es justo lo que fallaba en produccion.
function supabaseAuditoria() {
  const guardadas = [];
  const rechazos = [];
  return {
    guardadas,
    rechazos,
    from() {
      return {
        upsert(filas) {
          const columnas = new Set();
          for (const fila of filas) for (const key of Object.keys(fila)) columnas.add(key);
          for (const fila of filas) {
            for (const columna of columnas) {
              const valor = Object.prototype.hasOwnProperty.call(fila, columna) ? fila[columna] : null;
              if (['llm_calls', 'cache_hit', 'reason_codes', 'kind', 'action', 'decision_json', 'metadata_json'].includes(columna)
                && (valor === null || valor === undefined)) {
                const error = new Error(`null value in column "${columna}" violates not-null constraint`);
                rechazos.push(error.message);
                return Promise.resolve({ error });
              }
            }
            if (!cumpleHoldLifecycleCheck(fila)) {
              const error = new Error('new row violates check constraint "digest_candidate_decisions_hold_lifecycle_check"');
              rechazos.push(error.message);
              return Promise.resolve({ error });
            }
            guardadas.push(fila);
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

async function main() {
  // 1. Auditoria con llm_calls = 0: una candidata bloqueada por el ranking no
  //    pasa por el juez y no aporta datos de LLM.
  {
    const filas = construirDigestCandidateDecisionRows({
      userId: 77,
      fecha: '2026-08-05',
      stage: 'personal_relevance_judge',
      decisions: [{ id: 1, decision: 'BLOCKED', reason_codes: ['TERRITORY_MISMATCH'] }],
    });
    assert.strictEqual(filas[0].llm_calls, 0, 'sin juez, llm_calls vale 0');
    assert.strictEqual(filas[0].cache_hit, false);
    assert.notStrictEqual(filas[0].llm_calls, null, 'llm_calls nunca puede ir como null');
    ok('Una decision sin datos de LLM audita con llm_calls = 0');
  }

  // 2. Lote mixto: bloqueada por ranking + evaluada por el juez. Todas las filas
  //    deben traer exactamente las mismas columnas.
  {
    const filas = construirDigestCandidateDecisionRows({
      userId: 77,
      fecha: '2026-08-05',
      stage: 'personal_relevance_judge',
      decisions: [
        { id: 1, decision: 'BLOCKED', reason_codes: ['TERRITORY_MISMATCH'] },
        {
          id: 2,
          decision: 'ADD_TO_DIGEST',
          reason_codes: ['APPROVED_DIGEST'],
          llm_calls: 1,
          judge_audit: { model: 'gpt-5-nano', llm_calls: 1, usage: { total_tokens: 900 } },
        },
      ],
    });
    const claves = filas.map((fila) => Object.keys(fila).sort().join(','));
    assert.strictEqual(claves[0], claves[1], 'todas las filas del lote comparten columnas');
    for (const fila of filas) {
      for (const columna of ['llm_calls', 'cache_hit', 'reason_codes', 'kind', 'action']) {
        assert.notStrictEqual(fila[columna], null, `${columna} nunca va null`);
        assert.notStrictEqual(fila[columna], undefined, `${columna} va siempre`);
      }
    }
    const supabase = supabaseAuditoria();
    await registrarDigestCandidateDecisionsCanonicas(supabase, {
      userId: 77,
      fecha: '2026-08-05',
      stage: 'personal_relevance_judge',
      decisions: [
        { id: 1, decision: 'BLOCKED', reason_codes: ['TERRITORY_MISMATCH'] },
        { id: 2, decision: 'ADD_TO_DIGEST', reason_codes: ['APPROVED_DIGEST'], llm_calls: 1 },
      ],
    });
    assert.deepStrictEqual(supabase.rechazos, [], 'Supabase no rechaza el lote mixto');
    assert.strictEqual(supabase.guardadas.length, 2);
    ok('Un lote que mezcla decisiones con y sin LLM se guarda entero');
  }

  // 3. HOLD valido: PENDING con proxima cita y sin claim.
  {
    const filas = construirDigestCandidateDecisionRows({
      userId: 77,
      fecha: '2026-08-05',
      stage: 'personal_relevance_judge',
      decisions: [{
        id: 3,
        decision: 'HOLD_FOR_EVIDENCE',
        reason_codes: ['LLM_UNAVAILABLE'],
        input_hash: 'sha256:hold',
      }],
    });
    assert.strictEqual(filas[0].hold_status, HOLD_RETRY_STATUS.PENDING);
    assert(filas[0].hold_next_at, 'un HOLD pendiente tiene proxima cita');
    assert.strictEqual(filas[0].hold_claim_token, null);
    assert(cumpleHoldLifecycleCheck(filas[0]), 'la fila cumple la restriccion real');
    ok('Un HOLD transitorio queda PENDING con proxima cita y sin claim');
  }

  // 4. Estados HOLD invalidos: el constructor no permite construirlos.
  {
    assert.throws(() => construirPatchHold('PENDING', {}), /hold_pendiente_requiere_next_at/);
    assert.throws(() => construirPatchHold('FAILED', {}), /hold_pendiente_requiere_next_at/);
    assert.throws(() => construirPatchHold('PROCESSING', {}), /hold_processing_requiere_claim/);
    assert.throws(() => construirPatchHold('INVENTADO', {}), /hold_status_invalido/);
    for (const estado of ['RESOLVED', 'EXHAUSTED', 'EXPIRED']) {
      const patch = construirPatchHold(estado, { nextAt: '2026-09-01T00:00:00.000Z' });
      assert.strictEqual(patch.hold_next_at, null, `${estado} no deja cita pendiente`);
      assert(cumpleHoldLifecycleCheck(patch));
    }
    assert(cumpleHoldLifecycleCheck(construirPatchHold('PENDING', { nextAt: '2026-09-01T00:00:00.000Z' })));
    assert(cumpleHoldLifecycleCheck(construirPatchHold('PROCESSING', {
      claimToken: 'tok', claimedAt: '2026-08-05T00:00:00.000Z',
    })));
    ok('El constructor de HOLD rechaza toda combinacion que romperia la restriccion');
  }

  // 5. Dos decisiones de la misma alerta: comparten fila, no rompen el upsert.
  {
    const supabase = supabaseAuditoria();
    const resultado = await registrarDigestCandidateDecisionsCanonicas(supabase, {
      userId: 77,
      fecha: '2026-08-05',
      stage: 'personal_relevance_judge',
      decisions: [
        { id: 9, decision: 'BLOCKED', reason_codes: ['TERRITORY_MISMATCH'] },
        { id: 9, decision: 'ADD_TO_DIGEST', reason_codes: ['APPROVED_DIGEST'] },
      ],
    });
    assert.strictEqual(resultado.ok, true, 'la auditoria no falla por la clave repetida');
    assert.strictEqual(supabase.guardadas.length, 1, 'se guarda una sola fila por alerta');
    assert.strictEqual(
      supabase.guardadas[0].decision_state,
      'ADD_TO_DIGEST',
      'gana la ultima decision, que es la definitiva'
    );
    ok('Dos decisiones de la misma alerta producen una sola fila auditable');
  }

  // 6. Usuario sin candidatas: silencio legitimo, no fallo de auditoria.
  {
    const supabase = supabaseAuditoria();
    const resultado = await registrarDigestCandidateDecisionsCanonicas(supabase, {
      userId: 78,
      fecha: '2026-08-05',
      stage: 'personal_relevance_judge',
      decisions: [],
    });
    assert.strictEqual(resultado.ok, true);
    assert.strictEqual(resultado.empty, true);
    assert.strictEqual(supabase.guardadas.length, 0);
    ok('Un usuario sin candidatas es silencio legitimo, no un fallo de auditoria');
  }

  // 7. Un rechazo real de Supabase se propaga con causa detallada.
  {
    const supabase = {
      from() {
        return {
          upsert() {
            return Promise.resolve({ error: new Error('permission denied for table digest_candidate_decisions') });
          },
        };
      },
    };
    await assert.rejects(
      () => registrarDigestCandidateDecisionsCanonicas(supabase, {
        userId: 79,
        fecha: '2026-08-05',
        stage: 'personal_relevance_judge',
        decisions: [{ id: 1, decision: 'BLOCKED', reason_codes: ['EXPIRED'] }],
      }),
      (error) => {
        assert.strictEqual(error.code, 'CANONICAL_DECISION_AUDIT_FAILED');
        assert.match(error.audit_error, /permission denied/);
        assert.deepStrictEqual(error.audit_counts, {
          submitted: 1, construidas: 1, persistibles: 1, stored: 0,
        });
        return true;
      }
    );
    ok('Un rechazo de Supabase llega con la causa real y sus contadores');
  }

  // 8. Cierre de HOLD reclamado: idempotente. Si otra pasada ya lo cerro, se
  //    informa del claim perdido en lugar de lanzar y tumbar el lote.
  {
    const escrituras = [];
    const supabaseHold = (filasAfectadas) => ({
      from() {
        const query = {
          _patch: null,
          update(patch) { query._patch = patch; return query; },
          eq() { return query; },
          select() { return query; },
          maybeSingle() {
            escrituras.push(query._patch);
            return Promise.resolve({ data: filasAfectadas ? { id: 1 } : null, error: null });
          },
        };
        return query;
      },
    });

    const reclamado = {
      id: 1,
      alerta_id: 55,
      hold_attempts: 1,
      hold_claim_token: 'tok-1',
    };
    const resueltos = await finalizarHoldsDecision(supabaseHold(true), {
      claimed: [reclamado],
      decisions: [{ alerta_id: 55, decision: 'ADD_TO_DIGEST', reason_codes: ['APPROVED_DIGEST'] }],
      now: new Date('2026-08-05T09:00:00.000Z'),
    });
    assert.strictEqual(resueltos[0].status, HOLD_RETRY_STATUS.RESOLVED);
    assert.strictEqual(resueltos[0].claim_lost, false);
    assert(cumpleHoldLifecycleCheck(escrituras[0]), 'el cierre cumple la restriccion');
    assert.strictEqual(escrituras[0].hold_next_at, null, 'un HOLD resuelto no deja cita pendiente');

    const perdidos = await finalizarHoldsDecision(supabaseHold(false), {
      claimed: [reclamado],
      decisions: [{ alerta_id: 55, decision: 'ADD_TO_DIGEST', reason_codes: ['APPROVED_DIGEST'] }],
      now: new Date('2026-08-05T09:00:00.000Z'),
    });
    assert.strictEqual(perdidos[0].claim_lost, true, 'el claim perdido se informa, no se lanza');
    ok('Cerrar un HOLD ya cerrado por otra pasada no rompe nada');
  }

  console.log(`\nResultados auditoria/HOLD: ${aprobados} aprobados, 0 fallidos`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
