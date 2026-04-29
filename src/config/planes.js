// src/config/planes.js
//
// Configuración central de los planes de suscripción de Ruralicos.
// Este archivo es la fuente de verdad para límites, fuentes permitidas
// y capacidades de cada plan. Importarlo donde se necesite.
//
// Planes disponibles:
//   'free'        → Admin interno. Resumen genérico diario de todas las alertas.
//   'corral'      → Plan de entrada. 1 provincia, 1 sector, 2 subsectores. Solo BOE.
//   'agricultor'  → Plan medio. 2 provincias, 2 sectores, 4 subsectores. BOE + autonómicos.
//   'cooperativa' → Plan completo. Sin límites. Todas las fuentes. Campo libre + acceso anticipado.
//
// ══════════════════════════════════════════════════════════════════════

const PLANES = {

  free: {
    nombre: 'Free',
    digest: false,              // no recibe digest personalizado
    resumen_generico: true,     // recibe el resumen diario de alertasFree.js
    limites: {
      provincias: null,         // null = sin límite (no aplica para free)
      sectores:   null,
      subsectores: null,
    },
    fuentes_permitidas: null,   // null = todas (el free ve todo en el resumen genérico)
    campo_libre: false,
    acceso_anticipado: false,
  },

  corral: {
    nombre: 'Corral',
    digest: true,
    resumen_generico: false,
    limites: {
      provincias:  1,
      sectores:    1,
      subsectores: 2,
    },
    fuentes_permitidas: ['BOE'],
    campo_libre: false,
    acceso_anticipado: false,
  },

  agricultor: {
    nombre: 'Agricultor',
    digest: true,
    resumen_generico: false,
    limites: {
      provincias:  2,
      sectores:    2,
      subsectores: 4,
    },
    // BOE + todos los autonomicos disponibles y futuros
    fuentes_permitidas: null,
    campo_libre: true,
    acceso_anticipado: false,
  },

  cooperativa: {
    nombre: 'Cooperativa',
    digest: true,
    resumen_generico: false,
    limites: {
      provincias:  null,   // null = sin límite
      sectores:    null,
      subsectores: null,
    },
    fuentes_permitidas: null,   // null = todas, incluyendo futuras (lonjas, incendios...)
    campo_libre: true,
    acceso_anticipado: true,
  },

};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Devuelve la config del plan. Si el plan no existe devuelve 'corral' por defecto.
 */
function getPlan(subscription) {
  return PLANES[subscription] || PLANES['corral'];
}

/**
 * Comprueba si un plan tiene límite en un campo dado.
 * Devuelve el número máximo o null si es ilimitado.
 */
function getLimite(subscription, campo) {
  const plan = getPlan(subscription);
  return plan.limites[campo] ?? null;
}

/**
 * Comprueba si una fuente está permitida para un plan.
 * @param {string} subscription  - 'corral', 'agricultor', 'cooperativa', 'free'
 * @param {string} fuente        - 'BOE', 'BOA', 'BOJA', 'BOCYL', 'DOE', etc.
 */
function fuentePermitida(subscription, fuente) {
  const plan = getPlan(subscription);
  if (plan.fuentes_permitidas === null) return true;  // sin restricción
  return plan.fuentes_permitidas.includes(fuente?.toUpperCase());
}

/**
 * Valida las preferencias de un usuario contra los límites de su plan.
 * Devuelve { ok: true } o { ok: false, errores: [...] }
 *
 * @param {string} subscription
 * @param {object} preferences  - { provincias: [], sectores: [], subsectores: [], ... }
 */
function validarPreferencias(subscription, preferences) {
  const plan = getPlan(subscription);
  const errores = [];

  const campos = ['provincias', 'sectores', 'subsectores'];

  for (const campo of campos) {
    const limite = plan.limites[campo];
    if (limite === null) continue;  // sin límite → ok

    const valor = preferences[campo];
    if (Array.isArray(valor) && valor.length > limite) {
      errores.push(
        `El plan ${plan.nombre} permite máximo ${limite} ${campo} (enviaste ${valor.length})`
      );
    }
  }

  return errores.length === 0
    ? { ok: true }
    : { ok: false, errores };
}

/**
 * Trunca las preferencias al límite del plan (soft enforcement).
 * Útil si se quiere recortar automáticamente en lugar de rechazar.
 */
function truncarPreferencias(subscription, preferences) {
  const plan = getPlan(subscription);
  const resultado = { ...preferences };

  const campos = ['provincias', 'sectores', 'subsectores'];

  for (const campo of campos) {
    const limite = plan.limites[campo];
    if (limite === null) continue;
    if (Array.isArray(resultado[campo]) && resultado[campo].length > limite) {
      resultado[campo] = resultado[campo].slice(0, limite);
    }
  }

  return resultado;
}

module.exports = {
  PLANES,
  getPlan,
  getLimite,
  fuentePermitida,
  validarPreferencias,
  truncarPreferencias,
};