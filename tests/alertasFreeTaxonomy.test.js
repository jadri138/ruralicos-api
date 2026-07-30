process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  alertaTieneTaxonomiaMinima,
  buscarAlertaConResumenFreeValido,
  construirResumenFreeLocal,
  evaluarCandidataResumenFree,
  seleccionarAlertasResumenFree,
  validarResumenFreeIA,
  __testing,
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
  estado_ia: 'listo',
  resumenfree: null,
  titulo: 'Ayudas para explotaciones ganaderas',
  resumen: 'Se abre el plazo para solicitar ayudas destinadas a explotaciones ganaderas.',
  url: 'https://boe.es/alerta-1',
  fuente: 'BOE',
  sectores: ['ganaderia'],
  subsectores: [],
  tipos_alerta: ['normativa_general'],
};
clasificada.resumenfree = construirResumenFreeLocal([clasificada]);
const sinTaxonomia = {
  id: 2,
  estado_ia: 'listo',
  resumenfree: clasificada.resumenfree,
  titulo: clasificada.titulo,
  resumen: clasificada.resumen,
  url: 'https://boe.es/alerta-2',
  fuente: 'BOE',
  sectores: [],
  subsectores: [],
  tipos_alerta: [],
};

assert.strictEqual(buscarAlertaConResumenFreeValido([clasificada]), clasificada);
assert.strictEqual(
  buscarAlertaConResumenFreeValido([{ ...clasificada, estado_ia: 'descartado' }]),
  null,
  'un descarte estructurado no puede entrar en el resumen FREE'
);
assert.strictEqual(
  buscarAlertaConResumenFreeValido([clasificada, sinTaxonomia]),
  null,
  'un resumen histórico mixto tampoco puede enviarse'
);

const ayuda = {
  ...clasificada,
  id: 3,
  resumenfree: null,
  fuente: 'BOA',
  url: 'https://boa.aragon.es/ayuda',
  titulo: 'Convocatoria de subvenciones para regadío',
  resumen: 'Las comunidades de regantes pueden solicitar la ayuda hasta el 30 de septiembre.',
  sectores: ['agricultura'],
};
const nombramiento = {
  ...ayuda,
  id: 4,
  url: 'https://bop.example/nombramiento',
  titulo: 'Nombramiento de personal',
  resumen: 'Resolución del nombramiento de una plaza en la plantilla de personal.',
};
const fueraSector = {
  ...ayuda,
  id: 5,
  url: 'https://boe.es/industria',
  titulo: 'Ayudas para industria audiovisual',
  resumen: 'Se abre el plazo de solicitudes.',
  sectores: ['otros'],
  taxonomy_tags: [],
};

assert.strictEqual(evaluarCandidataResumenFree(ayuda).elegible, true);
assert.strictEqual(evaluarCandidataResumenFree(nombramiento).elegible, false);
assert.strictEqual(evaluarCandidataResumenFree(fueraSector).elegible, false);
assert.deepStrictEqual(
  seleccionarAlertasResumenFree([nombramiento, ayuda, { ...ayuda, id: 6 }]).map((alerta) => alerta.id),
  [3],
  'deduplica la misma URL y excluye ruido administrativo'
);

const resumenLocal = construirResumenFreeLocal([ayuda]);
assert(resumenLocal.startsWith(__testing.FREE_HEADER));
assert(resumenLocal.includes('→ BOA: https://boa.aragon.es/ayuda'));
assert(resumenLocal.endsWith(__testing.FREE_FOOTER));
assert.strictEqual(validarResumenFreeIA(resumenLocal, [ayuda]).ok, true);
assert.strictEqual(
  validarResumenFreeIA(
    resumenLocal.replace('https://boa.aragon.es/ayuda', 'https://inventada.example/alerta'),
    [ayuda]
  ).ok,
  false,
  'la IA no puede introducir enlaces ajenos a la selección'
);
assert.strictEqual(
  validarResumenFreeIA(resumenLocal.replace('→ BOA:', '→ BOE:'), [ayuda]).ok,
  false,
  'cada enlace conserva la fuente oficial real'
);

assert.strictEqual(
  buscarAlertaConResumenFreeValido([
    { ...ayuda, resumenfree: 'Resumen antiguo y ruidoso' },
    { ...nombramiento, resumenfree: 'Resumen antiguo y ruidoso' },
  ]),
  null,
  'un resumen antiguo ligado a una alerta de ruido queda bloqueado'
);

console.log('OK: FREE selecciona avisos rurales accionables, limita ruido y valida la salida');
