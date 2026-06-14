const { getPlan, PLANES } = require('../config/planes');

const PLAN_ORDER = {
  free: 0,
  corral: 1,
  agricultor: 2,
  cooperativa: 3,
};

function normalizarPlan(plan) {
  const key = String(plan || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLANES, key) ? key : null;
}

function nombrePlan(plan) {
  const key = normalizarPlan(plan);
  if (!key) return 'Sin plan';
  return getPlan(key).nombre || key;
}

function obtenerNombreUsuario(user = {}) {
  const raw =
    user.first_name ||
    user.name ||
    user.legal_name ||
    user.email ||
    '';
  const name = String(raw || '').trim().split(/\s+/)[0];
  return name ? name.slice(0, 60) : '';
}

function detectarDireccionCambioPlan(planAnterior, planNuevo) {
  const anterior = normalizarPlan(planAnterior);
  const nuevo = normalizarPlan(planNuevo);
  if (!anterior || !nuevo) return 'cambio';
  if (anterior === nuevo) return 'sin_cambio';
  if (PLAN_ORDER[nuevo] > PLAN_ORDER[anterior]) return 'subida';
  if (PLAN_ORDER[nuevo] < PLAN_ORDER[anterior]) return 'bajada';
  return 'cambio';
}

function describirFuentes(planKey) {
  const plan = getPlan(planKey);
  const fuentes = plan.fuentes_permitidas;

  if (fuentes === null) return 'todas las fuentes disponibles';
  if (Array.isArray(fuentes) && fuentes.length === 1 && fuentes[0] === 'BOE') {
    return 'BOE';
  }
  if (Array.isArray(fuentes) && fuentes.includes('BOE') && fuentes.length > 1) {
    return 'BOE y boletines autonomicos';
  }
  return 'fuentes del plan';
}

function describirLimites(planKey) {
  const plan = getPlan(planKey);
  const limites = plan.limites || {};
  const partes = [];

  if (limites.provincias !== null && limites.provincias !== undefined) {
    partes.push(`${limites.provincias} provincia${limites.provincias === 1 ? '' : 's'}`);
  }
  if (limites.sectores !== null && limites.sectores !== undefined) {
    partes.push(`${limites.sectores} sector${limites.sectores === 1 ? '' : 'es'}`);
  }
  if (limites.subsectores !== null && limites.subsectores !== undefined) {
    partes.push(`${limites.subsectores} subsector${limites.subsectores === 1 ? '' : 'es'}`);
  }

  return partes.length ? partes.join(', ') : 'sin limite de preferencias';
}

function construirResumenPlan(planKey) {
  const key = normalizarPlan(planKey) || 'corral';
  const plan = getPlan(key);
  const partes = [
    describirFuentes(key),
    describirLimites(key),
  ];

  if (plan.campo_libre) partes.push('campo libre activo');
  if (plan.acceso_anticipado) partes.push('acceso anticipado');
  if (key === 'free') partes.push('sin digest personalizado');

  return partes.join('; ');
}

function construirMensajeCambioPlan({ user = {}, planAnterior, planNuevo } = {}) {
  const anterior = normalizarPlan(planAnterior);
  const nuevo = normalizarPlan(planNuevo);
  const direccion = detectarDireccionCambioPlan(anterior, nuevo);

  if (!anterior || !nuevo || direccion === 'sin_cambio') return null;

  const nombre = obtenerNombreUsuario(user);
  const saludo = nombre ? `Hola ${nombre}` : 'Hola';
  const resumenNuevoPlan = construirResumenPlan(nuevo);
  const lineaContexto =
    direccion === 'bajada'
      ? `A partir de ahora MIA aplicara los limites del nuevo plan: ${resumenNuevoPlan}. Si alguna preferencia queda fuera, la ajustaremos al plan activo.`
      : `A partir de ahora MIA usara las condiciones del nuevo plan: ${resumenNuevoPlan}.`;

  return [
    saludo,
    '',
    `Tu plan de Ruralicos ha cambiado de *${nombrePlan(anterior)}* a *${nombrePlan(nuevo)}*.`,
    '',
    lineaContexto,
    '',
    'Puedes revisar tus preferencias desde el panel o responder a MIA si algo no encaja.',
  ].join('\n');
}

async function notificarCambioPlan({
  user = {},
  planAnterior,
  planNuevo,
  enviarWhatsAppDirecto,
} = {}) {
  const anterior = normalizarPlan(planAnterior);
  const nuevo = normalizarPlan(planNuevo);
  const direccion = detectarDireccionCambioPlan(planAnterior, planNuevo);
  const mensaje = construirMensajeCambioPlan({ user, planAnterior, planNuevo });

  if (!anterior || !nuevo) {
    return { sent: false, skipped: true, reason: 'invalid_plan', direction: direccion };
  }

  if (!mensaje || direccion === 'sin_cambio') {
    return { sent: false, skipped: true, reason: 'plan_unchanged', direction: direccion };
  }

  const phone = String(user.phone || '').trim();
  if (!phone) {
    return { sent: false, skipped: true, reason: 'missing_phone', direction: direccion };
  }

  try {
    const sender = enviarWhatsAppDirecto || require('../platform/whatsapp').enviarWhatsAppDirecto;
    await sender(phone, mensaje, 'plan_change');
    return { sent: true, skipped: false, direction: direccion };
  } catch (err) {
    console.error('[plan-change] Error enviando WhatsApp:', err.message);
    return {
      sent: false,
      skipped: false,
      direction: direccion,
      error: err.message,
    };
  }
}

module.exports = {
  PLAN_ORDER,
  normalizarPlan,
  nombrePlan,
  detectarDireccionCambioPlan,
  construirResumenPlan,
  construirMensajeCambioPlan,
  notificarCambioPlan,
};
