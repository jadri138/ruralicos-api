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

test('ayuda con subsector auxiliar no demostrado conserva auditoria sin bloquear', () => {
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
  assert(sheet.unsupported_taxonomy_tags.includes('subsector:cereal'));
  assert.strictEqual(sheet.raw_document_id, 9001);
  assert.strictEqual(sheet.content_hash, 'hash-1');
  assert.strictEqual(sheet.plazo.status, 'verified');
  assert.strictEqual(sheet.beneficiarios.status, 'verified');
  assert(sheet.evidence_coverage >= 0.7);
  assert(sheet.official_evidence_coverage > 0);
  assert(['official', 'mixed'].includes(sheet.evidence_provenance));
  assert(sheet.truth_score >= 70);
});

test('regresion 17231: una ayuda FEADER valida no queda bloqueada por taxonomia auxiliar antigua', () => {
  const alerta = alertaBase(17231, {
    fuente: 'BOCYL',
    fecha: '2026-07-23',
    titulo: 'Extracto de la Orden de ayudas FEADER para plantaciones forestales de alto valor',
    url: 'https://bocyl.jcyl.es/boletines/2026/07/23/pdf/ejemplo.pdf',
    provincias: ['Castilla y Leon'],
    sectores: ['agricultura', 'ganaderia', 'mixto'],
    subsectores: ['frutales', 'olivar', 'trigo', 'forestal', 'agua', 'energia'],
    tipos_alerta: ['ayudas_subvenciones', 'normativa_general', 'registros_certificaciones'],
  });
  const sheet = construirFactSheetAlertaSync(alerta, {
    rawDocument: rawDocument(alerta, [
      'Consejeria de Medio Ambiente y Energia de Castilla y Leon.',
      'Se convocan ayudas cofinanciadas por el Fondo Europeo Agricola de Desarrollo Rural FEADER.',
      'Las ayudas se destinan a plantaciones de especies con producciones forestales de alto valor.',
      'Beneficiarios: entidades publicas o privadas propietarias de terrenos susceptibles de plantacion.',
      'La solicitud de ayuda se podra presentar hasta el 25 de septiembre de 2026.',
    ].join(' ')),
    now: new Date('2026-07-29T15:00:00Z'),
  });

  assert.strictEqual(sheet.builder_version, 'fact_sheet_builder_v4');
  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.READY);
  assert(sheet.truth_score >= 85);
  assert.strictEqual(sheet.risk_score, 0);
  assert(sheet.territorio.some((item) => item.valor === 'castilla y leon'));
  assert(sheet.taxonomy_evidence.some((item) => item.tag === 'subsector:forestal'));
  assert(sheet.unsupported_taxonomy_tags.includes('sector:ganaderia'));
});

test('curso de bienestar animal conserva evidencias sin aceptar el resumen generado como prueba', () => {
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
  assert(sheet.unsupported_taxonomy_tags.includes('subsector:vacuno'));
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

test('builder async usa documentTrace y audita etiqueta auxiliar sin bloquear', async () => {
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
  assert(sheet.unsupported_taxonomy_tags.includes('subsector:cereal'));
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

test('alerta historica sin raw document conserva evidencia derivada de menor nivel', () => {
  const alerta = alertaBase(11, {
    titulo: 'Curso agrario para agricultores de Huesca',
    contenido: 'Curso agrario dirigido a agricultores de Huesca. Inscripcion disponible.',
    resumen_final: 'FICHA_IA\nTIPO: cursos_formacion\nRESUMEN_DIGEST: Curso agrario para agricultores.\nACCION: revisar inscripcion.',
    tipos_alerta: ['formacion'],
    subsectores: [],
  });
  const sheet = construirFactSheetAlertaSync(alerta);

  assert.strictEqual(sheet.evidence_provenance, 'derived');
  assert.strictEqual(sheet.official_evidence_coverage, 0);
  assert(sheet.evidence_coverage > 0, 'la ausencia historica de raw_document no borra toda la cobertura');
});

test('el resumen generado no convierte una etiqueta inventada en evidencia taxonomica', () => {
  const alerta = alertaBase(12, {
    titulo: 'Resolucion administrativa general en Huesca',
    contenido: 'Resolucion administrativa publicada en Huesca.',
    resumen_final: 'FICHA_IA\nAFECTA_A: ganaderos de vacuno\nRESUMEN_DIGEST: Aviso para explotaciones de vacuno.',
    sectores: ['ganaderia'],
    subsectores: ['vacuno'],
    tipos_alerta: ['normativa_general'],
  });
  const sheet = construirFactSheetAlertaSync(alerta);

  assert(sheet.unsupported_taxonomy_tags.includes('sector:ganaderia'));
  assert(sheet.unsupported_taxonomy_tags.includes('subsector:vacuno'));
  assert(!sheet.taxonomy_evidence.some((item) => item.tag === 'sector:ganaderia'));
  assert(!sheet.taxonomy_evidence.some((item) => item.tag === 'subsector:vacuno'));
});

test('bloquea una oportunidad cuyo plazo operativo ya ha terminado', () => {
  const alerta = alertaBase(13, {
    fecha: '2026-06-01',
    titulo: 'Ayudas para explotaciones agrarias en Huesca',
    contenido: 'Se convocan ayudas para explotaciones agrarias en Huesca. El plazo de presentacion de solicitudes finaliza el 15 de junio de 2026. Los interesados pueden presentar solicitud.',
    tipos_alerta: ['ayudas_subvenciones'],
    subsectores: [],
  });
  const sheet = construirFactSheetAlertaSync(alerta, {
    now: new Date('2026-07-01T10:00:00Z'),
  });

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.BLOCKED);
  assert(sheet.flags.includes('operative_deadline_expired'));
});

test('mantiene vigente una oportunidad cuyo plazo termina en el futuro', () => {
  const alerta = alertaBase(14, {
    fecha: '2026-06-01',
    titulo: 'Ayudas para explotaciones agrarias en Huesca',
    contenido: 'Se convocan ayudas para explotaciones agrarias en Huesca. El plazo de presentacion de solicitudes finaliza el 15 de agosto de 2026. Los interesados pueden presentar solicitud.',
    tipos_alerta: ['ayudas_subvenciones'],
    subsectores: [],
  });
  const sheet = construirFactSheetAlertaSync(alerta, {
    now: new Date('2026-07-01T10:00:00Z'),
  });

  assert(!sheet.flags.includes('operative_deadline_expired'));
});

test('una alerta accionable sin accion demostrada queda para revision', () => {
  const alerta = alertaBase(15, {
    titulo: 'Bases generales de ayudas en Huesca',
    contenido: 'Se publican las bases generales de ayudas en Huesca.',
    tipos_alerta: ['ayudas_subvenciones'],
    subsectores: [],
  });
  const sheet = construirFactSheetAlertaSync(alerta);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.REVIEW);
  assert(sheet.flags.includes('accion_no_verificada'));
});

process.on('beforeExit', () => {
  console.log(`\nResultados factSheetValidator: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exitCode = 1;
});

