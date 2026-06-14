// src/modules/usuarios/usuarios.context.js
//
// Contexto compartido de las rutas de usuarios: limiters, middlewares de
// autorizacion y helpers de datos que dependen de supabase. Se construye una vez
// por arranque con crearContextoUsuarios(supabase) y lo consumen las sub-rutas.

const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { checkCronToken, hasCronToken } = require('../../middleware/cronToken');
const { normalizePhone, isPhoneValid, LONGITUD_TELEFONO } = require('../../shared/phoneNormalizer');
const { enviarWhatsAppVerificacion, enviarWhatsAppRegistro, enviarWhatsAppResetPassword } = require('../../platform/whatsapp');
const { requireAuth, requireAdmin } = require('../../middleware/requireAdmin');
const { getPlan, validarPreferencias, truncarPreferencias } = require('../../config/planes');
const { extraerPreferenciasBody, prepararPreferenciasExtra } = require('../../shared/preferenciasRequest');
const { normalizarPreferenciasUsuario } = require('../../shared/preferenceCanonical');
const { actualizarPerfilUsuarioMIASafe } = require('../aprendizaje/miaProfile');
const { notificarCambioPlan } = require('../../services/planChangeNotifier');

const USER_OWNED_TABLES = [
  'mia_actions',
  'mia_outbox',
  'mia_agent_cases',
  'mia_structured_memory',
  'mia_alert_reviews',
  'digest_attempts',
  'digest_items',
  'alerta_click_links',
  'alerta_clicks',
  'alerta_feedback',
  'official_list_matches',
  'exploration_log',
  'user_interest_profile',
  'user_memory',
  'user_conversations',
  'mia_decisions',
  'mia_inbound_messages',
  'webhook_events',
  'organization_members',
  'preferences',
  'alertas_vistas',
  'digests',
];

function isSupabaseAuthUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || '').trim());
}

function crearContextoUsuarios(supabase) {
  const accountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Prueba de nuevo en unos minutos.' },
  });

  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados registros desde esta conexion. Prueba mas tarde.' },
  });

  function getPlanKey(subscription) {
    const key = String(subscription || 'corral').trim().toLowerCase();
    return ['corral', 'agricultor', 'cooperativa'].includes(key) ? key : 'corral';
  }

  function getMemoryCapabilities(subscription) {
    const plan = getPlanKey(subscription);

    return {
      plan,
      learning_active: plan === 'agricultor' || plan === 'cooperativa',
      detail_access: plan === 'cooperativa',
      manage_access: plan === 'cooperativa',
    };
  }

  function limpiarCampoNombre(value, max = 80) {
    const cleaned = String(value || '').trim().replace(/\s+/g, ' ');
    return cleaned ? cleaned.slice(0, max) : null;
  }

  function construirNombreLegal({ firstName, lastName1, lastName2, fallbackName }) {
    const partes = [firstName, lastName1, lastName2]
      .map((value) => limpiarCampoNombre(value))
      .filter(Boolean);
    if (partes.length === 3) return partes.join(' ');
    return limpiarCampoNombre(fallbackName, 180);
  }

  function summarizeMemory(memories = []) {
    return memories.reduce((acc, memory) => {
      acc[memory.tipo] = (acc[memory.tipo] || 0) + 1;
      return acc;
    }, {});
  }

  function isMissingTableError(error) {
    return error && ['42P01', '42703', 'PGRST205'].includes(error.code);
  }

  async function resetMiaProfile(userId) {
    const { error } = await supabase
      .from('users')
      .update({
        perfil_embedding: null,
        perfil_version: 0,
        perfil_actualizado_at: null,
        contexto_narrativo: null,
      })
      .eq('id', userId);

    if (error) {
      console.warn(`[memoria] No se pudo reiniciar perfil MIA user ${userId}:`, error.message);
    }
  }

  async function deleteUserRows(table, userId) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('user_id', userId);

    if (error && !isMissingTableError(error)) throw error;
  }

  async function deleteUserOwnedRows(userId) {
    const cleaned = [];
    for (const table of USER_OWNED_TABLES) {
      await deleteUserRows(table, userId);
      cleaned.push(table);
    }
    return cleaned;
  }

  async function deleteSupabaseAuthUserIfPossible(userId) {
    if (!isSupabaseAuthUuid(userId)) {
      return { attempted: false, reason: 'non_uuid_custom_user_id' };
    }

    try {
      const { error } = await supabase.auth.admin.deleteUser(userId);
      if (error) {
        console.warn('[users:delete] No se pudo borrar usuario de Supabase Auth:', error.message);
        return { attempted: true, ok: false, error: error.message };
      }
      return { attempted: true, ok: true };
    } catch (err) {
      console.warn('[users:delete] Error borrando usuario de Supabase Auth:', err.message);
      return { attempted: true, ok: false, error: err.message };
    }
  }

  async function selectUserRows(table, columns, userId, options = {}) {
    let query = supabase
      .from(table)
      .select(columns)
      .eq('user_id', userId);

    if (options.order) {
      query = query.order(options.order, { ascending: false });
    }

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;
    if (error && isMissingTableError(error)) return [];
    if (error) throw error;
    return data || [];
  }

  function requireAdminOrCron(req, res, next) {
    if ((process.env.REQUIRE_ADMIN_FOR_USER_ADMIN_ROUTES || 'true').toLowerCase() !== 'true') {
      return next();
    }
    if (hasCronToken(req)) {
      return next();
    }
    return requireAdmin(req, res, next);
  }

  function requireOwnerPhoneOrAdminOrCron(req, res, next) {
    if (hasCronToken(req)) {
      return next();
    }

    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      return requireAuth(req, res, () => {
        const phoneNormalizado = normalizePhone(req.body?.phone || req.query?.phone);
        if (req.user?.role === 'admin' || String(req.user?.phone || '') === phoneNormalizado) {
          return next();
        }
        return res.status(403).json({ error: 'No tienes permisos para este telefono' });
      });
    }

    return requireAdmin(req, res, next);
  }

  async function cambiarPlanUsuarioPorTelefono(phoneRaw, planRaw) {
    const phone = normalizePhone(phoneRaw);
    const plan = String(planRaw || '').trim().toLowerCase();
    const PLANES_VALIDOS = ['free', 'corral', 'agricultor', 'cooperativa'];

    if (!phone) {
      return { ok: false, status: 400, error: 'Falta el numero de telefono' };
    }

    if (!PLANES_VALIDOS.includes(plan)) {
      return {
        ok: false,
        status: 400,
        error: `Plan invalido. Opciones: ${PLANES_VALIDOS.join(', ')}`,
      };
    }

    const { data: userActual, error: userError } = await supabase
      .from('users')
      .select('id, phone, name, first_name, legal_name, email, subscription')
      .eq('phone', phone)
      .single();

    if (userError || !userActual) {
      if (userError) console.error('Error leyendo usuario antes de cambiar plan:', userError.message);
      return { ok: false, status: 404, error: 'Usuario no encontrado' };
    }

    const { data, error } = await supabase
      .from('users')
      .update({ subscription: plan })
      .eq('id', userActual.id)
      .select('id, phone, name, first_name, legal_name, email, subscription')
      .single();

    if (error || !data) {
      if (error) console.error('Error cambiando plan:', error.message);
      return { ok: false, status: 500, error: 'Error cambiando plan' };
    }

    const notification = await notificarCambioPlan({
      user: data,
      planAnterior: userActual.subscription,
      planNuevo: data.subscription,
    });

    return {
      ok: true,
      phone,
      user: data,
      notification,
      previous_subscription: userActual.subscription,
    };
  }

  function generarCodigoVerificacion() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  function nuevaCaducidadVerificacion() {
    return new Date(Date.now() + 15 * 60 * 1000).toISOString();
  }

  function codigoVerificacionCaducado(fechaCaducidad) {
    if (!fechaCaducidad) return true;
    return new Date(fechaCaducidad) < new Date();
  }

  // Ruta de prueba

  return {
    accountLimiter,
    registerLimiter,
    getPlanKey,
    getMemoryCapabilities,
    limpiarCampoNombre,
    construirNombreLegal,
    summarizeMemory,
    isMissingTableError,
    resetMiaProfile,
    deleteUserRows,
    deleteUserOwnedRows,
    deleteSupabaseAuthUserIfPossible,
    selectUserRows,
    requireAdminOrCron,
    requireOwnerPhoneOrAdminOrCron,
    cambiarPlanUsuarioPorTelefono,
    generarCodigoVerificacion,
    nuevaCaducidadVerificacion,
    codigoVerificacionCaducado,
  };
}

module.exports = { crearContextoUsuarios, USER_OWNED_TABLES, isSupabaseAuthUuid };
