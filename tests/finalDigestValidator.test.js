const assert = require('assert');
const {
  FINAL_DIGEST_VALIDATOR_VERSION,
  extraerBloquesItemsMensaje,
  validarDigestFinal,
  validarItemDigestFinal,
} = require('../src/modules/digest/finalDigestValidator');

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

function field(valor, evidencia = valor) {
  return {
    valor,
    evidencia,
    source: 'test',
    confidence: 0.95,
    status: valor && evidencia ? 'verified' : 'no_verificado',
  };
}

function sheet(overrides = {}) {
  return {
    alerta_id: 100,
    status: 'ready_for_digest',
    tipo_documento: field('convocatoria de ayudas'),
    tema_principal: field('ayudas para maquinaria agricola'),
    resumen_neutro: field('Se convocan ayudas para maquinaria agricola.'),
    territorio: [field('Huesca')],
    sectores: [field('Agricultura')],
    subsectores: [field('maquinaria agricola')],
    accion_requerida: field('presentar solicitud'),
    plazo: field('hasta el 30 de junio de 2026'),
    beneficiarios: field('explotaciones agrarias'),
    importe: field('hasta 10.000 euros'),
    requisitos: [field('estar inscrito en el registro de explotaciones')],
    url_oficial: field('https://boletin.example/100'),
    truth_score: 96,
    risk_score: 8,
    evidence_coverage: 0.92,
    flags: [],
    reasons: [],
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    action: 'include',
    incluir: true,
    riesgo: 'bajo',
    score: 88,
    diagnostico: {
      policy: {
        matches: {
          provincia_expresa: true,
          sector_expreso: true,
          tipo_expreso: true,
        },
      },
    },
    ...overrides,
  };
}

const alerta = {
  id: 100,
  titulo: 'Ayudas para maquinaria agricola',
  provincias: ['Huesca'],
  sectores: ['Agricultura'],
  tipos_alerta: ['ayudas_subvenciones'],
  decision_digest: decision(),
};

console.log('\n=== TESTS: final digest validator ===\n');

test('declara version estable', () => {
  assert.strictEqual(FINAL_DIGEST_VALIDATOR_VERSION, 'final_digest_validator_v1');
});

test('extrae bloques numerados de un mensaje con cabeceras', () => {
  const bloques = extraerBloquesItemsMensaje([
    'Hola',
    '*Ayudas*',
    '*1. URGENTE - Ayuda maquinaria*',
    'En sencillo: Se convocan ayudas.',
    'https://boletin.example/100',
    '',
    '*Normativa*',
    '*2. NORMAL - Otra alerta*',
    'En sencillo: Cambia una norma.',
  ].join('\n'));

  assert.strictEqual(bloques.length, 2);
  assert.strictEqual(bloques[0].item_numero, 1);
  assert(bloques[0].texto.includes('Ayuda maquinaria'));
  assert.strictEqual(bloques[1].item_numero, 2);
});

test('permite envio cuando mensaje, fact sheet y seleccion estan alineados', () => {
  const result = validarItemDigestFinal({
    alerta,
    factSheet: sheet(),
    decisionDigest: decision(),
    texto: [
      '*1. URGENTE - Ayuda maquinaria agricola*',
      'En sencillo: Se convocan ayudas para explotaciones agrarias de Huesca.',
      'Que revisar: plazo hasta el 30 de junio de 2026 e importe de hasta 10.000 euros.',
      'https://boletin.example/100',
    ].join('\n'),
  });

  assert.strictEqual(result.status, 'send');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.flags, []);
});

test('bloquea plazo mencionado sin plazo verificado', () => {
  const result = validarItemDigestFinal({
    alerta,
    factSheet: sheet({ plazo: field(null, null) }),
    decisionDigest: decision(),
    texto: [
      '*1. URGENTE - Ayuda maquinaria agricola*',
      'En sencillo: Se convocan ayudas para explotaciones agrarias de Huesca.',
      'Que revisar: plazo hasta el 30 de junio de 2026.',
      'https://boletin.example/100',
    ].join('\n'),
  });

  assert.strictEqual(result.status, 'blocked');
  assert(result.flags.includes('deadline_claim_without_evidence'));
});

test('bloquea importe mencionado sin importe verificado', () => {
  const result = validarItemDigestFinal({
    alerta,
    factSheet: sheet({ importe: field(null, null) }),
    decisionDigest: decision(),
    texto: [
      '*1. URGENTE - Ayuda maquinaria agricola*',
      'En sencillo: Hay ayuda de 10.000 euros para maquinaria en Huesca.',
      'https://boletin.example/100',
    ].join('\n'),
  });

  assert.strictEqual(result.status, 'blocked');
  assert(result.flags.includes('amount_claim_without_evidence'));
});

test('bloquea territorio afirmado sin evidencia territorial', () => {
  const result = validarItemDigestFinal({
    alerta,
    factSheet: sheet({ territorio: [] }),
    decisionDigest: decision(),
    texto: [
      '*1. NORMAL - Ayuda maquinaria agricola*',
      'En sencillo: Se convocan ayudas para explotaciones agrarias de Huesca.',
      'https://boletin.example/100',
    ].join('\n'),
  });

  assert.strictEqual(result.status, 'blocked');
  assert(result.flags.includes('territory_claim_without_evidence'));
});

test('no bloquea provincias concretas en alertas de ambito nacional', () => {
  const result = validarItemDigestFinal({
    alerta: {
      ...alerta,
      provincias: ['nacional'],
      tipos_alerta: ['pac'],
    },
    factSheet: sheet({ territorio: [field('nacional')] }),
    decisionDigest: decision(),
    texto: [
      '*1. NORMAL - PAC 2026*',
      'En sencillo: Nuevas condiciones de la PAC para explotaciones agrarias.',
      'Aplica en todo el territorio, tambien en Huesca, Teruel y Zaragoza.',
      'https://boletin.example/100',
    ].join('\n'),
  });

  assert(!result.flags.includes('territory_claim_without_evidence'));
});

test('bloquea afectacion directa sin match fuerte', () => {
  const result = validarItemDigestFinal({
    alerta,
    factSheet: sheet(),
    decisionDigest: decision({
      score: 68,
      riesgo: 'medio',
      diagnostico: { policy: { matches: { provincia_expresa: true } } },
    }),
    texto: [
      '*1. NORMAL - Ayuda maquinaria agricola*',
      'En sencillo: Te afecta directamente si tienes una explotacion en Huesca.',
      'https://boletin.example/100',
    ].join('\n'),
  });

  assert.strictEqual(result.status, 'blocked');
  assert(result.flags.includes('direct_impact_without_strong_match'));
});

test('deja en revision decisiones review_only', () => {
  const result = validarItemDigestFinal({
    alerta,
    factSheet: sheet(),
    decisionDigest: decision({ action: 'review_only', incluir: false }),
    texto: [
      '*1. PARA REVISAR - Ayuda maquinaria agricola*',
      'En sencillo: Puede interesarte si trabajas maquinaria agricola en Huesca.',
      'https://boletin.example/100',
    ].join('\n'),
  });

  assert.strictEqual(result.status, 'review_only');
  assert(result.flags.includes('selection_review_only'));
});

test('bloquea fact sheet blocked aunque el texto parezca correcto', () => {
  const result = validarItemDigestFinal({
    alerta,
    factSheet: sheet({ status: 'blocked' }),
    decisionDigest: decision(),
    texto: [
      '*1. NORMAL - Ayuda maquinaria agricola*',
      'En sencillo: Se convocan ayudas para explotaciones agrarias de Huesca.',
      'https://boletin.example/100',
    ].join('\n'),
  });

  assert.strictEqual(result.status, 'blocked');
  assert(result.flags.includes('fact_sheet_blocked'));
});

test('deja en revision ayudas sin convocatoria ni beneficiarios suficientes', () => {
  const result = validarItemDigestFinal({
    alerta,
    factSheet: sheet({
      tipo_documento: field('resolucion'),
      tema_principal: field('maquinaria agricola'),
      resumen_neutro: field('Publicacion sobre maquinaria agricola.'),
      beneficiarios: field(null, null),
    }),
    decisionDigest: decision(),
    texto: [
      '*1. NORMAL - Ayuda maquinaria agricola*',
      'En sencillo: Es una ayuda para maquinaria agricola en Huesca.',
      'https://boletin.example/100',
    ].join('\n'),
  });

  assert.strictEqual(result.status, 'review_only');
  assert(result.flags.includes('aid_claim_weak_evidence'));
});

test('agrega estado global del digest completo', () => {
  const mensaje = [
    'Hola',
    '*Ayudas*',
    '*1. URGENTE - Ayuda maquinaria agricola*',
    'En sencillo: Se convocan ayudas para explotaciones agrarias de Huesca.',
    'Que revisar: plazo hasta el 30 de junio de 2026.',
    'https://boletin.example/100',
    '',
    '*2. NORMAL - Otra ayuda*',
    'En sencillo: Publicacion oficial relevante para revisar si afecta.',
    'https://boletin.example/200',
  ].join('\n');
  const result = validarDigestFinal({
    mensaje,
    alertas: [
      alerta,
      {
        ...alerta,
        id: 200,
        titulo: 'Otra ayuda',
        decision_digest: decision({ action: 'review_only', incluir: false }),
      },
    ],
    factSheets: {
      100: sheet(),
      200: sheet({ alerta_id: 200 }),
    },
  });

  assert.strictEqual(result.status, 'review_only');
  assert.strictEqual(result.item_results.length, 2);
  assert(result.flags.includes('selection_review_only'));
  assert(result.flags.includes('generic_digest_phrase'));
});

console.log(`\nResultados finalDigestValidator: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
