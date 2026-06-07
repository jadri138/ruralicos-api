const assert = require('assert');
const {
  aliasesTemaFeedback,
  buscarSugerenciasTaxonomia,
  extraerFeatureTagsDeTexto,
  temaCanonicoTaxonomia,
} = require('../src/brain/taxonomiaRuralicos');

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

console.log('\n=== TESTS: taxonomia ruralicos ===\n');

test('mantiene canónicos aprendibles actuales', () => {
  assert.strictEqual(temaCanonicoTaxonomia('olivos'), 'olivar');
  assert.strictEqual(temaCanonicoTaxonomia('cerdos'), 'porcino');
  assert.strictEqual(temaCanonicoTaxonomia('tractores'), 'maquinaria agricola');
  assert.strictEqual(temaCanonicoTaxonomia('subvenciones'), 'ayuda');
});

test('extrae features existentes y nuevos desde la misma taxonomía', () => {
  const features = extraerFeatureTagsDeTexto(
    'Convocatoria de ayudas PAC para jovenes agricultores de ovino con maquinaria agricola y plazo de solicitud.'
  );

  assert(features.includes('concepto:ayuda_directa'));
  assert(features.includes('concepto:pac'));
  assert(features.includes('concepto:plazo'));
  assert(features.includes('accion:solicitar'));
  assert(features.includes('concepto:incorporacion_joven'));
  assert(features.includes('concepto:maquinaria_agricola'));
  assert(features.includes('subsector:ovino'));
});

test('expone aliases por tema de feedback', () => {
  const aliases = aliasesTemaFeedback('maquinaria agricola');
  assert(aliases.includes('tractor'));
  assert(aliases.includes('tractores'));
  assert(aliases.includes('modernizacion'));
});

test('genera sugerencias útiles para registro', () => {
  const sugerencias = buscarSugerenciasTaxonomia('ove');
  assert(sugerencias.some((item) => item.id === 'subsector:ovino'));
  assert(sugerencias.some((item) => item.feedback_canonico === 'ovino'));
});

console.log(`\nResultados taxonomiaRuralicos: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
