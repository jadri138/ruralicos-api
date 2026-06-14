const assert = require('assert');
const {
  aliasesTemaFeedback,
  buscarSugerenciasTaxonomia,
  construirPreferenciasDesdeTexto,
  extraerFeatureTagsDeTexto,
  extraerTaxonomiaDeTexto,
  temaCanonicoTaxonomia,
  validarTaxonomiaRuralicos,
} = require('../src/modules/aprendizaje/taxonomiaRuralicos');

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
  const sugerencias = buscarSugerenciasTaxonomia('ove', { includeAliases: true });
  assert(sugerencias.some((item) => item.id === 'subsector:ovino'));
  assert(sugerencias.some((item) => item.feedback_canonico === 'ovino'));
  assert(sugerencias.every((item) => Number(item.score) > 0));
});

test('valida consistencia interna de la taxonomía', () => {
  const validacion = validarTaxonomiaRuralicos();
  assert.strictEqual(validacion.ok, true);
  assert(validacion.total >= 50);
  assert(validacion.feedback_topics >= 30);
});

test('convierte texto libre de registro en preferencias estructuradas', () => {
  const resultado = construirPreferenciasDesdeTexto(
    'Me interesa cereal, PAC, maquinaria, jovenes agricultores, regadio y ayudas con plazo'
  );

  assert.strictEqual(resultado.ok, true);
  assert(resultado.confidence >= 0.7);
  assert(resultado.preferencias.sectores.includes('agricultura'));
  assert(resultado.preferencias.subsectores.includes('cereal'));
  assert(resultado.preferencias.tipos_alerta.ayudas_subvenciones);
  assert(resultado.preferencias.tipos_alerta.plazos);
  assert(resultado.conceptos.includes('pac'));
  assert(resultado.conceptos.includes('maquinaria_agricola'));
  assert(resultado.conceptos.includes('incorporacion_joven'));
});

test('devuelve preferencias canonicas listas para guardar', () => {
  const resultado = construirPreferenciasDesdeTexto(
    'Tengo frutales, medio ambiente y quiero avisos de normativa con plazos'
  );

  assert(resultado.preferencias.sectores.includes('agricultura'));
  assert(resultado.preferencias.subsectores.includes('frutales'));
  assert(resultado.preferencias.subsectores.includes('medio_ambiente'));
  assert(resultado.preferencias.tipos_alerta.normativa_general);
  assert(resultado.preferencias.tipos_alerta.plazos);
});

test('detecta exclusiones sin mezclarlas con intereses', () => {
  const resultado = extraerTaxonomiaDeTexto('Quiero olivar y PAC, pero no quiero cursos ni licitaciones');

  assert(resultado.intereses.includes('olivar'));
  assert(resultado.intereses.includes('pac'));
  assert(!resultado.intereses.includes('formacion'));
  assert(resultado.exclusiones.tags.includes('concepto:formacion'));
  assert(resultado.exclusiones.tags.includes('tramite:licitacion'));
  assert(resultado.exclusiones.temas.includes('formacion'));
  assert(resultado.exclusiones.temas.includes('licitacion'));
});

test('separa negaciones largas con matices posteriores', () => {
  const resultado = extraerTaxonomiaDeTexto(
    'No quiero cursos ni licitaciones, aunque si me interesan jornadas tecnicas de olivar si son subvencionadas.'
  );

  assert(resultado.exclusiones.tags.includes('concepto:formacion'));
  assert(resultado.exclusiones.tags.includes('tramite:licitacion'));
  assert(resultado.intereses.includes('formacion'));
  assert(resultado.intereses.includes('olivar'));
  assert(resultado.conflictos.some((item) => item.id === 'concepto:formacion'));
});

test('evita falsos positivos rurales frecuentes', () => {
  const texto = 'contrato de obras del ayuntamiento. ley general. pago de tasas. curso fluvial. vino de honor.';
  const resultado = extraerTaxonomiaDeTexto(texto);
  const features = extraerFeatureTagsDeTexto(texto);

  assert(!resultado.matches.some((match) => match.id === 'tramite:licitacion'));
  assert(!resultado.matches.some((match) => match.id === 'concepto:infraestructura'));
  assert(!resultado.matches.some((match) => match.id === 'concepto:normativa'));
  assert(!resultado.matches.some((match) => match.id === 'concepto:ayuda_directa'));
  assert(!resultado.matches.some((match) => match.id === 'concepto:formacion'));
  assert(!resultado.matches.some((match) => match.id === 'subsector:vinedo'));
  assert(!features.includes('tramite:licitacion'));
  assert(!features.includes('concepto:normativa'));
  assert(!features.includes('concepto:ayuda_directa'));
  assert(!features.includes('concepto:formacion'));
  assert(!features.includes('subsector:vinedo'));
});

console.log(`\nResultados taxonomiaRuralicos: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
