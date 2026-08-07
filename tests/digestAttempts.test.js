const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  DIGEST_DECISION_VERSION,
  actualizarDigestAttemptPorDigest,
  construirDigestAttemptRow,
  esDigestAttemptTerminalActual,
  registrarDigestAttempt,
  seleccionarDigestAttemptCanonico,
} = require('../src/modules/mia/digestAttempts');

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`OK: ${name}`))
    .catch((err) => {
      console.error(`FAIL: ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

function fakeSupabase(result = { error: null }) {
  const calls = [];
  return {
    calls,
    from(table) {
      const query = {
        upsert(row, options) {
          calls.push({ op: 'upsert', table, row, options });
          return result;
        },
        update(row) {
          calls.push({ op: 'update', table, row });
          return {
            eq(column, value) {
              calls.push({ op: 'eq', table, column, value });
              return result;
            },
          };
        },
      };
      return query;
    },
  };
}

console.log('\n=== TESTS: digest attempts ===\n');

test('normaliza fila de auditoria de digest', () => {
  const row = construirDigestAttemptRow({
    userId: 141,
    fecha: '2026-06-12',
    kind: 'rescue',
    status: 'generated',
    totalAlertasDia: 2.9,
    totalAlertasVentana: 8,
    trasQualityGate: 6,
    trasFiltroUsuario: 3,
    trasScoring: 2,
    alertasFinales: 1,
    judgeEvaluatedCount: 3,
    approvedCount: 1,
    queuedCount: 1,
    deliveredCount: 0,
    deliveryStatus: 'QUEUED',
    motivoNoEnvio: 'sin_alertas_hoy_rescate_semanal_generado',
    metadata: { tipo: 'suave' },
    digestId: 77,
  });

  assert.strictEqual(row.user_id, 141);
  assert.strictEqual(row.fecha, '2026-06-12');
  assert.strictEqual(row.kind, 'rescue');
  assert.strictEqual(row.status, 'generated');
  assert.strictEqual(row.total_alertas_dia, 2);
  assert.strictEqual(row.digest_id, 77);
  assert.strictEqual(row.judge_evaluated_count, 3);
  assert.strictEqual(row.approved_count, 1);
  assert.strictEqual(row.delivery_status, 'QUEUED');
  assert.deepStrictEqual(row.metadata_json, {
    tipo: 'suave',
    decision_version: DIGEST_DECISION_VERSION,
  });
});

test('solo reabre no-envios producidos por una version anterior', () => {
  // Caso real (5-08-2026): tras corregir el territorio, preparar-digest no
  // reevaluo a nadie porque los `no_send` de esa misma manana ya contaban como
  // terminales. Subir la version es lo que reabre esos silencios.
  assert.strictEqual(esDigestAttemptTerminalActual({
    status: 'no_send',
    metadata_json: { decision_version: 'digest_decision_v8_alert_authority' },
  }), false, 'un silencio de la version anterior debe reevaluarse');
  for (const status of ['sent', 'generated', 'rescued', 'skipped_existing']) {
    assert.strictEqual(esDigestAttemptTerminalActual({
      status,
      metadata_json: { decision_version: 'digest_decision_v8_alert_authority' },
    }), true, `${status}: subir la version nunca puede provocar un reenvio`);
  }
  assert.strictEqual(esDigestAttemptTerminalActual({
    status: 'no_send',
    metadata_json: { decision_version: 'digest_decision_v6' },
  }), false, 'el despliegue reevalua una vez los bloqueos de la politica anterior');
  assert.strictEqual(esDigestAttemptTerminalActual({
    status: 'no_send',
    metadata_json: { decision_version: 'digest_decision_v3' },
  }), false);
  assert.strictEqual(esDigestAttemptTerminalActual({
    status: 'no_send',
    metadata_json: { decision_version: DIGEST_DECISION_VERSION },
  }), true);
  assert.strictEqual(esDigestAttemptTerminalActual({
    status: 'sent',
    metadata_json: { decision_version: 'digest_decision_v1' },
  }), true, 'un envio real nunca se reabre por un cambio de version');

  // Incidente 7-08-2026: la reparacion del territorio se desplego pero el cron
  // devolvio `usuarios_evaluados: 0`. Los 94 silencios de esa manana llevaban
  // v10, la misma version que seguia en el codigo, asi que nadie entraba
  // siquiera al bucle. La barrera cambio: la version tiene que haber subido.
  assert.notStrictEqual(
    DIGEST_DECISION_VERSION,
    'digest_decision_v10_audit_dedupe',
    'cambiar la barrera territorial obliga a subir la version: si no, los no_send del dia bloquean la reevaluacion'
  );
  assert.strictEqual(esDigestAttemptTerminalActual({
    status: 'no_send',
    metadata_json: { decision_version: 'digest_decision_v10_audit_dedupe' },
  }), false, 'los silencios tomados con la barrera territorial rota se reabren');
  assert.strictEqual(esDigestAttemptTerminalActual({
    status: 'failed',
    metadata_json: { decision_version: 'digest_decision_v10_audit_dedupe' },
  }), false, 'las auditorias fallidas de v10 se reintentan');
});

test('un re-registro parcial no incluye columnas de embudo no pasadas (no machaca generated)', () => {
  // Caso real: segundo cron marca 'skipped_existing' sobre un intento que ya
  // tenia el embudo escrito por 'generated'. El upsert no debe resetear a 0.
  const row = construirDigestAttemptRow({
    userId: 141,
    fecha: '2026-07-04',
    kind: 'daily',
    status: 'skipped_existing',
    totalAlertasDia: 33,
    trasQualityGate: 24,
    digestId: 77,
    metadata: { plan: 'cooperativa', enviado: false },
  });

  assert.strictEqual(row.total_alertas_dia, 33);
  assert.strictEqual(row.tras_quality_gate, 24);
  assert.strictEqual('tras_filtro_usuario' in row, false, 'no debe incluir tras_filtro_usuario');
  assert.strictEqual('tras_scoring' in row, false, 'no debe incluir tras_scoring');
  assert.strictEqual('alertas_finales' in row, false, 'no debe incluir alertas_finales');
  assert.strictEqual('total_alertas_ventana' in row, false, 'no debe incluir total_alertas_ventana');
  assert.strictEqual('motivo_no_envio' in row, false, 'no debe incluir motivo_no_envio');
  assert.strictEqual('error_msg' in row, false, 'no debe incluir error_msg');
});

test('motivoNoEnvio null explicito limpia el motivo previo', () => {
  const row = construirDigestAttemptRow({
    userId: 141,
    fecha: '2026-07-04',
    kind: 'daily',
    status: 'generated',
    alertasFinales: 2,
    motivoNoEnvio: null,
  });

  assert.strictEqual('motivo_no_envio' in row, true, 'la clave explicita debe incluirse');
  assert.strictEqual(row.motivo_no_envio, null);
  assert.strictEqual(row.alertas_finales, 2);
});

test('registra intento con upsert por usuario fecha y tipo', async () => {
  const supabase = fakeSupabase();
  const result = await registrarDigestAttempt(supabase, {
    userId: 141,
    fecha: '2026-06-12',
    kind: 'daily',
    status: 'no_send',
    motivoNoEnvio: 'perfil_sin_coincidencias',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(supabase.calls[0].table, 'digest_attempts');
  assert.strictEqual(supabase.calls[0].op, 'upsert');
  assert.strictEqual(supabase.calls[0].options.onConflict, 'user_id,fecha,kind');
});

test('devuelve el id estable del intento cuando Supabase permite select', async () => {
  const calls = [];
  const supabase = {
    from(table) {
      return {
        upsert(row, options) {
          calls.push({ table, row, options });
          return {
            select(columns) {
              calls.push({ op: 'select', columns });
              return {
                async maybeSingle() {
                  return { data: { id: 991 }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };

  const result = await registrarDigestAttempt(supabase, {
    userId: 141,
    fecha: '2026-06-12',
    kind: 'daily',
    status: 'evaluating',
  });
  assert.strictEqual(result.id, 991);
  assert.strictEqual(calls[1].columns, 'id');
});

test('elige el intento de rescate como envio canonico si hay enlaces historicos duplicados', () => {
  const attempt = seleccionarDigestAttemptCanonico([
    { id: 10, kind: 'daily', status: 'sent', created_at: '2026-07-10T10:00:00Z' },
    { id: 11, kind: 'rescue', status: 'sent', created_at: '2026-07-10T09:00:00Z' },
  ]);
  assert.strictEqual(attempt.id, 11);
});

test('actualiza solo el intento canonico asociado a un digest enviado', async () => {
  const calls = [];
  const supabase = {
    from(table) {
      return {
        select(columns) {
          calls.push({ op: 'select', table, columns });
          return this;
        },
        eq(column, value) {
          calls.push({ op: 'eq', table, column, value });
          if (this._updating) return Promise.resolve({ error: null });
          return this;
        },
        order(column, options) {
          calls.push({ op: 'order', table, column, options });
          return this;
        },
        limit(value) {
          calls.push({ op: 'limit', table, value });
          return Promise.resolve({
            data: [
              { id: 10, kind: 'daily', status: 'no_send', created_at: '2026-07-10T10:00:00Z' },
              { id: 11, kind: 'rescue', status: 'rescued', created_at: '2026-07-10T09:00:00Z' },
            ],
            error: null,
          });
        },
        update(row) {
          calls.push({ op: 'update', table, row });
          this._updating = true;
          return this;
        },
      };
    },
  };
  const result = await actualizarDigestAttemptPorDigest(supabase, 77, {
    status: 'sent',
    motivoNoEnvio: null,
    errorMsg: null,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.id, 11);
  assert(calls.some((call) => call.op === 'eq' && call.column === 'digest_id' && call.value === 77));
  assert(calls.some((call) => call.op === 'update' && call.row.status === 'sent'));
  assert(calls.some((call) => call.op === 'eq' && call.column === 'id' && call.value === 11));
});

test('digest implementa rescate semanal y auditoria de no-envios', () => {
  // La logica del digest se reparte entre la capa HTTP (digest.routes.js) y el
  // motor (digest.service.js); leemos ambos como una sola fuente.
  const dir = path.join(__dirname, '..', 'src/modules/digest');
  const source =
    fs.readFileSync(path.join(dir, 'digest.routes.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(dir, 'digest.service.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(dir, 'digestOutbox.js'), 'utf8');

  assert(source.includes("const PREPARAR_DIGEST_BATCH_SIZE = numeroConfig('PREPARAR_DIGEST_BATCH_SIZE', 1"), 'El batch debe caber dentro del timeout de Render');
  assert(source.includes(".in('status', estadosAttemptTerminales)"), 'Debe omitir usuarios ya resueltos en lotes anteriores');
  assert(source.includes('.filter(esDigestAttemptTerminalActual)'), 'Debe reabrir no-envios de una version anterior');
  assert(source.includes('usuarios_evaluados_batch: usuariosEvaluados'), 'El progreso debe contar usuarios evaluados, tengan o no digest');
  assert(source.includes('DIGEST_RESCUE_AFTER_DAYS'), 'Debe existir umbral de rescate semanal');
  assert(source.includes('generarMensajeDigestRescate'), 'Debe existir mensaje de rescate');
  assert(source.includes('DIGEST_RESCUE_MESSAGE_MAX_CHARS'), 'El mensaje de rescate debe tener limite propio');
  assert(source.includes('construirBloqueRescate'), 'El rescate debe construir bloques completos');
  assert(source.includes('construirResumenFacilDigest'), 'El digest debe traducir alertas a explicacion facil');
  assert(source.includes('prepararAlertasFinalesDigest'), 'El digest debe enriquecer alertas con contexto interno');
  assert(source.includes('contexto_mia_digest'), 'El digest debe guardar explicacion interna por alerta');
  assert(source.includes('final_validation_no_send'), 'El digest debe auditar no-envios por validacion final');
  assert(source.includes('final_validation_enforcement'), 'El digest debe guardar resumen de enforcement final');
  assert(!source.includes("stage: 'final_validation_backfill'"), 'La autoridad final no debe rellenar huecos tras un rechazo');
  assert(source.includes("stage: 'personal_relevance_judge'"), 'Debe auditar la decision personal canonica');
  assert(source.includes('renderDecisionDigestMessage'), 'El mensaje debe salir de hechos aprobados por la autoridad');
  assert(source.includes('alertasReintentablesPorTextoAusente'), 'Un item sin bloque de texto debe reintentarse sin recuperar descartes reales');
  assert(source.includes('cleanup_accepted_only'), 'Un rechazo parcial debe conservar y volver a validar los items aceptados');
  assert(source.includes("'final_validation_send'"), 'Un envio validado debe registrar una causa positiva y no un falso missing');
  assert(source.includes('agruparAlertasDigest'), 'El digest debe agrupar alertas por tipo');
  assert(source.includes('construirPreviewDigestUsuario'), 'Debe existir preview de digest sin escrituras');
  assert(source.includes("app.get('/alertas/preview-digest'"), 'Debe existir endpoint GET de preview seguro');
  assert(source.includes("app.post('/alertas/preview-digest'"), 'Debe existir endpoint POST de preview seguro');
  assert(source.includes('Preview seguro: no inserta digests'), 'El preview debe declarar que no escribe ni envia');
  assert(source.includes('En sencillo:'), 'El digest debe marcar la explicacion facil de cada alerta');
  assert(source.includes('Qué revisar'), 'El digest debe decir que comprobar en cada alerta');
  assert(source.includes('Por qué aparece'), 'El rescate debe explicar por que se manda');
  assert(source.includes('No son urgentes: revísalos solo si encajan contigo.'), 'El rescate debe sonar preventivo, no urgente');
  assert(!source.includes('Para que no te quedes a ciegas'), 'El rescate debe evitar lenguaje coloquial raro');
  assert(source.includes('if (candidato.length > DIGEST_RESCUE_MESSAGE_MAX_CHARS'), 'El rescate no debe cortar alertas a medias');
  assert(!source.includes('Que haria ahora'), 'El rescate no debe usar textos roboticos antiguos');
  assert(source.includes('necesitaRescateSemanal'), 'Debe decidir rescate por ultimo envio');
  assert(source.includes('registrarDigestAttempt'), 'Debe auditar preparacion/no-envio');
  assert(source.includes('actualizarDigestAttemptPorDigest'), 'Debe auditar resultado de envio');
  assert(source.includes('sin_alertas_hoy_rescate_semanal_generado'), 'Debe explicar rescate por silencio');
  assert(source.includes('existing_digest_id: digestExistente.id'), 'Un cron repetido referencia el digest sin enlazar otro intento');
});
