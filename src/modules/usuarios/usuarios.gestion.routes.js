// src/modules/usuarios/usuarios.gestion.routes.js
//
// Operaciones admin/cron sobre usuarios (listado, plan, borrado, preferencias).
// Contexto compartido en usuarios.context.js.

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

module.exports = (app, supabase, ctx) => {
  const {
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
  } = ctx;

  app.get('/', (req, res) => {
    res.json({ message: 'La API de Ruralicos esta vivaa!! 🚜' });
  });


  // --------------------------------------------------
  // LISTAR USUARIOS (solo para depurar)
  // --------------------------------------------------
  app.get('/users', async (req, res) => {
    if (!checkCronToken(req, res)) return;
    const { data, error } = await supabase
      .from('users')
      .select('id, phone, subscription, preferences, preferencias_extra')
      .order('id', { ascending: true });

    if (error) {
      console.error('Error listando usuarios:', error);
      return res.status(500).json({ error: 'Error obteniendo usuarios' });
    }

    res.json({ users: data });
  });


  // --------------------------------------------------
  // CAMBIAR PLAN USANDO TELÉFONO (admin)
  // Body: { phone, plan } donde plan es uno de: corral, agricultor, cooperativa, free
  // --------------------------------------------------
  app.post('/users/cambiar-plan', requireAdminOrCron, async (req, res) => {
    const result = await cambiarPlanUsuarioPorTelefono(req.body?.phone, req.body?.plan);

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    console.log(
      `[admin] Plan de ${result.phone} cambiado de '${result.previous_subscription}' a '${result.user.subscription}'`
    );
    return res.json({
      success: true,
      user: result.user,
      plan_change_notification: result.notification,
    });

  });


  // Legacy — se mantienen por compatibilidad con integraciones existentes
  app.post('/users/upgrade-to-pro', requireAdminOrCron, async (req, res) => {
    const result = await cambiarPlanUsuarioPorTelefono(req.body?.phone, 'cooperativa');
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ success: true, user: result.user, plan_change_notification: result.notification });
  });


  app.post('/users/downgrade-to-free', requireAdminOrCron, async (req, res) => {
    const result = await cambiarPlanUsuarioPorTelefono(req.body?.phone, 'corral');
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ success: true, user: result.user, plan_change_notification: result.notification });
  });


  // ELIMINACION DE USUARIO
  app.delete('/users/:id', requireAdminOrCron, async (req, res) => {
    const { id } = req.params;

    try {
      const { data: existingUser, error: existingError } = await supabase
        .from('users')
        .select('id')
        .eq('id', id)
        .maybeSingle();

      if (existingError) throw existingError;
      if (!existingUser) return res.status(404).json({ error: 'Usuario no encontrado' });

      const authDelete = await deleteSupabaseAuthUserIfPossible(id);
      const tablasLimpiadas = await deleteUserOwnedRows(id);
      const { data: deletedUser, error: deleteUserError } = await supabase
        .from('users')
        .delete()
        .eq('id', id)
        .select('id')
        .maybeSingle();

      if (deleteUserError) throw deleteUserError;
      if (!deletedUser) return res.status(404).json({ error: 'Usuario no encontrado' });

      res.status(200).json({
        message: 'Cuenta eliminada correctamente',
        auth_delete: authDelete,
        tablas_limpiadas: tablasLimpiadas,
      });
    } catch (err) {
      console.error('Error eliminando usuario:', err);
      res.status(500).json({ error: 'No se pudo eliminar la cuenta' });
    }
  });


  // --------------------------------------------------
  // OBTENER PREFERENCIAS USANDO TELÉFONO
  // --------------------------------------------------
  app.post('/users/get-preferences', requireOwnerPhoneOrAdminOrCron, async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    const { data, error } = await supabase
      .from('users')
        .select('phone, subscription, preferences, preferencias_extra')
      .eq('phone', soloDigitos)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ user: { ...data, preferences: normalizarPreferenciasUsuario(data.preferences || {}) } });
  });


  // --------------------------------------------------
  // GUARDAR PREFERENCIAS USANDO TELÉFONO
  // Ruta legacy — la validación de límites por plan está en preferences.js
  // --------------------------------------------------
  app.put('/users/preferences', requireOwnerPhoneOrAdminOrCron, async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    phone = String(phone).trim();
    const soloDigitos = phone.replace(/\D/g, '');

    const { data: user, error: errUser } = await supabase
      .from('users')
      .select('subscription')
      .eq('phone', soloDigitos)
      .single();

    if (errUser || !user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const plan = getPlan(user.subscription);

    // Solo planes con digest pueden guardar preferencias personalizadas
    if (!plan.digest) {
      return res.status(403).json({
        error: `El plan ${plan.nombre} no permite preferencias personalizadas.`,
      });
    }

    const { preferences: prefsBody, rawExtra, extraEnviado } = extraerPreferenciasBody(req.body);
    const prefs = normalizarPreferenciasUsuario(prefsBody);

    const validacion = validarPreferencias(user.subscription, prefs);
    if (!validacion.ok) {
      return res.status(400).json({
        error: 'Limites del plan superados',
        detalles: validacion.errores,
        plan: plan.nombre,
        limites: plan.limites,
      });
    }

    const updateData = { preferences: prefs };

    if (!plan.campo_libre) {
      updateData.preferencias_extra = null;
    }

    if (extraEnviado) {
      const extra = prepararPreferenciasExtra(rawExtra);
      if (!extra.ok) return res.status(400).json({ error: extra.error });
      if (extra.valor && !plan.campo_libre) {
        return res.status(403).json({
          error: `El plan ${plan.nombre} no permite preferencias extra.`,
        });
      }
      updateData.preferencias_extra = plan.campo_libre ? extra.valor : null;
    }

    const { error } = await supabase
      .from('users')
      .update(updateData)
      .eq('phone', soloDigitos);

    if (error) {
      console.error('Error guardando preferencias:', error);
      return res.status(500).json({ error: 'Error guardando preferencias' });
    }

    res.json({
      ok: true,
      preferences: prefs,
      preferencias_extra: updateData.preferencias_extra ?? null,
      plan: plan.nombre,
    });
  });

};
