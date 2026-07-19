process.env.CRON_TOKEN = 'test-cron-token';
process.env.ALERT_PRECLASSIFIER_MODE = 'off';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');

// Sustituimos la llamada externa antes de cargar el servicio. Asi se comprueba
// que un fallo tecnico real no se convierte en un descarte local inventado.
const ia = require('../src/platform/ia/llamarIA');
let responderIA = async () => {
  throw new Error('timeout tecnico simulado');
};
ia.llamarIA = (...args) => responderIA(...args);

const service = require('../src/modules/alertas/alertas.service');
const {
  construirDescarteAuditable,
  limpiarCamposDescarte,
} = require('../src/modules/alertas/clasificacion/discardDecision');

const clasificarConReintentoReal = service.clasificarConReintento;

// La ruta captura esta funcion al cargarse. Cada caso puede cambiar la respuesta
// controlada sin llamar a servicios externos.
let respuestaClasificacion = (alertas) => ({
  resultados: alertas.map((alerta) => ({
    id: String(alerta.id),
    es_relevante: true,
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['cereal'],
    tipos_alerta: ['ayudas_subvenciones'],
  })),
  errores: [],
  fallbackLocal: 0,
});
service.clasificarConReintento = async (alertas) => respuestaClasificacion(alertas);

delete require.cache[require.resolve('../src/modules/alertas/alertas.routes')];
const alertasRoutes = require('../src/modules/alertas/alertas.routes');
const adminAlertasRoutes = require('../src/modules/admin/admin.alertas.routes');

function crearSupabaseFalso(rows = []) {
  const updates = [];

  return {
    updates,
    from() {
      let operation = 'select';
      let patch = null;
      const builder = {
        select() { return builder; },
        update(value) {
          operation = 'update';
          patch = value;
          updates.push(value);
          return builder;
        },
        eq() { return builder; },
        neq() { return builder; },
        or() { return builder; },
        is() { return builder; },
        in() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        single() {
          return Promise.resolve({
            data: { id: rows[0]?.id || 1, ...(patch || {}) },
            error: null,
          });
        },
        maybeSingle() {
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(onFulfilled, onRejected) {
          const result = operation === 'select'
            ? { data: rows, error: null }
            : { data: null, error: null };
          return Promise.resolve(result).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

function registrarRutas(registrar, supabase) {
  const routes = {};
  const app = {
    get(path, ...handlers) { routes[`GET ${path}`] = handlers[handlers.length - 1]; },
    post(path, ...handlers) { routes[`POST ${path}`] = handlers[handlers.length - 1]; },
    patch(path, ...handlers) { routes[`PATCH ${path}`] = handlers[handlers.length - 1]; },
  };
  registrar(app, supabase);
  return routes;
}

function invocar(handler, { body = {}, params = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      body,
      params,
      query,
      get(name) {
        return String(name).toLowerCase() === 'x-cron-token'
          ? process.env.CRON_TOKEN
          : '';
      },
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };

    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('1. prefiltro duro conserva el codigo exacto y audita la preclasificacion', async () => {
  process.env.ALERT_PRECLASSIFIER_MODE = 'hard_exclusions';
  const supabase = crearSupabaseFalso([{
    id: 1,
    titulo: 'Convocatoria de oposiciones y bolsa de empleo publico',
    contenido: 'Proceso selectivo para personal funcionario y provision de puestos.',
  }]);
  const routes = registrarRutas(alertasRoutes, supabase);

  await invocar(routes['POST /alertas/clasificar']);

  const patch = supabase.updates[0];
  assert.strictEqual(patch.discard_reason_code, 'proceso_personal_publico');
  assert.strictEqual(patch.discard_stage, 'preclassifier');
  assert.strictEqual(patch.discard_confidence, 1);
  assert(patch.decision_audit.preclassification.pre_reasons.some(
    (reason) => reason.tag === 'proceso_personal_publico'
  ));
});

test('2. clasificador local sin senal rural devuelve causa estructurada', () => {
  const result = service.clasificarLocalmente({
    id: 2,
    titulo: 'Calendario general de actividades culturales',
    contenido: 'Programacion municipal de exposiciones y conciertos.',
  });

  assert.strictEqual(result.es_relevante, false);
  assert.strictEqual(result.discard_reason_code, 'sin_senal_rural');
  assert.strictEqual(result.discard_stage, 'classifier_local');
  assert.strictEqual(result.discard_confidence, 0.9);
});

test('3. respuesta negativa de IA persiste codigo libre estable y confianza 0.94', async () => {
  const alertas = new Map([['3', { id: 3, titulo: 'Anuncio general', contenido: 'Texto administrativo.' }]]);
  const result = service.normalizarResultadoClasificacion({
    id: '3',
    es_relevante: false,
    provincias: [],
    sectores: [],
    subsectores: [],
    tipos_alerta: [],
    discard_reason_code: 'actividad_cultural_no_rural',
    discard_reason: 'Actividad cultural sin relacion con explotaciones agrarias.',
    discard_confidence: 0.94,
  }, alertas);

  respuestaClasificacion = () => ({ resultados: [result], errores: [], fallbackLocal: 0 });
  process.env.ALERT_PRECLASSIFIER_MODE = 'off';
  const supabase = crearSupabaseFalso(Array.from(alertas.values()));
  const routes = registrarRutas(alertasRoutes, supabase);
  await invocar(routes['POST /alertas/clasificar']);

  const patch = supabase.updates[0];
  assert.strictEqual(patch.discard_reason_code, 'actividad_cultural_no_rural');
  assert.strictEqual(patch.discard_reason, 'Actividad cultural sin relacion con explotaciones agrarias.');
  assert.strictEqual(patch.discard_confidence, 0.94);
  assert.strictEqual(patch.discard_stage, 'classifier_ai');
  const required = service.CLASIFICACION_TEXT_FORMAT.schema.properties.resultados.items.required;
  assert(required.includes('discard_reason_code'));
  assert(required.includes('discard_reason'));
  assert(required.includes('discard_confidence'));
});

test('4. respuesta negativa de IA sin motivo persiste fallback explicito', async () => {
  const alertas = new Map([['4', { id: 4, titulo: 'Anuncio general', contenido: 'Texto administrativo.' }]]);
  const result = service.normalizarResultadoClasificacion({
    id: '4',
    es_relevante: false,
    provincias: [],
    sectores: [],
    subsectores: [],
    tipos_alerta: [],
    discard_reason_code: null,
    discard_reason: null,
    discard_confidence: null,
  }, alertas);

  respuestaClasificacion = () => ({ resultados: [result], errores: [], fallbackLocal: 0 });
  const supabase = crearSupabaseFalso(Array.from(alertas.values()));
  const routes = registrarRutas(alertasRoutes, supabase);
  await invocar(routes['POST /alertas/clasificar']);

  const patch = supabase.updates[0];
  assert.strictEqual(patch.discard_reason_code, 'clasificador_ia_no_relevante');
  assert(patch.discard_reason.includes('sin proporcionar un motivo'));
  assert.strictEqual(patch.discard_stage, 'classifier_ai');
  assert.strictEqual(patch.discard_confidence, 0.5);
});

test('5. prefiltro de resumen usa su etapa y mantiene NO IMPORTA sin dos puntos', async () => {
  const supabase = crearSupabaseFalso([{
    id: 5,
    titulo: 'Resolucion sobre pesca maritima y flota pesquera',
    contenido: 'Regulacion exclusiva de la actividad pesquera marina.',
    decision_audit: {
      preclassification: { pre_status: 'review' },
      classification: { es_relevante: true },
    },
  }]);
  const routes = registrarRutas(alertasRoutes, supabase);

  await invocar(routes['POST /alertas/resumir']);

  const patch = supabase.updates[0];
  assert.strictEqual(patch.resumen, 'NO IMPORTA');
  assert.strictEqual(patch.discard_reason_code, 'pesca_maritimo_no_agrario');
  assert.strictEqual(patch.discard_stage, 'summarizer_prefilter');
  assert(!Object.hasOwn(patch, 'sectores'), 'el descarte no debe borrar taxonomia existente');
});

test('6. prefiltro de revision registra review_prefilter sin borrar taxonomia', async () => {
  const supabase = crearSupabaseFalso([{
    id: 6,
    titulo: 'Provision de puestos de personal funcionario',
    contenido: 'Concurso de meritos para un puesto singular.',
    resumen_borrador: 'FICHA_IA',
    sectores: ['agricultura'],
  }]);
  const routes = registrarRutas(alertasRoutes, supabase);

  await invocar(routes['POST /alertas/revisar']);

  const patch = supabase.updates[0];
  assert.strictEqual(patch.resumen, 'NO IMPORTA');
  assert.strictEqual(patch.discard_reason_code, 'proceso_personal_publico');
  assert.strictEqual(patch.discard_stage, 'review_prefilter');
  assert(!Object.hasOwn(patch, 'sectores'));
});

test('7. auditoria v2 conserva preclasificacion y clasificacion completas', () => {
  const preclassification = { pre_status: 'review', pre_reasons: [{ tag: 'agrario', weight: 1 }] };
  const classification = { es_relevante: false, taxonomy_tags: ['sector:agricultura'] };
  const patch = construirDescarteAuditable({
    code: 'sin_senal_rural',
    stage: 'classifier_local',
    confidence: 0.8,
    preclassification,
    classification,
  });

  assert.strictEqual(patch.decision_audit.version, 'alert_decision_audit_v2');
  assert.deepStrictEqual(patch.decision_audit.preclassification, preclassification);
  assert.deepStrictEqual(patch.decision_audit.classification, classification);
  assert.deepStrictEqual(patch.decision_audit.discard, {
    code: patch.discard_reason_code,
    reason: patch.discard_reason,
    stage: 'classifier_local',
    confidence: 0.8,
  });
});

test('8. clasificacion relevante pasa a pendiente_resumir y limpia descarte anterior', async () => {
  process.env.ALERT_PRECLASSIFIER_MODE = 'off';
  respuestaClasificacion = (alertas) => ({
    resultados: alertas.map((alerta) => ({
      id: String(alerta.id),
      es_relevante: true,
      provincias: ['Teruel'],
      sectores: ['agricultura'],
      subsectores: ['cereal'],
      tipos_alerta: ['ayudas_subvenciones'],
    })),
    errores: [],
    fallbackLocal: 0,
  });
  const supabase = crearSupabaseFalso([{
    id: 8,
    titulo: 'Ayudas para explotaciones agrarias de cereal en Teruel',
    contenido: 'Convocatoria de subvenciones para agricultores.',
    discard_reason_code: 'sin_senal_rural',
    discard_reason: 'Motivo antiguo.',
    discard_stage: 'classifier_local',
    discard_confidence: 0.9,
  }]);
  const routes = registrarRutas(alertasRoutes, supabase);

  await invocar(routes['POST /alertas/clasificar']);

  const patch = supabase.updates[0];
  assert.strictEqual(patch.estado_ia, 'pendiente_resumir');
  assert.deepStrictEqual(
    {
      discard_reason_code: patch.discard_reason_code,
      discard_reason: patch.discard_reason,
      discard_stage: patch.discard_stage,
      discard_confidence: patch.discard_confidence,
    },
    limpiarCamposDescarte()
  );
});

test('9. reprocesar desde admin limpia las cuatro columnas de descarte', async () => {
  const supabase = crearSupabaseFalso([{ id: 9 }]);
  const routes = registrarRutas(adminAlertasRoutes, supabase);

  await invocar(routes['POST /admin/alertas/:id/reprocesar'], {
    params: { id: '9' },
    body: { fase: 'revisar' },
  });

  const patch = supabase.updates[0];
  assert.strictEqual(patch.estado_ia, 'pendiente_revisar');
  assert.deepStrictEqual(
    {
      discard_reason_code: patch.discard_reason_code,
      discard_reason: patch.discard_reason,
      discard_stage: patch.discard_stage,
      discard_confidence: patch.discard_confidence,
    },
    limpiarCamposDescarte()
  );
});

test('10. un error tecnico o respuesta incompleta queda pendiente sin descarte', async () => {
  const alerta = {
    id: 10,
    titulo: 'Normativa sobre actividad rural pendiente de analizar',
    contenido: 'Documento con informacion que requiere clasificacion experta.',
  };
  const result = await clasificarConReintentoReal([alerta]);

  assert.deepStrictEqual(result.resultados, []);
  assert.strictEqual(result.fallbackLocal, 0);
  assert(result.errores.some((error) => error.id === 10 && error.fase === 'individual'));

  responderIA = async () => JSON.stringify({ resultados: [] });
  const incomplete = await clasificarConReintentoReal([{ ...alerta, id: 12 }]);
  assert.deepStrictEqual(incomplete.resultados, []);
  assert.strictEqual(incomplete.fallbackLocal, 0);
  assert(incomplete.errores.some((error) => error.id === 12 && error.fase === 'individual'));
});

test('PATCH admin a pendiente_clasificar limpia el descarte anterior', async () => {
  const supabase = crearSupabaseFalso([{
    id: 12,
    estado_ia: 'descartado',
    discard_reason_code: 'sin_senal_rural',
    discard_reason: 'Motivo antiguo.',
    discard_stage: 'classifier_local',
    discard_confidence: 0.9,
  }]);
  const routes = registrarRutas(adminAlertasRoutes, supabase);

  await invocar(routes['PATCH /admin/alertas/:id'], {
    params: { id: '12' },
    body: {
      estado_ia: 'pendiente_clasificar',
    },
  });

  const patch = supabase.updates[0];
  assert.strictEqual(patch.estado_ia, 'pendiente_clasificar');
  assert.strictEqual(patch.discard_reason_code, null);
  assert.strictEqual(patch.discard_reason, null);
  assert.strictEqual(patch.discard_stage, null);
  assert.strictEqual(patch.discard_confidence, null);
});

test('el descarte manual del admin tambien utiliza el contrato comun', async () => {
  const supabase = crearSupabaseFalso([{
    id: 11,
    decision_audit: {
      preclassification: { pre_status: 'review' },
      classification: { es_relevante: true },
    },
  }]);
  const routes = registrarRutas(adminAlertasRoutes, supabase);

  await invocar(routes['PATCH /admin/alertas/:id'], {
    params: { id: '11' },
    body: {
      estado_ia: 'descartado',
    },
  });

  const patch = supabase.updates[0];
  assert.strictEqual(patch.estado_ia, 'descartado');
  assert.strictEqual(patch.resumen, 'NO IMPORTA');
  assert.strictEqual(patch.discard_reason_code, 'descarte_manual');
  assert(patch.discard_reason.includes('panel de administracion'));
  assert.strictEqual(patch.discard_stage, 'manual');
  assert.strictEqual(patch.decision_audit.classification.es_relevante, true);
});

(async () => {
  let passed = 0;
  let failed = 0;

  console.log('\n=== TESTS: alert discard audit ===\n');
  for (const current of tests) {
    try {
      await current.fn();
      passed++;
      console.log(`OK: ${current.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL: ${current.name}`);
      console.error(error);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
