const assert = require('assert');
const { FACT_SHEET_STATUS } = require('../src/modules/alertas/intelligence/factSheetSchema');
const {
  construirFactSheetAlerta,
  construirFactSheetAlertaSync,
} = require('../src/modules/alertas/intelligence/factSheetBuilder');
const { validarFactSheet } = require('../src/modules/alertas/intelligence/factSheetValidator');

let passed = 0;
let failed = 0;

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`OK: ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`FAIL: ${name}`);
      console.error(err.message);
    });
}

function alertaBase(id, overrides = {}) {
  return {
    id,
    organization_id: 3,
    fuente: 'BOA',
    titulo: `Alerta agraria ${id}`,
    url: `https://example.com/${id}`,
    fecha: '2026-06-20',
    estado_ia: 'listo',
    resumen_final: 'FICHA_IA\nRESUMEN_DIGEST: Aviso agrario con objeto claro.\nHECHO: aviso agrario\nACCION: revisar publicacion.',
    contenido: 'Aviso agrario con contenido suficiente.',
    provincias: ['Huesca'],
    sectores: ['agricultura'],
    subsectores: ['cereal'],
    tipos_alerta: ['normativa_general'],
    embedding_generated_at: '2026-06-20T08:00:00Z',
    ...overrides,
  };
}

function rawDocument(alerta, texto, overrides = {}) {
  return {
    id: 9000 + Number(alerta.id),
    inserted_alerta_id: alerta.id,
    organization_id: alerta.organization_id,
    url_pdf: alerta.url,
    id_oficial: `DOC-${alerta.id}`,
    contenido_hash: `hash-${alerta.id}`,
    capture_status: 'inserted',
    texto_raw: texto,
    ...overrides,
  };
}

console.log('\n=== TESTS: fact sheet evidence-first ===\n');

test('ayuda/subvencion con plazo claro queda lista para digest', () => {
  const alerta = alertaBase(1, {
    titulo: 'Convocatoria de ayudas para modernizacion de explotaciones agrarias en Huesca',
    resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nRESUMEN_DIGEST: Convocatoria de ayudas para modernizacion de explotaciones agrarias.\nBENEFICIARIOS: explotaciones agrarias\nPLAZO: hasta el 30 de julio de 2026\nACCION: presentar solicitud.',
    contenido: 'Se convocan ayudas para modernizacion de explotaciones agrarias en Huesca. El plazo finaliza el 30 de julio de 2026.',
    tipos_alerta: ['ayudas_subvenciones'],
  });
  const sheet = construirFactSheetAlertaSync(alerta, {
    rawDocument: rawDocument(alerta, 'Convocatoria de ayudas para explotaciones agrarias de Huesca. Beneficiarios: explotaciones agrarias. Plazo: hasta el 30 de julio de 2026. Accion: presentar solicitud.'),
    now: new Date('2026-06-20T10:00:00Z'),
  });

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.READY);
  assert.strictEqual(sheet.raw_document_id, 9001);
  assert.strictEqual(sheet.content_hash, 'hash-1');
  assert.strictEqual(sheet.plazo.status, 'verified');
  assert.strictEqual(sheet.beneficiarios.status, 'verified');
  assert(sheet.evidence_coverage >= 0.7);
  assert(sheet.truth_score >= 70);
});

test('curso de bienestar animal conserva sector ganadero y accion con evidencia', () => {
  const alerta = alertaBase(2, {
    titulo: 'Curso de bienestar animal para titulares de explotaciones ganaderas en Huesca',
    resumen_final: 'FICHA_IA\nTIPO: cursos_formacion\nRESUMEN_DIGEST: Curso de bienestar animal para titulares de explotaciones ganaderas.\nACCION: revisar inscripcion.',
    contenido: 'Curso de bienestar animal dirigido a titulares de explotaciones ganaderas de Huesca. Inscripcion abierta.',
    sectores: ['ganaderia'],
    subsectores: ['vacuno'],
    tipos_alerta: ['cursos_formacion', 'sanidad_animal'],
  });
  const sheet = construirFactSheetAlertaSync(alerta);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.READY);
  assert.strictEqual(sheet.tipo_documento.valor, 'curso_formacion');
  assert(sheet.sectores.some((field) => field.valor === 'ganaderia'));
  assert(sheet.accion_requerida.evidencia);
});

test('ayuda sin plazo claro queda en revision y no inventa plazo', () => {
  const alerta = alertaBase(3, {
    titulo: 'Ayudas para inversiones en explotaciones agrarias de Huesca',
    resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nRESUMEN_DIGEST: Ayudas para inversiones en explotaciones agrarias.\nBENEFICIARIOS: explotaciones agrarias\nACCION: revisar convocatoria.',
    contenido: 'Ayudas para inversiones en explotaciones agrarias de Huesca. No aparece plazo claro en el extracto disponible.',
    tipos_alerta: ['ayudas_subvenciones'],
  });
  const sheet = construirFactSheetAlertaSync(alerta);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.REVIEW);
  assert.strictEqual(sheet.plazo.valor, null);
  assert(sheet.flags.includes('plazo_no_verificado'));
});

test('concesion de aguas individual queda review_only, no envio automatico', () => {
  const alerta = alertaBase(4, {
    titulo: 'Solicitud de concesion de aguas para riego en parcela concreta de Huesca',
    resumen_final: 'FICHA_IA\nTIPO: agua_infraestructuras\nRESUMEN_DIGEST: Solicitud de concesion de aguas para una parcela concreta.\nPLAZO: alegaciones durante 20 dias\nACCION: revisar solo si coincide el expediente.',
    contenido: 'Solicitud de concesion de aguas para riego en parcela concreta de Huesca. Expediente individual sometido a informacion publica.',
    subsectores: ['agua'],
    tipos_alerta: ['agua_infraestructuras'],
  });
  const sheet = construirFactSheetAlertaSync(alerta);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.REVIEW);
  assert(sheet.flags.includes('expediente_individual'));
  assert(sheet.plazo.status === 'verified');
});

test('sancion individual queda bloqueada', () => {
  const alerta = alertaBase(5, {
    titulo: 'Notificacion de expediente sancionador a persona interesada',
    resumen_final: 'FICHA_IA\nTIPO: normativa_general\nRESUMEN_DIGEST: Notificacion individual de expediente sancionador.\nHECHO: sancion individual\nACCION: no enviar.',
    contenido: 'Notificacion a persona interesada en procedimiento sancionador individual.',
    tipos_alerta: ['normativa_general'],
  });
  const sheet = construirFactSheetAlertaSync(alerta);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.BLOCKED);
  assert(sheet.flags.includes('sancion_individual'));
});

test('alerta generica queda bloqueada', () => {
  const alerta = alertaBase(6, {
    titulo: 'Publicacion oficial relevante',
    resumen_final: 'FICHA_IA\nRESUMEN_DIGEST: Publicacion oficial relevante. Revisar si afecta.\nHECHO: publicacion oficial relevante\nACCION: revisar documento completo.',
    contenido: 'Publicacion oficial relevante. Revisar si afecta o aplica.',
  });
  const sheet = construirFactSheetAlertaSync(alerta);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.BLOCKED);
  assert(sheet.flags.includes('resumen_generico'));
});

test('alerta sin URL oficial queda bloqueada', () => {
  const alerta = alertaBase(7, {
    url: '',
    titulo: 'Convocatoria de ayudas para explotaciones agrarias en Huesca',
    resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nRESUMEN_DIGEST: Convocatoria de ayudas para explotaciones agrarias.\nBENEFICIARIOS: explotaciones agrarias\nPLAZO: 30 dias\nACCION: presentar solicitud.',
    contenido: 'Convocatoria de ayudas para explotaciones agrarias de Huesca. Plazo de 30 dias.',
    tipos_alerta: ['ayudas_subvenciones'],
  });
  const sheet = construirFactSheetAlertaSync(alerta);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.BLOCKED);
  assert(sheet.flags.includes('sin_url_oficial'));
});

test('provincia no demostrada no se copia a territorio', () => {
  const alerta = alertaBase(8, {
    titulo: 'Ayudas para explotaciones agrarias',
    resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nRESUMEN_DIGEST: Ayudas para explotaciones agrarias.\nBENEFICIARIOS: explotaciones agrarias\nPLAZO: 30 dias\nACCION: presentar solicitud.',
    contenido: 'Ayudas para explotaciones agrarias. El texto disponible no menciona la provincia.',
    provincias: ['Huesca'],
    tipos_alerta: ['ayudas_subvenciones'],
  });
  const sheet = construirFactSheetAlertaSync(alerta);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.BLOCKED);
  assert.strictEqual(sheet.territorio.length, 0);
  assert(sheet.flags.includes('territorio_no_verificado'));
});

test('builder async usa documentTrace cuando recibe supabase', async () => {
  const alerta = alertaBase(9, {
    titulo: 'Convocatoria de ayudas para explotaciones agrarias en Huesca',
    resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nRESUMEN_DIGEST: Convocatoria de ayudas para explotaciones agrarias.\nBENEFICIARIOS: explotaciones agrarias\nPLAZO: 30 dias\nACCION: presentar solicitud.',
    contenido: 'Convocatoria de ayudas para explotaciones agrarias de Huesca. Plazo de 30 dias.',
    tipos_alerta: ['ayudas_subvenciones'],
  });
  const raw = rawDocument(alerta, 'Convocatoria de ayudas para explotaciones agrarias de Huesca. Beneficiarios: explotaciones agrarias. Plazo: 30 dias. Accion: presentar solicitud.');
  const supabase = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: [raw], error: null }); },
      };
    },
  };

  const sheet = await construirFactSheetAlerta(alerta, {
    supabase,
    now: new Date('2026-06-20T10:00:00Z'),
  });

  assert.strictEqual(sheet.document_trace.status, 'linked');
  assert.strictEqual(sheet.raw_document_id, raw.id);
  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.READY);
});

test('validator detecta plazo inventado en una ficha manual', () => {
  const alerta = alertaBase(10, {
    titulo: 'Ayudas para explotaciones agrarias en Huesca',
    contenido: 'Ayudas para explotaciones agrarias de Huesca.',
    tipos_alerta: ['ayudas_subvenciones'],
  });
  const sheet = construirFactSheetAlertaSync(alerta);
  const edited = {
    ...sheet,
    plazo: { valor: 'hasta el 30 de julio', evidencia: null, source: null, confidence: 0, status: 'no_verificado' },
  };
  const validated = validarFactSheet(edited, { alerta });

  assert(validated.flags.includes('plazo_no_verificado'));
  assert.notStrictEqual(validated.status, FACT_SHEET_STATUS.READY);
});

process.on('beforeExit', () => {
  console.log(`\nResultados factSheetValidator: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exitCode = 1;
});

