process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  construirClasificacionTratamientoEspecial,
  detectarDescarteEstructuradoFueraAlcance,
  detectarTratamientoEspecialAlerta,
} = require('../src/shared/alertScopeRules');
const {
  crearPrefiltroRural,
} = require('../src/modules/boletines/scrapers/shared/ruralFilter');
const {
  preclassifyAlerta,
} = require('../src/modules/alertas/clasificacion/alertPreclassifier');
const {
  clasificarLocalmente,
} = require('../src/modules/alertas/alertas.service');
const {
  diagnosticarAlertaUsuario,
} = require('../src/modules/alertas/seleccion/alertaMatcher');
const {
  evaluarAlertaParaDigest,
} = require('../src/modules/alertas/seleccion/alertSelectionEngine');
const {
  clasificarPrioridadAlerta,
} = require('../src/modules/aprendizaje/alertPriority');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(error.stack || error.message);
  }
}

const alertaHiguera = {
  id: 9101,
  titulo: 'Convenio para la conservacion de variedades de higuera',
  contenido: 'Convenio de investigacion sobre recursos fitogeneticos, material vegetal y variedades de Ficus carica destinado a obtentores y viveros.',
  resumen_final: 'FICHA_IA\nTIPO: normativa_general\nPRIORIDAD: baja\nHECHO: convenio de conservacion de variedades de higuera\nIMPACTO: interes para obtentores, viveros e investigadores\nACCION: solo informativo\nRESUMEN_DIGEST: Convenio tecnico para conservar variedades de higuera.',
  url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-9101',
  fuente: 'BOE',
  region: 'Nacional',
  fecha: '2026-07-21',
  estado_ia: 'listo',
  provincias: [],
  sectores: ['agricultura'],
  subsectores: ['frutales'],
  tipos_alerta: ['normativa_general'],
  embedding_generated_at: '2026-07-21T10:00:00.000Z',
};

const alertaHolaluz = {
  id: 9102,
  titulo: 'Condiciones de Holaluz para titulares de contratos de suministro',
  contenido: 'La medida solo resulta aplicable a clientes de la comercializadora Holaluz que sean titulares del contrato de suministro.',
  resumen_final: 'FICHA_IA\nTIPO: normativa_general\nPRIORIDAD: baja\nHECHO: condiciones de una comercializadora\nIMPACTO: solo para clientes de Holaluz\nACCION: solo informativo\nRESUMEN_DIGEST: Condiciones aplicables unicamente a clientes de Holaluz.',
  url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-9102',
  fuente: 'BOE',
  region: 'Nacional',
  fecha: '2026-07-21',
  estado_ia: 'listo',
  provincias: [],
  sectores: ['otros'],
  subsectores: ['energia'],
  tipos_alerta: ['normativa_general'],
  embedding_generated_at: '2026-07-21T10:00:00.000Z',
};

const descartesAuditados = [
  {
    id: 9103,
    title: 'CEXVET',
    text: 'Resolucion por la que se inscribe la asociacion CEXVET en el Registro de Asociaciones.',
    code: 'association_registration_without_user_action',
  },
  {
    id: 9104,
    title: 'Belenismo',
    text: 'Bases del certamen cultural de belenismo y exposicion de belenes navidenos.',
    code: 'cultural_content_out_of_scope',
  },
  {
    id: 9105,
    title: 'Subvencion deportiva',
    text: 'Convocatoria de subvenciones exclusivamente para clubes deportivos y deportistas del municipio.',
    code: 'sports_grant_out_of_scope',
  },
];

const perfilAgricultorGeneral = {
  subscription: 'cooperativa',
  preferencias_extra: 'Gestiono una explotacion de cereal.',
  preferences: {
    provincias: [],
    sectores: ['agricultura'],
    subsectores: ['frutales'],
    tipos_alerta: { normativa_general: true },
  },
};

const perfilEspecialista = {
  ...perfilAgricultorGeneral,
  preferencias_extra: 'Soy obtentor y gestiono un vivero especializado en material vegetal y variedades de higuera.',
};

test('convenio de higuera se conserva como contenido especialista de prioridad baja', () => {
  const handling = detectarTratamientoEspecialAlerta(alertaHiguera);
  const classification = construirClasificacionTratamientoEspecial(alertaHiguera);
  assert.strictEqual(handling.decision, 'keep_specialist');
  assert.strictEqual(handling.audience, 'variety_breeders_nurseries_researchers');
  assert.strictEqual(handling.automatic_general_send, false);
  assert.strictEqual(classification.es_relevante, true);
  assert.deepStrictEqual(classification.sectores, ['agricultura']);
  assert.strictEqual(clasificarPrioridadAlerta(alertaHiguera).prioridad, 'baja');
});

test('convenio de higuera no se abre al agricultor general y si al perfil especialista', () => {
  const general = diagnosticarAlertaUsuario(alertaHiguera, perfilAgricultorGeneral);
  const specialist = diagnosticarAlertaUsuario(alertaHiguera, perfilEspecialista);
  assert.strictEqual(general.ok, false);
  assert.strictEqual(general.motivo, 'specialist_plant_variety_profile_required');
  assert.strictEqual(specialist.ok, true);
});

test('Holaluz se almacena clasificada pero queda fuera del envio automatico', () => {
  const handling = detectarTratamientoEspecialAlerta(alertaHolaluz);
  const classification = clasificarLocalmente(alertaHolaluz);
  const match = diagnosticarAlertaUsuario(alertaHolaluz, perfilAgricultorGeneral);
  const selection = evaluarAlertaParaDigest(alertaHolaluz, perfilAgricultorGeneral, { qualityGate: false });
  assert.strictEqual(handling.decision, 'store_not_send');
  assert.strictEqual(classification.es_relevante, true);
  assert.strictEqual(match.ok, false);
  assert.strictEqual(match.motivo, 'commercializer_customer_condition_not_verified');
  assert.strictEqual(selection.action, 'exclude');
  assert.strictEqual(selection.motivo, 'commercializer_customer_condition_not_verified');
});

for (const fixture of descartesAuditados) {
  test(`${fixture.title} conserva el reason_code exacto en todas las barreras locales`, () => {
    const alerta = { id: fixture.id, titulo: fixture.text, contenido: fixture.text };
    const scope = detectarDescarteEstructuradoFueraAlcance(alerta);
    const route = crearPrefiltroRural()(fixture.text);
    const preclassification = preclassifyAlerta(alerta);
    const classification = clasificarLocalmente(alerta);

    assert.strictEqual(scope.reasonCode, fixture.code);
    assert.strictEqual(route.action, 'discard');
    assert.strictEqual(route.reasonCode, fixture.code);
    assert.strictEqual(preclassification.pre_status, 'discard');
    assert(preclassification.pre_reasons.some((reason) => reason.tag === fixture.code));
    assert.strictEqual(classification.es_relevante, false);
    assert.strictEqual(classification.discard_reason_code, fixture.code);
    assert(classification.discard_reason);
  });
}

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
