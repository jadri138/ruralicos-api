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

test('reconoce el vocabulario ampliado de sectores y morfologia', () => {
  const agro = construirPreferenciasDesdeTexto('Soy agricultor y tambien tengo ganado, me interesan ayudas');
  assert(agro.preferencias.sectores.includes('agricultura'));
  assert(agro.preferencias.sectores.includes('ganaderia'));

  const features = extraerFeatureTagsDeTexto(
    'Instalacion fotovoltaica de autoconsumo, gestion de purines y dano por pedrisco en el almendro'
  );
  assert(features.includes('concepto:energia'));
  assert(features.includes('concepto:purines_estiercoles'));
  assert(features.includes('concepto:dano_climatico'));
  assert(features.includes('subsector:almendro'));
});

test('reconoce familias agrarias de alto valor para clasificacion', () => {
  const texto = [
    'Alta REGA y ROMA con modificacion de explotacion ganadera.',
    'Plan de bioseguridad con limpieza y desinfeccion de vehiculos.',
    'Ayuda para DOP e IGP, cadena alimentaria y transformacion agroalimentaria.',
    'Cuenta justificativa, recurso de alzada y venta directa en mercados de productores.',
  ].join(' ');

  const resultado = construirPreferenciasDesdeTexto(texto);
  const features = extraerFeatureTagsDeTexto(texto);

  assert(features.includes('concepto:registro_explotaciones'));
  assert(features.includes('concepto:bioseguridad'));
  assert(features.includes('concepto:calidad_diferenciada'));
  assert(features.includes('concepto:agroindustria'));
  assert(features.includes('concepto:comercializacion'));
  assert(features.includes('accion:justificar'));
  assert(features.includes('accion:recurrir'));
  assert(resultado.preferencias.sectores.includes('agricultura'));
  assert(resultado.preferencias.sectores.includes('ganaderia'));
  assert(resultado.preferencias.subsectores.includes('registro_explotaciones'));
  assert(resultado.preferencias.subsectores.includes('bioseguridad'));
  assert(resultado.preferencias.subsectores.includes('calidad_diferenciada'));
  assert(resultado.preferencias.subsectores.includes('agroindustria'));
  assert(resultado.preferencias.subsectores.includes('comercializacion'));
  assert(resultado.preferencias.tipos_alerta.normativa_general);
  assert(resultado.preferencias.tipos_alerta.sanidad_animal);
});

test('detecta subsectores nuevos y los deja en forma canonica', () => {
  const equino = extraerTaxonomiaDeTexto('Tengo caballos y yeguas en mi explotacion equina');
  assert(equino.matches.some((m) => m.id === 'subsector:equino'));

  const industriales = construirPreferenciasDesdeTexto('Me interesa el girasol y la colza');
  assert(industriales.preferencias.subsectores.includes('cultivos_industriales'));

  const secos = construirPreferenciasDesdeTexto('Cultivo nueces y pistachos');
  assert(secos.preferencias.subsectores.includes('frutos_secos'));

  const flor = construirPreferenciasDesdeTexto('Tengo un vivero de plantas ornamentales');
  assert(flor.preferencias.subsectores.includes('floricultura'));

  const forrajes = construirPreferenciasDesdeTexto('Tengo praderas de alfalfa para heno y ensilado');
  assert(forrajes.preferencias.subsectores.includes('forrajes'));
});

test('amplia vocabulario sin romper exclusiones existentes', () => {
  const resultado = extraerTaxonomiaDeTexto(
    'contrato de obras del ayuntamiento. ley general. pago de tasas. curso fluvial. vino de honor.'
  );
  assert(!resultado.matches.some((m) => m.id === 'tramite:licitacion'));
  assert(!resultado.matches.some((m) => m.id === 'concepto:normativa'));
  assert(!resultado.matches.some((m) => m.id === 'concepto:ayuda_directa'));
  assert(!resultado.matches.some((m) => m.id === 'subsector:vinedo'));
});

test('evita falsos positivos en nuevas familias taxonomicas', () => {
  const texto = [
    'registro civil y registro de la propiedad.',
    'industria cultural del municipio.',
    'contrato laboral y contratos del sector publico.',
    'recursos humanos del ayuntamiento.',
    'cuarentena preventiva por salud publica en residencia municipal.',
    'limpieza y desinfeccion de edificios publicos.',
    'control de vectores en instalaciones municipales.',
  ].join(' ');
  const resultado = extraerTaxonomiaDeTexto(texto);
  const features = extraerFeatureTagsDeTexto(texto);

  assert(!resultado.matches.some((m) => m.id === 'concepto:registro_explotaciones'));
  assert(!resultado.matches.some((m) => m.id === 'concepto:bioseguridad'));
  assert(!resultado.matches.some((m) => m.id === 'concepto:agroindustria'));
  assert(!resultado.matches.some((m) => m.id === 'concepto:comercializacion'));
  assert(!resultado.matches.some((m) => m.id === 'accion:recurrir'));
  assert(!features.includes('concepto:registro_explotaciones'));
  assert(!features.includes('concepto:bioseguridad'));
  assert(!features.includes('concepto:agroindustria'));
  assert(!features.includes('concepto:comercializacion'));
  assert(!features.includes('accion:recurrir'));
});

test('bioseguridad generica exige contexto ganadero', () => {
  const features = extraerFeatureTagsDeTexto(
    'Las explotaciones ganaderas deberan aplicar limpieza y desinfeccion de vehiculos y control de vectores.'
  );

  assert(features.includes('concepto:bioseguridad'));
});

console.log(`\nResultados taxonomiaRuralicos: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
