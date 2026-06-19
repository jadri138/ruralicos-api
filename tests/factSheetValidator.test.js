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

console.log('\n=== TESTS: evidence-first fact sheet ===\n');

const alertaBase = {
  id: 42,
  raw_document_id: 999,
  titulo: 'Titulo normalizado de alerta',
  contenido: 'Este contenido de alertas no debe usarse como evidencia si no se pasa rawDocument ni textoFuente.',
  url: 'https://alerta.example/42',
  fecha: '2026-06-18',
  fuente: 'DOCM',
};

const rawDocumentCompleto = {
  id: 7,
  inserted_alerta_id: 42,
  fuente: 'DOCM',
  fecha: '2026-06-18',
  titulo: 'Convocatoria de ayudas para explotaciones agrarias de Castilla-La Mancha',
  url: 'https://docm.example/doc/42',
  url_pdf: 'https://docm.example/doc/42.pdf',
  texto_raw: [
    'Resolucion por la que se convocan subvenciones para explotaciones agrarias de Castilla-La Mancha.',
    'Los beneficiarios seran agricultores y titulares de explotaciones agrarias.',
    'El plazo de 20 dias habiles permite presentar solicitud.',
    'La dotacion asciende a 100000 euros.',
    'Entre los requisitos figura estar al corriente de las obligaciones tributarias.',
  ].join(' '),
};

test('con rawDocument usa la relacion inversa y no alertas.raw_document_id', () => {
  const sheet = construirFactSheet({ alerta: alertaBase, rawDocument: rawDocumentCompleto });
  const validation = validarFactSheet(sheet);

  assert.strictEqual(sheet.source.raw_document_id, 7);
  assert.strictEqual(sheet.source.inserted_alerta_id, 42);
  assert.strictEqual(sheet.source.uses_alerta_raw_document_id, false);
  assert(sheet.warnings.some((warning) => warning.code === 'alerta_raw_document_id_ignored'));
  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.READY);
  assert.strictEqual(sheet.evidence_coverage, EVIDENCE_COVERAGE.ALTO);
  assert.strictEqual(sheet.facts.tipo_documento.value, 'ayuda_subvencion');
  assert.strictEqual(sheet.facts.territorio.value, 'Castilla-La Mancha');
  assert(sheet.facts.plazo.value.includes('20 dias'));
  assert(sheet.facts.importe.value.includes('100000 euros'));
  assert.strictEqual(validation.ok, true);
});

test('con textoFuente construye ficha con evidencias textuales', () => {
  const textoFuente = [
    'Anuncio de informacion publica en Teruel sobre concesion de aguas para riego.',
    'Las personas interesadas podran presentar alegaciones.',
    'El plazo de 30 dias naturales empieza tras la publicacion.',
  ].join(' ');

  const sheet = construirFactSheet({
    alerta: { id: 50, titulo: 'No debe ser fuente principal' },
    textoFuente,
  });
  const validation = validarFactSheet(sheet);

  assert.strictEqual(sheet.source.has_texto_fuente, true);
  assert.strictEqual(sheet.source.has_raw_document, false);
  assert.strictEqual(sheet.facts.tipo_documento.value, 'concesion');
  assert.strictEqual(sheet.facts.tema_principal.value, 'agua_riego');
  assert.strictEqual(sheet.facts.territorio.value, 'Teruel');
  assert.strictEqual(sheet.facts.accion_requerida.value, 'presentar_alegaciones');
  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.READY);
  assert.strictEqual(validation.ok, true);
});

test('sin rawDocument ni textoFuente no extrae desde alerta y queda review_only', () => {
  const sheet = construirFactSheet({
    alerta: {
      id: 60,
      titulo: 'Convocatoria de ayudas PAC en Huesca',
      contenido: 'Plazo de 15 dias habiles para presentar solicitud.',
      url: 'https://example.com/alerta/60',
    },
  });
  const validation = validarFactSheet(sheet);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.REVIEW_ONLY);
  assert.strictEqual(sheet.evidence_coverage, EVIDENCE_COVERAGE.BAJO);
  assert.strictEqual(sheet.evidence_score, 0);
  assert.strictEqual(sheet.evidences.length, 0);
  assert.strictEqual(sheet.facts.tipo_documento.value, NO_VERIFICADO);
  assert.strictEqual(sheet.facts.territorio.value, NO_VERIFICADO);
  assert(sheet.warnings.some((warning) => warning.code === 'sin_evidencia_textual'));
  assert.strictEqual(validation.ok, true);
});

test('validador rechaza datos con valor pero sin evidencia textual', () => {
  const sheet = construirFactSheet({ alerta: alertaBase, rawDocument: rawDocumentCompleto });
  sheet.facts.territorio = { value: 'Huesca', evidence_refs: [] };

  const validation = validarFactSheet(sheet);

  assert.strictEqual(validation.ok, false);
  assert(validation.codigos.includes('fact_without_evidence'));
});

test('validador rechaza rawDocument que no apunta a la alerta recibida', () => {
  const sheet = construirFactSheet({
    alerta: { id: 42 },
    rawDocument: { ...rawDocumentCompleto, inserted_alerta_id: 99 },
  });
  const validation = validarFactSheet(sheet);

  assert.strictEqual(sheet.status, FACT_SHEET_STATUS.REVIEW_ONLY);
  assert.strictEqual(sheet.source.relation_verified, false);
  assert.strictEqual(validation.ok, false);
  assert(validation.codigos.includes('raw_document_alerta_mismatch'));
});

test('campos sin evidencia permanecen como no_verificado o lista vacia', () => {
  const sheet = construirFactSheet({
    alerta: { id: 70 },
    textoFuente: 'Resolucion sobre normativa agraria en Zaragoza.',
  });

  assert.strictEqual(sheet.facts.importe.value, NO_VERIFICADO);
  assert.deepStrictEqual(sheet.facts.requisitos.value, []);
  assert.deepStrictEqual(sheet.facts.importe.evidence_refs, []);
  assert.deepStrictEqual(sheet.facts.requisitos.evidence_refs, []);
});

console.log(`\nResultados factSheetValidator: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
