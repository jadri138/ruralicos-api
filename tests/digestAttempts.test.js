const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  actualizarDigestAttemptPorDigest,
  construirDigestAttemptRow,
  registrarDigestAttempt,
} = require('../src/mia/digestAttempts');

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
  assert.deepStrictEqual(row.metadata_json, { tipo: 'suave' });
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

test('actualiza intento asociado a digest enviado', async () => {
  const supabase = fakeSupabase();
  const result = await actualizarDigestAttemptPorDigest(supabase, 77, {
    status: 'sent',
    motivoNoEnvio: null,
    errorMsg: null,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(supabase.calls[0].op, 'update');
  assert.strictEqual(supabase.calls[0].row.status, 'sent');
  assert.deepStrictEqual(supabase.calls[1], {
    op: 'eq',
    table: 'digest_attempts',
    column: 'digest_id',
    value: 77,
  });
});

test('digest implementa rescate semanal y auditoria de no-envios', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/routes/digest.js'), 'utf8');

  assert(source.includes("const PREPARAR_DIGEST_BATCH_SIZE = numeroConfig('PREPARAR_DIGEST_BATCH_SIZE', 50"), 'El batch por defecto debe subir de 5 a 50');
  assert(source.includes('DIGEST_RESCUE_AFTER_DAYS'), 'Debe existir umbral de rescate semanal');
  assert(source.includes('generarMensajeDigestRescate'), 'Debe existir mensaje de rescate');
  assert(source.includes('DIGEST_RESCUE_MESSAGE_MAX_CHARS'), 'El mensaje de rescate debe tener limite propio');
  assert(source.includes('construirBloqueRescate'), 'El rescate debe construir bloques completos');
  assert(source.includes('construirResumenFacilDigest'), 'El digest debe traducir alertas a explicacion facil');
  assert(source.includes('prepararAlertasFinalesDigest'), 'El digest debe enriquecer alertas con contexto interno');
  assert(source.includes('contexto_mia_digest'), 'El digest debe guardar explicacion interna por alerta');
  assert(source.includes('agruparAlertasDigest'), 'El digest debe agrupar alertas por tipo');
  assert(source.includes('construirPreviewDigestUsuario'), 'Debe existir preview de digest sin escrituras');
  assert(source.includes("app.get('/alertas/preview-digest'"), 'Debe existir endpoint GET de preview seguro');
  assert(source.includes("app.post('/alertas/preview-digest'"), 'Debe existir endpoint POST de preview seguro');
  assert(source.includes('Preview seguro: no inserta digests'), 'El preview debe declarar que no escribe ni envia');
  assert(source.includes('En sencillo:'), 'El digest debe marcar la explicacion facil de cada alerta');
  assert(source.includes('Qué miraría'), 'El digest debe decir que comprobar en cada alerta');
  assert(source.includes('Por qué te la dejo'), 'El rescate debe explicar por que se manda');
  assert(source.includes('No son urgentes: revísalos solo si encajan contigo.'), 'El rescate debe sonar preventivo, no urgente');
  assert(source.includes('if (candidato.length > DIGEST_RESCUE_MESSAGE_MAX_CHARS'), 'El rescate no debe cortar alertas a medias');
  assert(!source.includes('Que haria ahora'), 'El rescate no debe usar textos roboticos antiguos');
  assert(source.includes('necesitaRescateSemanal'), 'Debe decidir rescate por ultimo envio');
  assert(source.includes('registrarDigestAttempt'), 'Debe auditar preparacion/no-envio');
  assert(source.includes('actualizarDigestAttemptPorDigest'), 'Debe auditar resultado de envio');
  assert(source.includes('sin_alertas_hoy_rescate_semanal_generado'), 'Debe explicar rescate por silencio');
});
