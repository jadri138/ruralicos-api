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
assert.deepStrictEqual(result.tipos_alerta, ['ayudas_subvenciones']);
assert(result.taxonomy_tags.includes('concepto:formacion'));
assert(result.taxonomy_tags.includes('concepto:pac'));
assert(result.taxonomy_tags.includes('subsector:frutal'));
assert(result.taxonomy_tags.includes('tipo:ayudas_subvenciones'));
assert.strictEqual(LEGACY_ALERT_TYPES.size, 6);
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

console.log('OK: registro taxonomico canonico mantiene interfaz legacy y tags enriquecidos');
