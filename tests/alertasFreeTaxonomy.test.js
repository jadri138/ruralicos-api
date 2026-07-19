process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  alertaTieneTaxonomiaMinima,
  buscarAlertaConResumenFreeValido,
} = require('../src/modules/alertas/alertasFree.routes');

assert.strictEqual(alertaTieneTaxonomiaMinima({
  sectores: [],
  subsectores: [],
  tipos_alerta: [],
  taxonomy_tags: [],
}), false);

assert.strictEqual(alertaTieneTaxonomiaMinima({
  sectores: [],
  subsectores: ['ovino'],
  tipos_alerta: ['sanidad_animal'],
}), false);

assert.strictEqual(alertaTieneTaxonomiaMinima({
  sectores: [],
  subsectores: [],
  tipos_alerta: ['normativa_general'],
  taxonomy_tags: ['sector:ganaderia'],
}), true);

const clasificada = {
  id: 1,
  resumenfree: 'Resumen compartido',
  sectores: ['ganaderia'],
  subsectores: [],
  tipos_alerta: ['normativa_general'],
};
const sinTaxonomia = {
  id: 2,
  resumenfree: 'Resumen compartido',
  sectores: [],
  subsectores: [],
  tipos_alerta: [],
};

assert.strictEqual(buscarAlertaConResumenFreeValido([clasificada]), clasificada);
assert.strictEqual(
  buscarAlertaConResumenFreeValido([clasificada, sinTaxonomia]),
  null,
  'un resumen histórico mixto tampoco puede enviarse'
);

console.log('OK: el resumen FREE solo usa alertas con sector derivado');
