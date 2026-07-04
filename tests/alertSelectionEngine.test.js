const assert = require('assert');
const {
  decidirAlertaParaDigest,
  seleccionarAlertasParaDigest,
} = require('../src/modules/alertas/seleccion/alertSelectionEngine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

console.log('\n=== TESTS: alert selection engine v2 ===\n');

const user = {
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Teruel', 'Zaragoza'],
    sectores: ['agricultura', 'ganaderia'],
    subsectores: ['agua', 'vacuno', 'olivar'],
    tipos_alerta: {
      ayudas_subvenciones: true,
      agua_infraestructuras: true,
      normativa_general: true,
      medio_ambiente: true,
    },
  },
};

function alerta(id, overrides = {}) {
  return {
    id,
    fuente: 'BOA',
    titulo: `Convocatoria de ayudas para riego agricola en Teruel ${id}`,
    url: `https://example.com/${id}`,
    fecha: '2026-06-04',
    estado_ia: 'listo',
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'PRIORIDAD: media',
      'RESUMEN_DIGEST: Convocatoria de ayudas para explotaciones agrarias con plazo de solicitud abierto y requisitos operativos claros.',
      'HECHO: convocatoria de ayudas para riego agricola',
      'PLAZO: 20 dias habiles',
      'ACCION: presentar solicitud',
    ].join('\n'),
    contenido: 'Se convocan ayudas para explotaciones agrarias de Teruel con plazo de solicitud de 20 dias habiles.',
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['agua'],
    tipos_alerta: ['ayudas_subvenciones'],
    embedding_generated_at: '2026-06-04T08:00:00Z',
    similitud: 0.7,
    ...overrides,
  };
}

test('incluye alertas accionables con score explicable', () => {
  const decision = decidirAlertaParaDigest(alerta(1), user);
  assert.strictEqual(decision.incluir, true);
  assert(decision.score >= 80);
  assert(decision.diagnostico.ranking.reasons.some((reason) => reason.code === 'accion_con_plazo'));
});

test('alerta de todas las provincias entra aunque el usuario tenga una provincia concreta', () => {
  const decision = decidirAlertaParaDigest(alerta(101, {
    fuente: 'BOE',
    titulo: 'Ayudas estatales para explotaciones agrarias en todo el territorio nacional',
    provincias: ['todas'],
  }), user);

  assert.strictEqual(decision.incluir, true);
  assert.strictEqual(decision.diagnostico.policy.matches.provincia, true);
  assert.strictEqual(decision.diagnostico.policy.matches.provincia_nacional, true);
});

test('preferencia plazos acepta ayuda accionable con plazo aunque el tipo base sea ayudas', () => {
  const userPlazos = {
    ...user,
    preferences: {
      ...user.preferences,
      tipos_alerta: { plazos: true },
    },
  };
  const decision = decidirAlertaParaDigest(alerta(102, {
    tipos_alerta: ['ayudas_subvenciones'],
  }), userPlazos);

  assert.strictEqual(decision.incluir, true);
  assert(decision.diagnostico.ranking.reasons.some((reason) => reason.code === 'accion_con_plazo'));
});

test('bloquea licitaciones aunque coincidan preferencias', () => {
  const decision = decidirAlertaParaDigest(alerta(2, {
    titulo: 'Anuncio de formalizacion de contrato de servicios agrarios en Teruel',
    resumen_final: 'FICHA_IA\nTIPO: normativa_general\nRESUMEN_DIGEST: Anuncio de formalizacion de contrato de servicios administrativos.',
    contenido: 'Anuncio de formalizacion de contrato y adjudicacion de contrato.',
    tipos_alerta: ['normativa_general'],
  }), user);

  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.motivo, 'licitacion_bajo_valor');
});

test('revision segura exige calidad alta configurada', () => {
  const decision = decidirAlertaParaDigest({
    id: 3,
    fuente: 'BOE',
    titulo: 'Informacion publica sobre explotaciones agrarias',
    url: 'https://example.com/3',
    fecha: '2026-06-04',
    estado_ia: 'listo',
    resumen_final: [
      'FICHA_IA',
      'RESUMEN_DIGEST: Informacion publica con plazo para alegaciones.',
      'PLAZO: 20 dias habiles',
    ].join('\n'),
    contenido: 'Informacion publica con plazo para alegaciones.',
    provincias: ['nacional'],
    sectores: ['agricultura'],
    subsectores: [],
    tipos_alerta: ['normativa_general'],
    embedding_generated_at: '2026-06-04T08:00:00Z',
  }, {
    subscription: 'cooperativa',
    preferences: { provincias: [], sectores: [], subsectores: [], tipos_alerta: {} },
  }, {
    minIncludeScore: 80,
    minReviewScore: 50,
    minReviewQualityScore: 99,
  });

  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.motivo, 'calidad_baja');
  assert(decision.score >= 50 && decision.score < 80);
});

test('revision segura queda review_only y no entra en digest automatico', () => {
  const decision = decidirAlertaParaDigest({
    id: 103,
    fuente: 'BOE',
    titulo: 'Informacion publica sobre explotaciones agrarias',
    url: 'https://example.com/103',
    fecha: '2026-06-04',
    estado_ia: 'listo',
    resumen_final: [
      'FICHA_IA',
      'RESUMEN_DIGEST: Informacion publica con plazo para alegaciones.',
      'PLAZO: 20 dias habiles',
    ].join('\n'),
    contenido: 'Informacion publica con plazo para alegaciones.',
    provincias: ['nacional'],
    sectores: ['agricultura'],
    subsectores: [],
    tipos_alerta: ['normativa_general'],
    embedding_generated_at: '2026-06-04T08:00:00Z',
  }, {
    subscription: 'cooperativa',
    preferences: { provincias: [], sectores: ['agricultura'], subsectores: [], tipos_alerta: {} },
  }, {
    minIncludeScore: 90,
    minReviewScore: 50,
    minReviewQualityScore: 70,
  });

  assert.strictEqual(decision.action, 'review_only');
  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.sendable, false);
  assert.strictEqual(decision.review_required, true);
});

test('fact sheet review_only fuerza revision aunque el score sea alto', () => {
  const decision = decidirAlertaParaDigest(alerta(104, {
    fact_sheet_status: 'review_only',
    truth_score: 90,
    risk_score: 20,
    evidence_coverage: 0.8,
  }), user);

  assert.strictEqual(decision.action, 'review_only');
  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.riesgo_de_ruido, 'alto');
  assert(decision.diagnostico.policy.riesgo_de_ruido.reasons.some((reason) => reason.code === 'fact_sheet_review_only'));
});

test('ayuda sin plazo verificable queda en revision y no se autoenvia', () => {
  const decision = decidirAlertaParaDigest(alerta(106, {
    titulo: 'Ayudas para inversiones en explotaciones agrarias',
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'PRIORIDAD: media',
      'RESUMEN_DIGEST: Se publican ayudas para inversiones agrarias, sin plazo claro en la ficha.',
      'HECHO: ayudas para inversiones agrarias',
      'ACCION: revisar convocatoria',
    ].join('\n'),
    contenido: 'Se publican ayudas para inversiones agrarias. El texto disponible no permite confirmar plazo.',
  }), user);

  assert.strictEqual(decision.action, 'review_only');
  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.diagnostico.policy.signals.plazo_no_verificado, true);
  assert(decision.diagnostico.policy.riesgo_de_ruido.reasons.some((reason) => reason.code === 'plazo_no_verificado'));
});

test('premia fases accionables de justificacion aunque no sean solicitud inicial', () => {
  const decision = decidirAlertaParaDigest(alerta(108, {
    titulo: 'Justificacion de ayudas para inversiones agrarias en Teruel',
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'PRIORIDAD: alta',
      'RESUMEN_DIGEST: Se abre el plazo para presentar la cuenta justificativa de ayudas a inversiones agrarias.',
      'HECHO: fase de justificacion de ayudas agrarias',
      'PLAZO: 15 dias habiles',
      'ACCION: presentar cuenta justificativa y facturas justificativas',
    ].join('\n'),
    contenido: 'Las personas beneficiarias deberan presentar cuenta justificativa y facturas justificativas en el plazo de 15 dias habiles.',
  }), user);

  assert.strictEqual(decision.action, 'include');
  assert.strictEqual(decision.diagnostico.policy.signals.intencion.fase, 'justificacion');
  assert(decision.diagnostico.ranking.reasons.some((reason) => reason.code === 'justificacion'));
});

test('premia obligaciones operativas de bioseguridad frente a informacion generica', () => {
  const ganadero = {
    ...user,
    preferences: {
      ...user.preferences,
      sectores: ['ganaderia'],
      subsectores: ['vacuno', 'bioseguridad'],
      tipos_alerta: { sanidad_animal: true, normativa_general: true },
    },
  };
  const decision = decidirAlertaParaDigest(alerta(109, {
    titulo: 'Medidas obligatorias de bioseguridad para explotaciones ganaderas en Teruel',
    resumen_final: [
      'FICHA_IA',
      'TIPO: sanidad_animal',
      'PRIORIDAD: alta',
      'RESUMEN_DIGEST: Se aprueban medidas obligatorias de bioseguridad para explotaciones ganaderas.',
      'HECHO: nuevas obligaciones sanitarias para explotaciones ganaderas',
      'ACCION: aplicar plan de bioseguridad y limpieza y desinfeccion',
    ].join('\n'),
    contenido: 'Las explotaciones ganaderas deberan aplicar medidas obligatorias de bioseguridad, limpieza y desinfeccion de vehiculos.',
    sectores: ['ganaderia'],
    subsectores: ['vacuno', 'bioseguridad'],
    tipos_alerta: ['sanidad_animal'],
    taxonomy_tags: ['sector:ganaderia', 'subsector:bioseguridad', 'concepto:bioseguridad'],
  }), ganadero);

  assert.strictEqual(decision.action, 'include');
  assert.strictEqual(decision.diagnostico.policy.signals.intencion.fase, 'obligacion_tramite');
  assert(decision.diagnostico.ranking.reasons.some((reason) => reason.code === 'obligacion_operativa'));
});

test('deriva sanidad animal desde bioseguridad aunque falte tipos_alerta', () => {
  const ganadero = {
    ...user,
    preferences: {
      ...user.preferences,
      sectores: ['ganaderia'],
      subsectores: ['bioseguridad'],
      tipos_alerta: { sanidad_animal: true },
    },
  };
  const decision = decidirAlertaParaDigest(alerta(111, {
    titulo: 'Medidas obligatorias de bioseguridad para explotaciones ganaderas en Teruel',
    resumen_final: [
      'FICHA_IA',
      'TIPO: sanidad_animal',
      'PRIORIDAD: alta',
      'RESUMEN_DIGEST: Se aprueban medidas obligatorias de bioseguridad para explotaciones ganaderas.',
      'HECHO: medidas obligatorias de bioseguridad ganadera',
      'ACCION: aplicar el plan de bioseguridad',
    ].join('\n'),
    contenido: 'Las explotaciones ganaderas deberan aplicar medidas obligatorias de bioseguridad.',
    sectores: ['ganaderia'],
    subsectores: ['bioseguridad'],
    tipos_alerta: [],
    taxonomy_tags: ['sector:ganaderia', 'subsector:bioseguridad', 'concepto:bioseguridad'],
  }), ganadero);

  assert.strictEqual(decision.action, 'include');
  assert.strictEqual(decision.diagnostico.policy.matches.tipo, true);
  assert.strictEqual(decision.diagnostico.policy.riesgo_de_ruido.reasons.some((reason) => reason.code === 'tipo_alerta_vacio'), false);
});

test('rebaja resoluciones ex post aunque coincidan por tema de ayuda', () => {
  const decision = decidirAlertaParaDigest(alerta(110, {
    titulo: 'Resolucion definitiva de concesion de subvenciones agrarias en Teruel',
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'PRIORIDAD: media',
      'RESUMEN_DIGEST: Se publica la relacion definitiva de beneficiarios y el pago de la ayuda.',
      'HECHO: resolucion definitiva de concesion de subvenciones agrarias',
      'ACCION: consultar la relacion si ya eres beneficiario',
    ].join('\n'),
    contenido: 'Resolucion definitiva de concesion de subvenciones. Se publica la relacion de beneficiarios definitivos y se ordena el pago de la ayuda.',
  }), user);

  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.action, 'exclude');
  assert.strictEqual(decision.diagnostico.policy.signals.intencion.fase, 'resolucion_pago');
  assert(decision.diagnostico.policy.riesgo_de_ruido.reasons.some((reason) => reason.code === 'intencion_resolucion_pago'));
});

test('convocatoria general sin plazo verificado se envia sin inventar fecha limite', () => {
  const decision = decidirAlertaParaDigest(alerta(107, {
    fuente: 'BOE',
    titulo: 'Extracto de la Resolucion por la que se convocan subvenciones a explotaciones agrarias de titularidad compartida',
    provincias: [],
    subsectores: [],
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'PRIORIDAD: media',
      'RESUMEN_DIGEST: Se convocan subvenciones por concesion directa a explotaciones agrarias de titularidad compartida.',
      'HECHO: convocatoria de subvenciones para explotaciones agrarias',
      'PLAZO: no_detectado',
      'ACCION: revisar si aparece tu explotacion, expediente o plazo publicado el 2026-06-23',
    ].join('\n'),
    contenido: 'Extracto de la resolucion por la que se convocan subvenciones por concesion directa a explotaciones agrarias de titularidad compartida.',
  }), user);

  assert.strictEqual(decision.action, 'include');
  assert.strictEqual(decision.incluir, true);
  assert.strictEqual(decision.sendable, true);
  assert.strictEqual(decision.motivo, 'incluida_sin_plazo_verificado');
  assert.strictEqual(decision.riesgo, 'medio');
  assert.strictEqual(decision.diagnostico.policy.signals.plazo_no_verificado, true);
  assert.strictEqual(decision.diagnostico.policy.signals.es_convocatoria_ayuda, true);
  assert.strictEqual(decision.diagnostico.policy.signals.es_individual, false);
});

test('ayuda autonomica andaluza sin provincia explicita entra para agricultor andaluz', () => {
  const agricultorAndaluz = {
    subscription: 'cooperativa',
    preferences: {
      provincias: ['Cordoba'],
      sectores: ['agricultura'],
      subsectores: ['olivar'],
      tipos_alerta: {
        ayudas_subvenciones: true,
      },
    },
  };

  const decision = decidirAlertaParaDigest(alerta(12431, {
    fuente: 'BOJA',
    titulo: 'Resolucion por la que se convocan ayudas dirigidas al apoyo a la prestacion de servicios de asesoramiento',
    region: 'Andalucia',
    provincias: [],
    sectores: ['mixto'],
    subsectores: ['ovino', 'vacuno', 'caprino', 'porcino', 'avicultura', 'vinedo', 'agua', 'medio_ambiente'],
    tipos_alerta: ['ayudas_subvenciones'],
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'PRIORIDAD: media',
      'RESUMEN_DIGEST: Se convocan ayudas para apoyar servicios de asesoramiento vinculados a explotaciones agrarias y ganaderas en Andalucia.',
      'HECHO: convocatoria de ayudas para servicios de asesoramiento agrario',
      'BENEFICIARIOS: agricultores, ganaderos y titulares de explotaciones que cumplan la convocatoria',
      'PLAZO: no_detectado',
      'ACCION: revisar la publicacion oficial para comprobar requisitos y plazo',
    ].join('\n'),
    contenido: [
      'Se convocan ayudas dirigidas al apoyo a la prestacion de servicios de asesoramiento especifico en sanidad y bienestar animal.',
      'La intervencion forma parte del Plan Estrategico de la PAC y esta financiada por FEADER.',
      'La financiacion se realiza con cargo a los fondos FEADER y al presupuesto de la Junta de Andalucia.',
      'Podran estar vinculadas a agricultores, ganaderos y titulares de explotaciones agrarias de Andalucia segun la convocatoria.',
    ].join(' '),
  }), agricultorAndaluz);

  assert.strictEqual(decision.action, 'include');
  assert.strictEqual(decision.incluir, true);
  assert.strictEqual(decision.motivo, 'incluida_sin_plazo_verificado');
  assert.strictEqual(decision.diagnostico.policy.matches.provincia_expresa, true);
  assert.strictEqual(decision.diagnostico.policy.matches.sector_expreso, true);
  assert.strictEqual(decision.diagnostico.policy.matches.tipo_expreso, true);
  assert.strictEqual(decision.diagnostico.policy.signals.es_individual, false);
  assert.strictEqual(decision.diagnostico.policy.signals.es_nombramiento, false);
});

test('notificacion individual de ayuda no se relaja como convocatoria general', () => {
  const agricultorAndaluz = {
    subscription: 'cooperativa',
    preferences: {
      provincias: ['Cordoba'],
      sectores: ['agricultura'],
      subsectores: ['olivar'],
      tipos_alerta: {
        ayudas_subvenciones: true,
      },
    },
  };

  const decision = decidirAlertaParaDigest(alerta(12452, {
    fuente: 'BOJA',
    titulo: 'Notificacion individual en expediente de ayudas ganaderas',
    region: 'Andalucia',
    provincias: [],
    sectores: ['ganaderia'],
    subsectores: ['vacuno'],
    tipos_alerta: ['ayudas_subvenciones'],
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'PRIORIDAD: media',
      'RESUMEN_DIGEST: Notificacion individual de un expediente de ayudas.',
      'HECHO: expediente individual de ayuda',
      'ACCION: revisar si eres titular del expediente',
    ].join('\n'),
    contenido: 'Notificacion individual en expediente de ayudas ganaderas solicitada por un titular concreto.',
  }), agricultorAndaluz);

  assert.strictEqual(decision.incluir, false);
  assert(['sector_no_coincide', 'subsector_no_coincide', 'expediente_individual_sin_municipio'].includes(decision.motivo));
});

test('taxonomy_tags amplian sectores para ayuda BOE ICO-MAPA-SAECA ganadera', () => {
  const ganaderoAndaluz = {
    subscription: 'cooperativa',
    preferences: {
      provincias: ['Cordoba'],
      sectores: ['ganaderia'],
      subsectores: [],
      tipos_alerta: {
        ayudas_subvenciones: true,
      },
    },
  };

  const decision = decidirAlertaParaDigest(alerta(12570, {
    fuente: 'BOE',
    titulo: 'Extracto de la Resolucion por la que se convocan ayudas ICO-MAPA-SAECA por sequia',
    provincias: ['nacional'],
    sectores: ['agricultura'],
    subsectores: [],
    tipos_alerta: ['ayudas_subvenciones'],
    taxonomy_tags: ['sector:ganaderia', 'tipo:ayudas_subvenciones'],
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'PRIORIDAD: media',
      'RESUMEN_DIGEST: Se convocan ayudas de la linea ICO-MAPA-SAECA por sequia para explotaciones agrarias, ganaderas y cooperativas.',
      'HECHO: convocatoria de ayudas ICO-MAPA-SAECA',
      'BENEFICIARIOS: titulares de explotaciones agrarias y ganaderas',
      'PLAZO: el plazo finalizara el 30 de septiembre de 2028',
      'ACCION: revisar requisitos y preparar solicitud',
    ].join('\n'),
    contenido: [
      'Se convocan ayudas de la linea ICO-MAPA-SAECA por la perdida de rentabilidad derivada de la sequia.',
      'Podran ser beneficiarias las explotaciones inscritas en el Registro General de Explotaciones Ganaderas, explotaciones agrarias y cooperativas agrarias.',
      'El plazo de presentacion finalizara el 30 de septiembre de 2028.',
    ].join(' '),
  }), ganaderoAndaluz);

  assert.strictEqual(decision.action, 'include');
  assert.strictEqual(decision.incluir, true);
  assert.strictEqual(decision.diagnostico.policy.matches.sector, true);
  assert.strictEqual(decision.diagnostico.policy.matches.sector_expreso, true);
  assert.strictEqual(decision.diagnostico.policy.matches.tipo_expreso, true);
});

test('disolucion de Sociedad Agraria de Transformacion queda fuera como expediente individual', () => {
  const usuarioTarragona = {
    subscription: 'cooperativa',
    preferences: {
      provincias: ['Tarragona'],
      sectores: ['agricultura'],
      subsectores: [],
      tipos_alerta: {
        normativa_general: true,
      },
    },
  };

  const decision = decidirAlertaParaDigest(alerta(12565, {
    fuente: 'DOGC',
    titulo: 'Resolucion por la que se disuelve la Sociedad Agraria de Transformacion numero 8577 Llanos del Almendro',
    provincias: ['Tarragona'],
    sectores: ['agricultura'],
    subsectores: [],
    tipos_alerta: ['normativa_general'],
    resumen_final: [
      'FICHA_IA',
      'TIPO: normativa_general',
      'PRIORIDAD: baja',
      'RESUMEN_DIGEST: Se publica la disolucion de una Sociedad Agraria de Transformacion concreta.',
      'HECHO: disolucion de la SAT numero 8577',
      'ACCION: revisar solo si eres parte interesada en esa sociedad',
    ].join('\n'),
    contenido: [
      'Registro General de Sociedades Agrarias de Transformacion.',
      'Se disuelve la Sociedad Agraria de Transformacion numero 8577 Llanos del Almendro y se abre su proceso de liquidacion.',
    ].join(' '),
  }), usuarioTarragona);

  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.motivo, 'expediente_individual_sin_municipio');
  assert.strictEqual(decision.diagnostico.policy.signals.es_individual, true);
});

test('usuario con preferencias incompletas queda en revision, no envio automatico', () => {
  const decision = decidirAlertaParaDigest(alerta(105), {
    subscription: 'cooperativa',
    preferences: { provincias: [], sectores: [], subsectores: [], tipos_alerta: {} },
  }, {
    minReviewQualityScore: 70,
  });

  assert.strictEqual(decision.action, 'review_only');
  assert.strictEqual(decision.incluir, false);
  assert.strictEqual(decision.motivo, 'revision_riesgo_alto');
  assert(decision.diagnostico.policy.riesgo_de_ruido.reasons.some((reason) => reason.code === 'perfil_incompleto'));
});

// Ayuda que coincide con el perfil pero con contenido debil (score por debajo de 100).
// Con minIncludeScore=100 queda como review_only de revision segura (riesgo no alto).
function ayudaRevisionSegura(id, overrides = {}) {
  return {
    id,
    fuente: 'BOA',
    titulo: `Ayudas para agricultura en Teruel ${id}`,
    url: `https://example.com/${id}`,
    fecha: '2026-06-04',
    estado_ia: 'listo',
    resumen_final: [
      'FICHA_IA',
      'TIPO: ayudas_subvenciones',
      'PRIORIDAD: baja',
      'RESUMEN_DIGEST: Se publican ayudas para explotaciones agrarias.',
      'HECHO: ayudas para agricultura',
    ].join('\n'),
    contenido: 'Se publican ayudas para explotaciones agrarias de Teruel.',
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: [],
    tipos_alerta: ['ayudas_subvenciones'],
    embedding_generated_at: '2026-06-04T08:00:00Z',
    similitud: 0.0,
    ...overrides,
  };
}

const POLICY_FILL = { minIncludeScore: 100, minReviewScore: 50, minReviewQualityScore: 60, minItems: 1, targetItems: 2, maxItems: 2 };

test('con allowReview=true un review_only seguro entra como relleno tras los include', () => {
  const result = seleccionarAlertasParaDigest([ayudaRevisionSegura(300)], user, { ...POLICY_FILL, allowReview: true });
  assert.strictEqual(result.alertas.length, 1);
  assert.strictEqual(result.alertas[0].id, 300);
  assert.strictEqual(result.alertas[0].decision_digest.action, 'review_only');
  assert.strictEqual(result.alertas[0].decision_digest.motivo, 'relleno_revision_segura');
});

test('con allowReview=false ese mismo review_only queda fuera', () => {
  const result = seleccionarAlertasParaDigest([ayudaRevisionSegura(301)], user, { ...POLICY_FILL, allowReview: false });
  assert.strictEqual(result.alertas.length, 0);
});

test('un review_only de expediente individual no entra como relleno aunque allowReview=true', () => {
  const indiv = alerta(302, {
    titulo: 'Solicitud de concesion de aguas para riego en Teruel 302',
    contenido: 'Solicitud de concesion de aguas para riego agricola en Teruel con plazo de alegaciones.',
    tipos_alerta: ['agua_infraestructuras'],
  });
  const decision = decidirAlertaParaDigest(indiv, user, { ...POLICY_FILL, allowReview: true });
  assert.strictEqual(decision.action, 'review_only');
  assert.strictEqual(decision.review_safe_fill, false);

  const result = seleccionarAlertasParaDigest([indiv], user, { ...POLICY_FILL, allowReview: true });
  assert.strictEqual(result.alertas.length, 0);
});

test('un review_only generico no entra como relleno aunque allowReview=true', () => {
  const generico = alerta(303, {
    titulo: 'Publicacion oficial relevante',
    resumen_final: 'FICHA_IA\nRESUMEN_DIGEST: Publicacion oficial relevante, revisar si afecta.',
    contenido: 'Publicacion oficial relevante. Revisar si afecta.',
    tipos_alerta: ['normativa_general'],
  });
  const decision = decidirAlertaParaDigest(generico, user, { ...POLICY_FILL, allowReview: true });
  assert.strictEqual(decision.review_safe_fill, false);

  const result = seleccionarAlertasParaDigest([generico], user, { ...POLICY_FILL, allowReview: true });
  assert.strictEqual(result.alertas.length, 0);
});

test('un include siempre tiene prioridad sobre un review_only seguro', () => {
  const result = seleccionarAlertasParaDigest([ayudaRevisionSegura(304), alerta(305)], user, {
    ...POLICY_FILL,
    targetItems: 1,
    maxItems: 1,
    allowReview: true,
  });
  assert.strictEqual(result.alertas.length, 1);
  assert.strictEqual(result.alertas[0].id, 305);
  assert.strictEqual(result.alertas[0].decision_digest.action, 'include');
});

test('selecciona con diversidad y conserva minimo cuando hay candidatas', () => {
  const result = seleccionarAlertasParaDigest([
    alerta(10, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(11, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(12, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(13, { fuente: 'BOE', provincias: ['Teruel'], tipos_alerta: ['agua_infraestructuras'] }),
    alerta(14, { fuente: 'BOCYL', provincias: ['Zaragoza'], tipos_alerta: ['medio_ambiente'] }),
  ], user, {
    minItems: 3,
    targetItems: 4,
    maxItems: 4,
    maxPerFuente: 2,
    maxPerTipo: 2,
  });

  assert(result.alertas.length >= 3);
  assert(result.alertas.length <= 4);
  assert(new Set(result.alertas.map((item) => item.fuente)).size >= 2);
  assert(result.resumen.incluidas >= 3);
});

test('rellena con intereses fuertes aunque compartan fuente y tipo', () => {
  const result = seleccionarAlertasParaDigest([
    alerta(20, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(21, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(22, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(23, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
    alerta(24, { fuente: 'BOA', tipos_alerta: ['ayudas_subvenciones'] }),
  ], user, {
    minItems: 3,
    targetItems: 5,
    maxItems: 5,
    maxPerFuente: 2,
    maxPerTipo: 2,
    relaxedFillMinScore: 76,
  });

  assert.strictEqual(result.alertas.length, 5);
  assert.strictEqual(result.resumen.incluidas, 5);
});

test('expedientes individuales provinciales quedan en revision y no se autoenvian', () => {
  const result = seleccionarAlertasParaDigest([
    alerta(30, {
      titulo: 'Solicitud de concesion de aguas para riego en Teruel 30',
      contenido: 'Solicitud de concesion de aguas para riego agricola en Teruel con plazo de alegaciones.',
      tipos_alerta: ['agua_infraestructuras'],
    }),
    alerta(31, {
      titulo: 'Solicitud de concesion de aguas para riego en Teruel 31',
      contenido: 'Solicitud de concesion de aguas para riego agricola en Teruel con plazo de alegaciones.',
      tipos_alerta: ['agua_infraestructuras'],
    }),
    alerta(32, {
      titulo: 'Solicitud de concesion de aguas para riego en Teruel 32',
      contenido: 'Solicitud de concesion de aguas para riego agricola en Teruel con plazo de alegaciones.',
      tipos_alerta: ['agua_infraestructuras'],
    }),
  ], user, {
    minItems: 3,
    targetItems: 3,
    maxItems: 3,
    maxIndividualItems: 2,
  });

  assert.strictEqual(result.alertas.length, 0);
  assert.strictEqual(result.resumen.expediente_individual_requiere_revision, 3);
  assert(result.decisiones.every((decision) => decision.action === 'review_only'));
  assert(result.decisiones.every((decision) => decision.incluir === false));
});

console.log(`\nResultados alertSelectionEngine: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
