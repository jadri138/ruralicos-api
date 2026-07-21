process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { normalizarClasificacionCanonica } = require('../src/shared/taxonomyRegistry');
const {
  diagnosticarAlertaUsuario,
} = require('../src/modules/alertas/seleccion/alertaMatcher');
const {
  seleccionarAlertasParaDigest,
} = require('../src/modules/alertas/seleccion/alertSelectionEngine');
const {
  filtrarAlertasEnviablesAutomaticamente,
  filtrarAlertasPorCalidadDigest,
} = require('../src/modules/digest/digest.service');

const alertaBase = {
  id: 15110,
  fuente: 'BOE',
  provincias: ['nacional'],
  region: 'Nacional',
  fecha: '2026-07-18',
  created_at: '2026-07-18T08:00:00.000Z',
  estado_ia: 'listo',
  titulo: 'Indicadores nacionales de consumo de antibióticos veterinarios',
  url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-15110',
  contenido: [
    'Se publican los indicadores nacionales de consumo de antibióticos veterinarios de 2026.',
    'Los indicadores se aplican a las explotaciones ganaderas y a sus especies de interés ganadero.',
    'Producen efectos tres meses después de su publicación.',
  ].join(' '),
  resumen_final: [
    'FICHA_IA',
    'TIPO: sanidad_animal',
    'PRIORIDAD: alta',
    'RESUMEN_DIGEST: Se publican los indicadores nacionales de 2026 con los que se compara el consumo de antibióticos de cada tipo de explotación ganadera.',
    'HECHO: indicadores nacionales de consumo de antibióticos veterinarios',
    'PLAZO: producen efectos tres meses después de su publicación',
    'ACCION: consultar PRESVET y revisar los indicadores con el veterinario de la explotación',
  ].join('\n'),
  embedding_generated_at: '2026-07-18T09:00:00.000Z',
};

const salidaIaContaminada = {
  id: alertaBase.id,
  es_relevante: true,
  provincias: ['nacional'],
  sectores: ['ganaderia', 'agricultura', 'mixto'],
  subsectores: [
    'porcino', 'vacuno', 'ovino', 'caprino', 'avicultura', 'cunicultura',
    'equinocultura', 'frutales', 'vinedo', 'olivar', 'trigo', 'hortalizas',
    'almendro', 'patata', 'agua',
  ],
  tipos_alerta: ['sanidad_animal', 'normativa_general', 'fiscalidad'],
};

function user({ sectores = [], subsectores = [], tipos = {} } = {}) {
  return {
    subscription: 'cooperativa',
    preferences: {
      provincias: [],
      sectores,
      subsectores,
      tipos_alerta: tipos,
    },
  };
}

const perfiles = {
  ganadero_porcino: user({ sectores: ['ganaderia'], subsectores: ['porcino'], tipos: { sanidad_animal: true } }),
  ganadero_ovino: user({ sectores: ['ganaderia'], subsectores: ['ovino'], tipos: { sanidad_animal: true } }),
  ganadero_avicola: user({ sectores: ['ganaderia'], subsectores: ['avicultura'], tipos: { sanidad_animal: true } }),
  agricultor_cereal: user({ sectores: ['agricultura'], subsectores: ['trigo'], tipos: { normativa_general: true } }),
  viticultor: user({ sectores: ['agricultura'], subsectores: ['vinedo'], tipos: { normativa_general: true } }),
  olivarero: user({ sectores: ['agricultura'], subsectores: ['olivar'], tipos: { normativa_general: true } }),
  mixto: user({ sectores: ['mixto'], subsectores: ['ovino', 'trigo'], tipos: { sanidad_animal: true } }),
  sin_sector: user(),
};

const debenRecibir = new Set(['ganadero_porcino', 'ganadero_ovino', 'ganadero_avicola', 'mixto']);
const normalizada = normalizarClasificacionCanonica(alertaBase, salidaIaContaminada);
const alerta = { ...alertaBase, ...normalizada };

assert.deepStrictEqual(alerta.sectores, ['ganaderia']);
assert.deepStrictEqual(alerta.subsectores, [
  'porcino', 'vacuno', 'ovino', 'caprino', 'avicultura', 'cunicultura', 'equinocultura',
]);
assert.deepStrictEqual(alerta.tipos_alerta, ['sanidad_animal', 'normativa_general']);
for (const prohibited of ['trigo', 'vinedo', 'olivar', 'frutales', 'hortalizas', 'fiscalidad']) {
  assert(![...alerta.subsectores, ...alerta.tipos_alerta].includes(prohibited), `etiqueta prohibida: ${prohibited}`);
}

const quality = filtrarAlertasPorCalidadDigest([alerta]);
assert.strictEqual(quality.aceptadas.length, 1, JSON.stringify(quality.rechazadas));

for (const [name, profile] of Object.entries(perfiles)) {
  const matcher = diagnosticarAlertaUsuario(alerta, profile);
  const shouldReceive = debenRecibir.has(name);
  assert.strictEqual(matcher.ok, shouldReceive, `${name}: matcher ${matcher.motivo}`);

  const selection = seleccionarAlertasParaDigest(quality.aceptadas, profile);
  const annotated = selection.alertas[0] || null;
  const final = filtrarAlertasEnviablesAutomaticamente(annotated ? [annotated] : []);

  assert.strictEqual(Boolean(annotated), shouldReceive, `${name}: selection ${JSON.stringify(selection.decisiones)}`);
  assert.strictEqual(final.enviables.length === 1, shouldReceive, `${name}: final digest`);
  if (annotated) {
    assert.strictEqual(annotated.decision_digest.action, 'include', `${name}: decision_digest`);
  }
}

console.log('OK: regresion E2E de antibioticos cubre clasificacion, taxonomia, calidad, matcher, seleccion y digest final');
