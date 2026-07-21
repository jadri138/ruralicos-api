const assert = require('assert');
const {
  LEGACY_ALERT_TYPES,
  aliasesCanonicos,
  normalizarClasificacionCanonica,
} = require('../src/shared/taxonomyRegistry');

const alerta = {
  titulo: 'Curso sobre ayudas PAC para frutales',
  contenido: 'Formacion para agricultores con explotaciones de frutales y ayudas PAC.',
};
const result = normalizarClasificacionCanonica(alerta, {
  sectores: ['agrícola'],
  subsectores: ['frutal'],
  tipos_alerta: ['ayuda', 'formacion'],
});

assert.deepStrictEqual(result.sectores, ['agricultura']);
assert(result.subsectores.includes('frutales'));
assert.deepStrictEqual(result.tipos_alerta, ['ayudas_subvenciones', 'formacion']);
assert(result.taxonomy_tags.includes('concepto:formacion'));
assert(result.taxonomy_tags.includes('concepto:pac'));
assert(result.taxonomy_tags.includes('subsector:frutal'));
assert(result.taxonomy_tags.includes('tipo:ayudas_subvenciones'));
assert.strictEqual(LEGACY_ALERT_TYPES.size, 14);
assert(aliasesCanonicos('subsector', 'frutales').includes('frutales'));

const bioseguridad = normalizarClasificacionCanonica({
  titulo: 'Medidas obligatorias de bioseguridad ganadera',
  contenido: 'Las explotaciones ganaderas deberan aplicar limpieza y desinfeccion de vehiculos.',
}, {
  sectores: ['ganaderia'],
  subsectores: ['bioseguridad'],
  tipos_alerta: ['sanidad animal'],
});

assert(bioseguridad.tipos_alerta.includes('sanidad_animal'));
assert(bioseguridad.taxonomy_tags.includes('tipo:sanidad_animal'));
assert(bioseguridad.taxonomy_tags.includes('concepto:sanidad_animal'));
assert(bioseguridad.taxonomy_tags.includes('concepto:bioseguridad'));

const antibioticos = normalizarClasificacionCanonica({
  titulo: 'Indicadores nacionales de consumo de antibióticos veterinarios',
  contenido: 'Se publican los indicadores aplicables a las explotaciones ganaderas y sus especies de interés ganadero.',
}, {
  sectores: ['ganaderia', 'agricultura', 'mixto'],
  subsectores: [
    'porcino', 'vacuno', 'ovino', 'caprino', 'avicultura', 'cunicultura',
    'equinocultura', 'frutales', 'vinedo', 'olivar', 'trigo', 'hortalizas',
    'almendro', 'patata', 'agua',
  ],
  tipos_alerta: ['sanidad_animal', 'normativa_general', 'fiscalidad'],
});

assert.deepStrictEqual(antibioticos.sectores, ['ganaderia']);
assert.deepStrictEqual(antibioticos.subsectores, [
  'porcino', 'vacuno', 'ovino', 'caprino', 'avicultura', 'cunicultura', 'equinocultura',
]);
assert.deepStrictEqual(antibioticos.tipos_alerta, ['sanidad_animal', 'normativa_general']);
assert.strictEqual(antibioticos.taxonomy_validation.status, 'repaired');
assert(antibioticos.taxonomy_validation.topic_validation.repairs.length >= 3);
assert(!antibioticos.taxonomy_tags.includes('subsector:olivar'));
assert(!antibioticos.taxonomy_tags.includes('tipo:fiscalidad'));

const fiscalGanadero = normalizarClasificacionCanonica({
  titulo: 'Deducción fiscal en el IRPF para explotaciones ganaderas',
  contenido: 'Se regula una deducción fiscal del IRPF aplicable a titulares de explotaciones ganaderas.',
}, {
  sectores: ['ganaderia'],
  subsectores: ['vacuno'],
  tipos_alerta: ['sanidad_animal', 'fiscalidad'],
});
assert(fiscalGanadero.tipos_alerta.includes('fiscalidad'), 'fiscalidad con evidencia expresa debe conservarse');

const nuevosTipos = normalizarClasificacionCanonica({
  titulo: 'Medidas forestales ante incendios y plazo de alegaciones',
  contenido: 'Se establecen restricciones forestales, obligaciones y un plazo de alegaciones.',
}, {
  sectores: ['agricultura'],
  tipos_alerta: [
    'forestal', 'incendios_emergencias', 'obligaciones', 'restricciones',
    'plazos_alegaciones', 'registros_certificaciones', 'formacion', 'sanidad_vegetal',
  ],
});
assert.deepStrictEqual(nuevosTipos.tipos_alerta, [
  'forestal', 'incendios_emergencias', 'obligaciones', 'restricciones',
  'plazos_alegaciones', 'registros_certificaciones', 'formacion', 'sanidad_vegetal',
]);

console.log('OK: registro taxonomico canonico mantiene interfaz legacy y tags enriquecidos');
