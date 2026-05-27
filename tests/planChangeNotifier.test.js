const {
  detectarDireccionCambioPlan,
  construirMensajeCambioPlan,
  construirResumenPlan,
  notificarCambioPlan,
} = require('../src/services/planChangeNotifier');

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

console.log('\n=== TESTS: plan change notifier ===\n');

(async () => {
  assert(detectarDireccionCambioPlan('corral', 'agricultor') === 'subida', 'Detecta subida de plan');
  assert(detectarDireccionCambioPlan('cooperativa', 'corral') === 'bajada', 'Detecta bajada de plan');
  assert(detectarDireccionCambioPlan('agricultor', 'agricultor') === 'sin_cambio', 'Detecta plan sin cambios');

  const mensajeSubida = construirMensajeCambioPlan({
    user: { first_name: 'Jaime', phone: '34600000000' },
    planAnterior: 'corral',
    planNuevo: 'agricultor',
  });
  assert(mensajeSubida.startsWith('Hola Jaime'), 'Personaliza saludo con nombre');
  assert(mensajeSubida.includes('*Corral* a *Agricultor*'), 'Explica plan anterior y nuevo');
  assert(mensajeSubida.includes('BOE y boletines autonomicos'), 'Resume nuevas fuentes del plan');

  const mensajeBajada = construirMensajeCambioPlan({
    user: { name: 'Cliente Ruralicos' },
    planAnterior: 'cooperativa',
    planNuevo: 'corral',
  });
  assert(mensajeBajada.includes('aplicara los limites'), 'En bajadas avisa de limites');
  assert(construirResumenPlan('cooperativa').includes('todas las fuentes'), 'Resume cooperativa como plan completo');

  const calls = [];
  const sent = await notificarCambioPlan({
    user: { phone: '34611111111', first_name: 'Ana' },
    planAnterior: 'corral',
    planNuevo: 'cooperativa',
    enviarWhatsAppDirecto: async (...args) => calls.push(args),
  });
  assert(sent.sent === true && sent.direction === 'subida', 'Envia notificacion con sender inyectado');
  assert(calls.length === 1 && calls[0][2] === 'plan_change', 'Usa message_type plan_change');

  const skippedSame = await notificarCambioPlan({
    user: { phone: '34611111111' },
    planAnterior: 'corral',
    planNuevo: 'corral',
    enviarWhatsAppDirecto: async () => calls.push(['unexpected']),
  });
  assert(skippedSame.skipped === true && skippedSame.reason === 'plan_unchanged', 'No envia si el plan no cambia');

  const skippedPhone = await notificarCambioPlan({
    user: {},
    planAnterior: 'corral',
    planNuevo: 'agricultor',
    enviarWhatsAppDirecto: async () => calls.push(['unexpected']),
  });
  assert(skippedPhone.skipped === true && skippedPhone.reason === 'missing_phone', 'No envia si falta telefono');

  const failedSend = await notificarCambioPlan({
    user: { phone: '34622222222' },
    planAnterior: 'agricultor',
    planNuevo: 'corral',
    enviarWhatsAppDirecto: async () => {
      throw new Error('UltraMsg KO');
    },
  });
  assert(failedSend.sent === false && failedSend.error === 'UltraMsg KO', 'No rompe el flujo si falla WhatsApp');

  console.log(`\nResultado: ${passed} OK, ${failed} FALLO(S)\n`);
  if (failed > 0) process.exit(1);
})();
