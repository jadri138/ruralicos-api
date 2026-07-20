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
const alertasFreeRoutes = require('../src/modules/alertas/alertasFree.routes');
const revisarAlertasRoutes = require('../src/modules/alertas/revisarAlertas.routes');

function crearSupabaseFalso(rows = [], {
  rawDocuments = [],
  rawError = null,
  respectFilters = false,
} = {}) {
  const updates = [];
  const queries = [];

  return {
    updates,
    queries,
    from(table) {
      let operation = 'select';
      let patch = null;
      const eqFilters = [];
      const sourceRows = table === 'raw_documents' ? rawDocuments : rows;
      const builder = {
        select(columns) {
          queries.push({ table, operation: 'select', columns });
          return builder;
        },
        update(value) {
          operation = 'update';
          patch = value;
          updates.push(value);
          return builder;
        },
        eq(column, value) {
          queries.push({ table, operation: 'eq', column, value });
          eqFilters.push({ column, value });
          return builder;
        },
        neq() { return builder; },
        not() { return builder; },
        or() { return builder; },
        is() { return builder; },
        in(column, values) {
          queries.push({ table, operation: 'in', column, values });
          return builder;
        },
        order() { return builder; },
        limit() { return builder; },
        single() {
          return Promise.resolve({
            data: { id: sourceRows[0]?.id || 1, ...(patch || {}) },
            error: null,
          });
        },
        maybeSingle() {
          return Promise.resolve({ data: sourceRows[0] || null, error: null });
        },
        then(onFulfilled, onRejected) {
          const selectedRows = respectFilters
            ? sourceRows.filter((row) => eqFilters.every(
              ({ column, value }) => row?.[column] === value
            ))
            : sourceRows;
          const result = operation === 'select'
            ? table === 'raw_documents' && rawError
              ? { data: null, error: { message: rawError } }
              : { data: selectedRows, error: null }
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

test('6b. DOGC no rural se bloquea antes de que revision o fallback lo marquen listo', async () => {
  const supabase = crearSupabaseFalso([{
    id: 61,
    fuente: 'DOGC',
    titulo: 'Resolución por la que se convoca un premio musical',
    contenido: 'Convocatoria de un premio de composición musical para jóvenes intérpretes y autores de canciones.',
    resumen_borrador: 'Ayuda agraria para explotaciones rurales.',
    sectores: ['agricultura'],
    subsectores: ['ganaderia'],
    tipos_alerta: ['ayudas_subvenciones'],
  }]);
  const routes = registrarRutas(alertasRoutes, supabase);

  const response = await invocar(routes['POST /alertas/revisar']);

  const patch = supabase.updates[0];
  assert.strictEqual(patch.estado_ia, 'descartado');
  assert.strictEqual(patch.discard_reason_code, 'actividad_cultural_no_rural');
  assert.strictEqual(patch.discard_stage, 'official_rural_gate');
  assert.strictEqual(response.body.aprobadas, 0);
  assert.strictEqual(response.body.descartadas_prefiltro, 1);
});

test('6c. DOE agrario con evidencia oficial conserva el flujo normal hasta listo', async () => {
  const supabase = crearSupabaseFalso([{
    id: 62,
    fuente: 'DOE',
    titulo: 'Ayudas para explotaciones agrarias',
    contenido: 'Convocatoria de subvenciones de la PAC para personas agricultoras y explotaciones agrarias de Extremadura.',
    resumen_borrador: 'FICHA_IA',
    sectores: ['agricultura'],
  }]);
  const routes = registrarRutas(alertasRoutes, supabase);

  const response = await invocar(routes['POST /alertas/revisar']);

  const patch = supabase.updates[0];
  assert.strictEqual(patch.estado_ia, 'listo');
  assert.strictEqual(response.body.aprobadas, 1);
  assert.strictEqual(response.body.descartadas_prefiltro, 0);
});

test('6d. /revisar carga metadatos oficiales enlazados sin consultar columnas inexistentes', async () => {
  const supabase = crearSupabaseFalso([{
    id: 63,
    fuente: 'DOGC',
    titulo: 'Resolución de convocatoria',
    contenido: 'Se publica la resolución completa y se abre el plazo previsto para que las personas interesadas presenten sus solicitudes.',
    resumen_borrador: 'FICHA_IA',
  }], {
    rawDocuments: [{
      id: 900,
      inserted_alerta_id: 63,
      organismo: 'Departamento de Cultura',
      seccion: 'Premios',
      boletin: 'DOGC 9999',
      id_oficial: 'DOGC-2026-63',
      metadata_json: {
        subseccion: 'Música',
        tipo_documento: 'Premio musical',
      },
      updated_at: '2026-07-20T10:00:00Z',
    }],
  });
  const routes = registrarRutas(alertasRoutes, supabase);

  await invocar(routes['POST /alertas/revisar']);

  const patch = supabase.updates[0];
  assert.strictEqual(patch.estado_ia, 'descartado');
  assert.strictEqual(patch.discard_reason_code, 'actividad_cultural_no_rural');
  const gate = patch.decision_audit.official_rural_gate;
  assert(gate.diagnostics.official_fields_used.includes('tipo_documento'));
  assert(gate.diagnostics.official_fields_used.includes('subseccion'));
  assert(gate.diagnostics.official_metadata_available.includes('id_oficial'));

  const rawSelect = supabase.queries.find(
    (query) => query.table === 'raw_documents' && query.operation === 'select'
  );
  assert(rawSelect, 'debe consultar raw_documents por inserted_alerta_id');
  assert(!/(^|,\s*)subseccion(?:,|$)/.test(rawSelect.columns));
  assert(!/(^|,\s*)tipo_documento(?:,|$)/.test(rawSelect.columns));
  assert(rawSelect.columns.includes('metadata_json'));
});

test('6e. alertas retenidas quedan fuera de revision y fallback automaticos', async () => {
  const supabase = crearSupabaseFalso([
    {
      id: 64,
      fuente: 'DOE',
      titulo: 'Resolución de información pública',
      contenido: 'Se publica el expediente administrativo general y se abre un plazo de audiencia para todas las personas que acrediten su condición de interesadas.',
      resumen_borrador: 'FICHA_IA',
    },
    {
      id: 65,
      fuente: 'DOGC',
      titulo: 'Resolución sin texto disponible',
      contenido: 'Resolución sin texto disponible',
      resumen_borrador: 'FICHA_IA',
    },
  ]);
  const routes = registrarRutas(alertasRoutes, supabase);

  const response = await invocar(routes['POST /alertas/revisar']);

  assert.deepStrictEqual(
    supabase.updates.map((patch) => patch.estado_ia),
    ['pendiente_revision_manual', 'needs_evidence']
  );
  assert(!supabase.updates.some((patch) => patch.estado_ia === 'listo'));
  assert.strictEqual(response.body.aprobadas, 0);
  assert.strictEqual(response.body.retenidas_revision, 1);
  assert.strictEqual(response.body.needs_evidence, 1);
  assert.strictEqual(response.body.fallback_local, 0);
});

test('6f. ejecuciones posteriores de /revisar no vuelven a seleccionar estados retenidos', async () => {
  const supabase = crearSupabaseFalso([
    { id: 641, fuente: 'DOE', estado_ia: 'pendiente_revision_manual' },
    { id: 651, fuente: 'DOGC', estado_ia: 'needs_evidence' },
  ], { respectFilters: true });
  const routes = registrarRutas(alertasRoutes, supabase);

  const response = await invocar(routes['POST /alertas/revisar']);

  assert.strictEqual(response.body.procesadas, 0);
  assert.deepStrictEqual(supabase.updates, []);
  assert(!supabase.queries.some((query) => query.table === 'raw_documents'));
});

test('6g. fallo al leer metadata limita la barrera a campos disponibles y nunca habilita fallback', async () => {
  const supabase = crearSupabaseFalso([{
    id: 652,
    fuente: 'DOGC',
    titulo: 'Resolución de información pública',
    contenido: 'Se publica el expediente administrativo general y se abre un plazo de audiencia para todas las personas interesadas conforme al procedimiento aplicable.',
    resumen_borrador: 'FICHA_IA',
  }], { rawError: 'raw_documents no disponible' });
  const routes = registrarRutas(alertasRoutes, supabase);

  const response = await invocar(routes['POST /alertas/revisar']);

  assert.deepStrictEqual(
    supabase.updates.map((patch) => patch.estado_ia),
    ['pendiente_revision_manual']
  );
  assert.strictEqual(response.body.aprobadas, 0);
  assert(response.body.errores.some((error) => error.fase === 'official_metadata'));
});

test('estado-pipeline muestra revision manual y needs_evidence sin marcarlas automaticas', async () => {
  const supabase = crearSupabaseFalso([
    { id: 66, fuente: 'DOE', estado_ia: 'pendiente_revision_manual', resumen: 'REVISION RURAL REQUERIDA' },
    { id: 67, fuente: 'DOGC', estado_ia: 'needs_evidence', resumen: 'SIN EVIDENCIA OFICIAL' },
    { id: 68, fuente: 'DOE', estado_ia: 'listo', resumen: 'Ficha lista' },
  ]);
  const routes = registrarRutas(alertasRoutes, supabase);

  const response = await invocar(routes['GET /alertas/estado-pipeline'], {
    query: { fecha: '2026-07-20' },
  });

  assert.strictEqual(response.body.pendientes_total, 2);
  assert.strictEqual(response.body.pendientes_automaticos_total, 0);
  assert.strictEqual(response.body.retenidas_total, 2);
  assert.strictEqual(response.body.pendiente_revision_manual_total, 1);
  assert.strictEqual(response.body.needs_evidence_total, 1);
  assert(response.body.pendientes_preview.every(
    (alerta) => alerta.procesamiento_automatico === false
  ));
});

test('herramientas admin localizan y reprocesan manualmente ambos estados retenidos', async () => {
  const supabase = crearSupabaseFalso([
    { id: 69, estado_ia: 'pendiente_revision_manual' },
    { id: 70, estado_ia: 'needs_evidence' },
  ]);
  const alertRoutes = registrarRutas(alertasRoutes, supabase);
  const adminRoutes = registrarRutas(adminAlertasRoutes, supabase);

  await invocar(alertRoutes['GET /alertas'], {
    query: { estado_ia: 'pendiente_revision_manual' },
  });
  assert(supabase.queries.some((query) =>
    query.table === 'alertas'
    && query.operation === 'eq'
    && query.column === 'estado_ia'
    && query.value === 'pendiente_revision_manual'
  ));

  await invocar(adminRoutes['POST /admin/alertas/:id/reprocesar'], {
    params: { id: '69' },
    body: { fase: 'revisar' },
  });
  await invocar(adminRoutes['POST /admin/alertas/:id/reprocesar'], {
    params: { id: '70' },
    body: { fase: 'clasificar' },
  });

  assert.strictEqual(supabase.updates[0].estado_ia, 'pendiente_revisar');
  assert.strictEqual(supabase.updates[1].estado_ia, 'pendiente_clasificar');
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

test('FREE y revisor legacy seleccionan por estado listo y no por NO IMPORTA', async () => {
  const rows = [{
    id: 13,
    estado_ia: 'descartado',
    resumen: 'NO IMPORTA',
    resumenfree: 'Resumen historico',
    revision_final: false,
  }];

  const freeSupabase = crearSupabaseFalso(rows, { respectFilters: true });
  const freeRoutes = registrarRutas(alertasFreeRoutes, freeSupabase);
  const freeResponse = await invocar(freeRoutes['POST /alertas/generar-resumen-free'], {
    query: { fecha: '2026-07-20' },
  });
  assert.strictEqual(freeResponse.body.procesadas, 0);
  assert(freeSupabase.queries.some((query) =>
    query.table === 'alertas'
    && query.operation === 'eq'
    && query.column === 'estado_ia'
    && query.value === 'listo'
  ));

  const legacySupabase = crearSupabaseFalso(rows, { respectFilters: true });
  const legacyRoutes = registrarRutas(revisarAlertasRoutes, legacySupabase);
  const legacyResponse = await invocar(legacyRoutes['POST /alertas/revisar-final']);
  assert.strictEqual(legacyResponse.body.revisadas, 0);
  assert(legacySupabase.queries.some((query) =>
    query.table === 'alertas'
    && query.operation === 'eq'
    && query.column === 'estado_ia'
    && query.value === 'listo'
  ));
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
