const {
  normalizarOrganizationId,
  extraerOrganizationId,
  conOrganizationId,
  alertaVisibleParaOrganization,
  filtrarAlertasPorOrganization,
  construirOrganizationContext,
  obtenerMiaBranding,
  aplicarOrganizationContextAUsuario,
} = require('../src/modules/mia/organizationContext');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

console.log('\n=== TESTS: mia organization context ===\n');

assert(normalizarOrganizationId('12') === 12, 'Normaliza organization_id numerico');
assert(normalizarOrganizationId('abc') === null, 'Rechaza organization_id invalido');
assert(extraerOrganizationId({ organization: { id: 7 } }) === 7, 'Extrae organization_id anidado');

const row = conOrganizationId({ user_id: 141 }, 12);
assert(row.organization_id === 12, 'Anade organization_id a filas nuevas');
assert(!('organization_id' in conOrganizationId({ user_id: 141 }, null)), 'No anade organization_id si no existe');

const alertas = [
  { id: 1, titulo: 'Global' },
  { id: 2, titulo: 'Privada coop 12', organization_id: 12 },
  { id: 3, titulo: 'Privada coop 99', organization_id: 99 },
];

assert(alertaVisibleParaOrganization(alertas[0], null) === true, 'Alerta global visible para Ruralicos');
assert(alertaVisibleParaOrganization(alertas[1], null) === false, 'Alerta privada no visible para usuario global');
assert(alertaVisibleParaOrganization(alertas[1], 12) === true, 'Alerta privada visible para su cooperativa');
assert(filtrarAlertasPorOrganization(alertas, 12).length === 2, 'Filtra globales y privadas propias');

const context = construirOrganizationContext({
  id: 12,
  name: 'Cooperativa Los Olivos',
  slug: 'los-olivos',
  branding_json: { brand_name: 'Los Olivos', assistant_name: 'MIA Olivos' },
});

assert(context.brand_name === 'Los Olivos', 'Construye branding de organizacion');
assert(context.assistant_name === 'MIA Olivos', 'Conserva nombre de asistente personalizado');
const branding = obtenerMiaBranding(context);
assert(branding.reply_sender === 'Ruralicos', 'Mantiene Ruralicos como remitente por defecto');
assert(branding.agent_label === 'un agente de Ruralicos', 'Construye etiqueta de agente por defecto');

const whiteLabel = obtenerMiaBranding(construirOrganizationContext({
  id: 14,
  name: 'Cooperativa Sierra',
  branding_json: {
    reply_sender: 'Cooperativa Sierra',
    agent_label: 'un tecnico de Cooperativa Sierra',
    website: 'coop-sierra.example',
  },
}));
assert(whiteLabel.reply_sender === 'Cooperativa Sierra', 'Permite remitente configurable');
assert(whiteLabel.agent_label.includes('tecnico'), 'Permite etiqueta de agente configurable');
assert(whiteLabel.website === 'coop-sierra.example', 'Permite web configurable');

const user = aplicarOrganizationContextAUsuario({ id: 141 }, context);
assert(user.organization_id === 12, 'Propaga organization_id al usuario operativo');
assert(user.mia_organization_context.brand_name === 'Los Olivos', 'Adjunta contexto de organizacion al usuario');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
