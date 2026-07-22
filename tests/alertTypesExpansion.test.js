process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  CLASSIFICATION_ALERT_TYPES,
  CLASIFICACION_TEXT_FORMAT,
  FICHA_IA_TEXT_FORMAT,
  buildPromptClasificar,
  clasificarLocalmente,
  normalizarResultadoClasificacion,
} = require('../src/modules/alertas/alertas.service');

const firstPriorityTypes = [
  'sanidad_animal',
  'sanidad_vegetal',
  'incendios_emergencias',
  'obligaciones',
  'restricciones',
  'forestal',
  'formacion',
  'registros_certificaciones',
  'plazos_alegaciones',
];

const classifierEnum = CLASIFICACION_TEXT_FORMAT
  .schema.properties.resultados.items.properties.tipos_alerta.items.enum;
const factSheetEnum = FICHA_IA_TEXT_FORMAT
  .schema.properties.resultados.items.properties.tipo.enum;
const prompt = buildPromptClasificar('ID=1 | Titulo=prueba');

for (const type of firstPriorityTypes) {
  assert(CLASSIFICATION_ALERT_TYPES.includes(type), `${type}: registro del clasificador`);
  assert(classifierEnum.includes(type), `${type}: esquema JSON de clasificacion`);
  assert(factSheetEnum.includes(type), `${type}: esquema JSON de ficha`);
  assert(prompt.includes(type), `${type}: prompt de clasificacion`);
}

const cases = [
  ['sanidad_animal', 'Medidas de sanidad animal y bioseguridad para explotaciones ganaderas.'],
  ['sanidad_vegetal', 'Medidas de sanidad vegetal y control fitosanitario para explotaciones agricolas.'],
  ['incendios_emergencias', 'Emergencia por incendio forestal que afecta a explotaciones agrarias.'],
  ['obligaciones', 'Los titulares de explotaciones agrarias deberan declarar una nueva obligacion.'],
  ['restricciones', 'Restriccion de movimientos para explotaciones ganaderas por riesgo sanitario.'],
  ['forestal', 'Plan de gestion forestal y ordenacion de montes del medio rural.'],
  ['formacion', 'Curso de formacion agraria para agricultores y titulares de explotaciones.'],
  ['registros_certificaciones', 'Inscripcion en el registro de explotaciones agrarias para sus titulares.'],
  ['plazos_alegaciones', 'Plazo de alegaciones para un proyecto de regadio que afecta a explotaciones agrarias.'],
];

for (const [type, contenido] of cases) {
  const classification = clasificarLocalmente({ id: type, titulo: contenido, contenido });
  assert.strictEqual(classification.es_relevante, true, type);
  assert(classification.tipos_alerta.includes(type), `${type}: fallback local`);
}

const alert = { id: 77, titulo: 'Norma agraria', contenido: 'Norma para explotaciones agrarias.' };
const normalized = normalizarResultadoClasificacion({
  id: '77',
  es_relevante: true,
  provincias: [],
  sectores: ['agricultura'],
  subsectores: [],
  tipos_alerta: firstPriorityTypes,
}, new Map([['77', alert]]));
assert.deepStrictEqual(normalized.tipos_alerta, firstPriorityTypes);

console.log('OK: los nueve tipos P1.5 atraviesan esquema, prompt, normalizacion y fallback local');
