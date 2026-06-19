// Escenarios de negocio para el fact sheet evidence-first (contrato unico:
// construirFactSheet({ alerta, rawDocument, textoFuente })). Complementa a
// tests/factSheetValidator.test.js (que cubre el contrato/integridad de evidencia).
//
// Regla de oro comprobada en cada caso: nada se afirma sin evidencia textual del
// documento fuente (rawDocument/textoFuente). La alerta NO es fuente de evidencia.

const assert = require('assert');
const { construirFactSheet } = require('../src/modules/alertas/intelligence/factSheetBuilder');
const { validarFactSheet } = require('../src/modules/alertas/intelligence/factSheetValidator');
const {
  EVIDENCE_COVERAGE,
  FACT_SHEET_STATUS,
  NO_VERIFICADO,
} = require('../src/modules/alertas/intelligence/factSheetSchema');

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

console.log('\n=== TESTS: fact sheet — 8 escenarios de negocio ===\n');

// 1) Curso de bienestar animal etiquetado por la alerta como "agua/riego".
// Evidence-first: el tipo/tema salen del DOCUMENTO, no de la etiqueta de la alerta.
test('1. curso de bienestar animal: el tipo sale del documento, no del titulo erroneo de la alerta', () => {
  const sheet = construirFactSheet({
    alerta: { id: 1, titulo: 'Expediente de agua o riego', fuente: 'BOA' }, // etiqueta erronea
    textoFuente: 'Curso de formacion en bienestar animal dirigido a ganaderos del sector. '
      + 'Incluye modulos de manejo y sanidad animal.',
  });
  const v = validarFactSheet(sheet);

  assert.strictEqual(sheet.facts.tipo_documento.value, 'formacion', 'el documento es un curso, no un expediente de aguas');
  assert.notStrictEqual(sheet.facts.tema_principal.value, 'agua_riego', 'no debe heredar el tema erroneo agua/riego');
  assert.ok(sheet.facts.tipo_documento.evidence_refs.length > 0, 'el tipo debe ir respaldado por evidencia textual');
  assert.strictEqual(v.ok, true);
});

// 2) Ayuda/subvencion con plazo claro -> ficha completa, plazo con evidencia.
test('2. ayuda/subvención con plazo claro: válida y con evidencia de plazo', () => {
  const rawDocument = {
    id: 20,
    inserted_alerta_id: 2,
    fuente: 'BOJA',
    url: 'https://boja.example/2',
    titulo: 'Convocatoria de subvenciones para jovenes agricultores en Andalucia',
    texto_raw: 'Se aprueban las bases reguladoras de las ayudas. Los beneficiarios seran '
      + 'jovenes agricultores. El plazo de 20 dias habiles permite presentar solicitud. '
      + 'La dotacion asciende a 50000 euros.',
  };
  const sheet = construirFactSheet({ alerta: { id: 2 }, rawDocument });
  const v = validarFactSheet(sheet);

  assert.strictEqual(sheet.facts.tipo_documento.value, 'ayuda_subvencion');
  assert.ok(sheet.facts.plazo.value.includes('20 dias'));
  assert.ok(sheet.facts.plazo.evidence_refs.length > 0, 'el plazo debe llevar evidencia');
  assert.strictEqual(sheet.facts.territorio.value, 'Andalucia');
  assert.notStrictEqual(sheet.facts.beneficiarios.value, NO_VERIFICADO);
  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.READY);
  assert.strictEqual(v.ok, true);
});

// 3) Ayuda sin plazo -> el plazo NO se inventa (queda no_verificado, sin evidencia).
test('3. ayuda sin plazo claro: plazo no_verificado, no inventado', () => {
  const rawDocument = {
    id: 30,
    inserted_alerta_id: 3,
    fuente: 'DOE',
    url: 'https://doe.example/3',
    titulo: 'Convocatoria de ayudas a la agricultura ecologica en Extremadura',
    texto_raw: 'Se aprueban las bases reguladoras de las ayudas. Beneficiarios: agricultores.',
  };
  const sheet = construirFactSheet({ alerta: { id: 3 }, rawDocument });
  const v = validarFactSheet(sheet);

  assert.strictEqual(sheet.facts.plazo.value, NO_VERIFICADO, 'no debe inventar plazo');
  assert.deepStrictEqual(sheet.facts.plazo.evidence_refs, []);
  assert.ok(!v.codigos.includes('fact_without_evidence'), 'campo vacio no es un fallo de evidencia');
});

// 4) Concesion de aguas individual -> se detecta el rasgo de expediente individual.
test('4. concesión de aguas individual: detecta expediente individual y territorio', () => {
  const textoFuente = 'Resolucion por la que se otorga concesion de aguas a favor de D. Juan Perez, '
    + 'para riego del poligono 12 parcela 34, en la provincia de Huesca.';
  const sheet = construirFactSheet({ alerta: { id: 4 }, textoFuente });

  assert.strictEqual(sheet.facts.tipo_documento.value, 'concesion');
  assert.notStrictEqual(sheet.facts.expediente.value, NO_VERIFICADO, 'debe marcar rasgo de expediente individual');
  assert.ok(sheet.facts.expediente.evidence_refs.length > 0);
  assert.strictEqual(sheet.facts.territorio.value, 'Huesca');
});

// 5) Sancion individual -> tipo sancion + rasgo de expediente.
test('5. sanción individual: tipo sanción y rasgo de expediente', () => {
  const textoFuente = 'Resolucion del expediente sancionador por el que se impone una sancion a la '
    + 'empresa Ganadera X SL, con NIF B12345678, por incumplimiento de la normativa de sanidad animal.';
  const sheet = construirFactSheet({ alerta: { id: 5 }, textoFuente });

  assert.strictEqual(sheet.facts.tipo_documento.value, 'sancion');
  assert.notStrictEqual(sheet.facts.expediente.value, NO_VERIFICADO);
});

// 6) Alerta generica (sin documento fuente) -> no inventa nada, review_only.
test('6. alerta genérica sin fuente: review_only, sin evidencias inventadas', () => {
  const sheet = construirFactSheet({
    alerta: { id: 6, titulo: 'Anuncio', contenido: 'Se publica un anuncio oficial.', url: 'https://boe.example/6' },
  });
  const v = validarFactSheet(sheet);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.REVIEW_ONLY);
  assert.strictEqual(sheet.evidence_coverage, EVIDENCE_COVERAGE.BAJO);
  assert.strictEqual(sheet.evidence_score, 0);
  assert.strictEqual(sheet.evidences.length, 0, 'no se inventan evidencias desde la alerta');
  assert.strictEqual(sheet.facts.tipo_documento.value, NO_VERIFICADO);
  assert.strictEqual(v.ok, true);
});

// 7) Alerta sin URL -> la ficha se construye, pero la URL oficial queda null.
test('7. alerta sin URL: url_oficial null, evidencia textual igualmente registrada', () => {
  const rawDocument = {
    id: 70,
    inserted_alerta_id: 7,
    fuente: 'DOG',
    // sin url ni url_pdf
    titulo: 'Convocatoria de ayudas agrarias para agricultores en Galicia',
    texto_raw: 'Bases reguladoras de las ayudas. Beneficiarios: agricultores. El plazo de 15 dias habiles aplica.',
  };
  const sheet = construirFactSheet({ alerta: { id: 7 }, rawDocument });

  assert.strictEqual(sheet.source.urls.oficial, null, 'sin URL en rawDocument ni alerta');
  assert.strictEqual(sheet.facts.tipo_documento.value, 'ayuda_subvencion', 'la evidencia textual se sigue registrando');
});

// 8) Provincia no demostrada -> territorio no_verificado (no se hereda de alerta.region).
test('8. provincia no demostrada: territorio no_verificado (no hereda de region)', () => {
  const rawDocument = {
    id: 80,
    inserted_alerta_id: 8,
    fuente: 'BOPZ',
    url: 'https://bopz.example/8',
    titulo: 'Convocatoria de ayudas a la agricultura',
    texto_raw: 'Bases reguladoras de las ayudas para agricultores. El plazo de 15 dias habiles aplica.',
  };
  const sheet = construirFactSheet({
    alerta: { id: 8, region: 'Zaragoza' }, // region de la fuente, NO aparece en el texto
    rawDocument,
  });
  const v = validarFactSheet(sheet);

  assert.strictEqual(sheet.facts.territorio.value, NO_VERIFICADO, 'no debe heredar territorio de alerta.region');
  assert.ok(!v.codigos.includes('fact_without_evidence'));
});

console.log(`\nResultados fact sheet escenarios: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
