// src/modules/usuarios/usuarios.cuenta.routes.js
//
// Autoservicio del usuario autenticado (/me): datos, plan, memoria, export y baja.
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


  // --------------------------------------------------
  // MI CUENTA — devuelve datos del usuario logueado
  // --------------------------------------------------
  app.get('/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const { data, error } = await supabase
        .from('users')
        .select('phone, name, first_name, last_name_1, last_name_2, legal_name, email, subscription, phone_verified')
        .eq('id', userId)
        .single();

      if (error) {
        console.error('Error /me:', error);
        return res.status(500).json({ error: 'Error leyendo usuario' });
      }

      if (!data) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      return res.json({ user: data });
    } catch (e) {
      console.error('Error interno /me:', e);
      return res.status(500).json({ error: 'Error interno' });
    }
  });


  // --------------------------------------------------
  // ACTUALIZAR MIS DATOS (Email y Teléfono)
  // PUT /me -> permite al usuario logueado editar su perfil
  // --------------------------------------------------
  app.put('/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      let {
        email,
        phone,
        first_name,
        firstName,
        last_name_1,
        lastName1,
        last_name_2,
        lastName2,
      } = req.body;

      // Objeto con los campos a actualizar
      const updates = {};
      let codigoVerificacion = null;
      let telefonoParaVerificar = null;

      const { data: userActual, error: userActualError } = await supabase
        .from('users')
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, phone_verified, phone_verification_expires_at')
        .eq('id', userId)
        .single();

      if (userActualError || !userActual) {
        console.error('Error leyendo usuario actual en PUT /me:', userActualError?.message);
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      
      if (email !== undefined) {
        const emailNormalizado = email === '' ? null : String(email).trim().toLowerCase();

        if (emailNormalizado) {
          const { data: emailExistente, error: emailError } = await supabase
            .from('users')
            .select('id')
            .eq('email', emailNormalizado)
            .neq('id', userId)
            .maybeSingle();

          if (emailError) {
            console.error('Error comprobando email en PUT /me:', emailError.message);
            return res.status(500).json({ error: 'Error comprobando email' });
          }

          if (emailExistente) {
            return res.status(400).json({ error: 'Este email ya esta registrado' });
          }
        }

        updates.email = emailNormalizado;
      }

      const hayIdentidadEnBody =
        first_name !== undefined ||
        firstName !== undefined ||
        last_name_1 !== undefined ||
        lastName1 !== undefined ||
        last_name_2 !== undefined ||
        lastName2 !== undefined;

      if (hayIdentidadEnBody) {
        const firstNameClean = limpiarCampoNombre(first_name ?? firstName ?? userActual.first_name);
        const lastName1Clean = limpiarCampoNombre(last_name_1 ?? lastName1 ?? userActual.last_name_1);
        const lastName2Clean = limpiarCampoNombre(last_name_2 ?? lastName2 ?? userActual.last_name_2);

        if (!firstNameClean || !lastName1Clean || !lastName2Clean) {
          return res.status(400).json({ error: 'Indica nombre, primer apellido y segundo apellido' });
        }

        const legalName = construirNombreLegal({
          firstName: firstNameClean,
          lastName1: lastName1Clean,
          lastName2: lastName2Clean,
          fallbackName: userActual.name,
        });

        updates.first_name = firstNameClean;
        updates.last_name_1 = lastName1Clean;
        updates.last_name_2 = lastName2Clean;
        updates.legal_name = legalName;
        updates.name = legalName;
      }
      
      if (phone !== undefined) {
        const telefonoNormalizado = normalizePhone(phone);
        if (!isPhoneValid(telefonoNormalizado)) {
          return res.status(400).json({ error: 'Numero de telefono no valido' });
        }
        const telefonoCambia = telefonoNormalizado !== String(userActual.phone || '');

        if (telefonoCambia) {
          const { data: phoneExistente, error: phoneError } = await supabase
            .from('users')
            .select('id')
            .eq('phone', telefonoNormalizado)
            .neq('id', userId)
            .maybeSingle();

          if (phoneError) {
            console.error('Error comprobando telefono en PUT /me:', phoneError.message);
            return res.status(500).json({ error: 'Error comprobando telefono' });
          }

          if (phoneExistente) {
            return res.status(400).json({ error: 'Este numero ya esta registrado' });
          }
        }

        updates.phone = telefonoNormalizado;

        if (
          telefonoCambia ||
          (userActual.phone_verified === false && codigoVerificacionCaducado(userActual.phone_verification_expires_at))
        ) {
          codigoVerificacion = generarCodigoVerificacion();
          telefonoParaVerificar = telefonoNormalizado;
          updates.phone_verified = false;
          updates.phone_verification_code = codigoVerificacion;
          updates.phone_verification_expires_at = nuevaCaducidadVerificacion();
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.json({
          ok: true,
          user: userActual,
          phone_verification_required: false,
        });
      }

      const { data, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', userId)
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, phone_verified')
        .single();

      if (error) {
        console.error('Error actualizando usuario:', error.message);
        return res.status(500).json({ error: 'Error al actualizar los datos' });
      }

      res.json({
        ok: true,
        user: data,
        phone_verification_required: Boolean(codigoVerificacion),
        verification_phone: telefonoParaVerificar,
      });

      if (codigoVerificacion && telefonoParaVerificar) {
        enviarWhatsAppVerificacion(telefonoParaVerificar, codigoVerificacion).catch((err) => {
          console.error('Error enviando WhatsApp de verificacion por cambio de telefono:', err.message);
        });
      }
    } catch (err) {
      console.error('Error en PUT /me:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });


  // --------------------------------------------------
  // VERIFICAR MI TELEFONO DESDE CUENTA
  // --------------------------------------------------
  app.post('/me/verify-phone', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const code = String(req.body?.code || '').trim();

      if (!code) {
        return res.status(400).json({ error: 'Falta el codigo' });
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, phone_verified, phone_verification_code, phone_verification_expires_at')
        .eq('id', userId)
        .single();

      if (error || !user) {
        console.error('Error buscando usuario en /me/verify-phone:', error?.message);
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      if (user.phone_verified) {
        return res.json({
          ok: true,
          message: 'Telefono ya verificado',
          user: {
            id: user.id,
            name: user.name,
            first_name: user.first_name,
            last_name_1: user.last_name_1,
            last_name_2: user.last_name_2,
            legal_name: user.legal_name,
            phone: user.phone,
            email: user.email,
            subscription: user.subscription,
            phone_verified: true,
          },
        });
      }

      if (String(user.phone_verification_code || '') !== code) {
        return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
      }

      if (codigoVerificacionCaducado(user.phone_verification_expires_at)) {
        return res.status(400).json({ error: 'Codigo incorrecto o caducado' });
      }

      const { data, error: updateError } = await supabase
        .from('users')
        .update({
          phone_verified: true,
          phone_verification_code: null,
          phone_verification_expires_at: null,
        })
        .eq('id', userId)
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, phone_verified')
        .single();

      if (updateError) {
        console.error('Error verificando telefono en /me/verify-phone:', updateError.message);
        return res.status(500).json({ error: 'Error confirmando verificacion' });
      }

      return res.json({
        ok: true,
        message: 'Telefono verificado correctamente',
        user: data,
      });
    } catch (err) {
      console.error('Error en /me/verify-phone:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });


  // --------------------------------------------------
  // CAMBIAR MI PLAN
  // PUT /me/plan -> permite al usuario logueado cambiar su plan
  // --------------------------------------------------
  app.put('/me/plan', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const plan = String(req.body?.plan || '').trim().toLowerCase();
      const PLANES_USUARIO = ['corral', 'agricultor', 'cooperativa'];

      if (!PLANES_USUARIO.includes(plan)) {
        return res.status(400).json({
          error: `Plan invalido. Opciones: ${PLANES_USUARIO.join(', ')}`,
        });
      }

      const { data: userActual, error: userError } = await supabase
        .from('users')
        .select('subscription, preferences, phone, name, first_name, legal_name, email')
        .eq('id', userId)
        .single();

      if (userError || !userActual) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const preferencesActualesRaw =
        userActual.preferences && typeof userActual.preferences === 'object'
          ? userActual.preferences
          : {};
      const preferencesActuales = normalizarPreferenciasUsuario(preferencesActualesRaw);
      const preferencesAjustadas = truncarPreferencias(plan, preferencesActuales);
      const seAjustaronPreferencias =
        JSON.stringify(preferencesAjustadas) !== JSON.stringify(preferencesActualesRaw);
      const planConfig = getPlan(plan);

      const { data, error } = await supabase
        .from('users')
        .update({
          subscription: plan,
          preferences: preferencesAjustadas,
          ...(planConfig.campo_libre ? {} : { preferencias_extra: null }),
        })
        .eq('id', userId)
        .select('id, phone, name, first_name, legal_name, email, subscription, preferences, preferencias_extra')
        .single();

      if (error) {
        console.error('Error cambiando plan de /me:', error.message);
        return res.status(500).json({ error: 'No se pudo cambiar el plan' });
      }

      const planChangeNotification = await notificarCambioPlan({
        user: data,
        planAnterior: userActual.subscription,
        planNuevo: data.subscription,
      });

      return res.json({
        ok: true,
        user: data,
        plan_change_notification: planChangeNotification,
        preferences: data.preferences || {},
        preferencias_extra: data.preferencias_extra || null,
        preferences_ajustadas: seAjustaronPreferencias,
        plan: {
          nombre: planConfig.nombre,
          limites: planConfig.limites,
          campo_libre: planConfig.campo_libre,
          acceso_anticipado: planConfig.acceso_anticipado,
          fuentes_permitidas: planConfig.fuentes_permitidas,
        },
      });
    } catch (err) {
      console.error('Error en PUT /me/plan:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });


  // --------------------------------------------------
  // EXPORTAR MIS DATOS
  // GET /me/export -> descarga estructurada de datos de cuenta
  // --------------------------------------------------
  app.get('/me/export', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const userColumns =
        'id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, preferences, preferencias_extra, created_at, perfil_version, perfil_actualizado_at, contexto_narrativo, ultima_interaccion_at';

      let { data: user, error: userError } = await supabase
        .from('users')
        .select(userColumns)
        .eq('id', userId)
        .single();

      if (userError && /perfil_|contexto_narrativo|ultima_interaccion_at/i.test(userError.message || '')) {
        const fallback = await supabase
          .from('users')
          .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, preferences, preferencias_extra, created_at')
          .eq('id', userId)
          .single();

        user = fallback.data;
        userError = fallback.error;
      }

      if (userError || !user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const [
        digests,
        memories,
        feedback,
        interestProfile,
        clicks,
        conversations,
        explorations,
        officialMatches,
      ] = await Promise.all([
        selectUserRows('digests', 'id, fecha, mensaje, alerta_ids, enviado, enviado_at, created_at', userId, { order: 'created_at', limit: 300 }),
        selectUserRows('user_memory', 'id, tipo, contenido, alerta_id, digest_id, peso_inicial, incorporado_a_embedding, created_at', userId, { order: 'created_at', limit: 1000 }),
        selectUserRows('alerta_feedback', 'id, digest_id, alerta_id, item_numero, valor, raw_text, created_at, updated_at', userId, { order: 'created_at', limit: 1000 }),
        selectUserRows('user_interest_profile', 'id, tag, score, positivos, negativos, updated_at', userId, { order: 'updated_at', limit: 1000 }),
        selectUserRows('alerta_clicks', 'id, digest_id, alerta_id, url_destino, created_at', userId, { order: 'created_at', limit: 1000 }),
        selectUserRows('user_conversations', 'id, tipo, estado, digest_id, abierta_at, cerrada_at, expira_at', userId, { order: 'abierta_at', limit: 300 }),
        selectUserRows('exploration_log', 'id, digest_id, alerta_id, tipo_exploracion, motivo, resultado, procesado, created_at', userId, { order: 'created_at', limit: 300 }),
        selectUserRows('official_list_matches', 'id, alerta_id, fuente, contexto, listado_titulo, persona_detectada, linea, url_fuente, enviado, enviado_at, created_at', userId, { order: 'created_at', limit: 300 }),
      ]);

      return res.json({
        generated_at: new Date().toISOString(),
        user,
        digests,
        memory: memories,
        feedback,
        interest_profile: interestProfile,
        clicks,
        conversations,
        explorations,
        official_list_matches: officialMatches,
      });
    } catch (err) {
      console.error('Error en GET /me/export:', err);
      return res.status(500).json({ error: 'No se pudo exportar la cuenta' });
    }
  });


  // --------------------------------------------------
  // MI MEMORIA MIA
  // GET /me/memory -> resumen de memoria y detalle segun plan
  // --------------------------------------------------
  app.get('/me/memory', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, subscription, perfil_embedding, perfil_version, perfil_actualizado_at, contexto_narrativo, ultima_interaccion_at')
        .eq('id', userId)
        .single();

      if (userError || !user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const capabilities = getMemoryCapabilities(user.subscription);

      const { data: memories, error: memoriesError } = await supabase
        .from('user_memory')
        .select('id, tipo, contenido, alerta_id, digest_id, peso_inicial, incorporado_a_embedding, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(capabilities.detail_access ? 200 : 50);

      if (memoriesError && !isMissingTableError(memoriesError)) {
        console.error('Error en GET /me/memory:', memoriesError.message);
        return res.status(500).json({ error: 'Error consultando memoria' });
      }

      const memoryList = memories || [];

      return res.json({
        capabilities,
        profile: {
          has_profile: Boolean(user.perfil_embedding),
          version: user.perfil_version || 0,
          updated_at: user.perfil_actualizado_at || null,
          last_interaction_at: user.ultima_interaccion_at || null,
          narrative_context: capabilities.detail_access ? user.contexto_narrativo || null : null,
        },
        memory: {
          total: memoryList.length,
          by_type: summarizeMemory(memoryList),
          pending_profile: memoryList.filter((memory) => memory.incorporado_a_embedding === false).length,
          latest: capabilities.detail_access ? memoryList.slice(0, 50) : [],
        },
      });
    } catch (err) {
      console.error('Error en GET /me/memory:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });


  // --------------------------------------------------
  // BORRAR UNA MEMORIA
  // DELETE /me/memory/:id -> solo Cooperativa
  // --------------------------------------------------
  app.delete('/me/memory/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const memoryId = Number(req.params.id);

      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: 'Memoria no valida' });
      }

      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, subscription')
        .eq('id', userId)
        .single();

      if (userError || !user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const capabilities = getMemoryCapabilities(user.subscription);
      if (!capabilities.manage_access) {
        return res.status(403).json({ error: 'Tu plan no permite gestionar memoria avanzada' });
      }

      const { data, error } = await supabase
        .from('user_memory')
        .delete()
        .eq('id', memoryId)
        .eq('user_id', userId)
        .select('id')
        .maybeSingle();

      if (error) {
        console.error('Error borrando memoria:', error.message);
        return res.status(500).json({ error: 'No se pudo borrar la memoria' });
      }

      if (!data) return res.status(404).json({ error: 'Memoria no encontrada' });

      await resetMiaProfile(userId);
      actualizarPerfilUsuarioMIASafe(supabase, userId).catch((err) => {
        console.warn('[memoria] Recalculo no bloqueante fallido:', err.message);
      });

      return res.json({ ok: true, deleted_id: memoryId });
    } catch (err) {
      console.error('Error en DELETE /me/memory/:id:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });


  // --------------------------------------------------
  // BORRAR TODA LA MEMORIA
  // DELETE /me/memory -> solo Cooperativa
  // --------------------------------------------------
  app.delete('/me/memory', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, subscription')
        .eq('id', userId)
        .single();

      if (userError || !user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const capabilities = getMemoryCapabilities(user.subscription);
      if (!capabilities.manage_access) {
        return res.status(403).json({ error: 'Tu plan no permite reiniciar memoria avanzada' });
      }

      await deleteUserRows('user_memory', userId);
      await deleteUserRows('user_interest_profile', userId);
      await deleteUserRows('alerta_feedback', userId);
      await deleteUserRows('exploration_log', userId);
      await deleteUserRows('user_conversations', userId);
      await resetMiaProfile(userId);

      return res.json({ ok: true, message: 'Memoria reiniciada' });
    } catch (err) {
      console.error('Error en DELETE /me/memory:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });


  // --------------------------------------------------
  // ELIMINAR MI CUENTA
  // DELETE /me -> permite al usuario logueado borrar su cuenta
  // --------------------------------------------------
  app.delete('/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const tablasLimpiadas = await deleteUserOwnedRows(userId);

      const { data, error } = await supabase
        .from('users')
        .delete()
        .eq('id', userId)
        .select('id')
        .maybeSingle();

      if (error) {
        console.error('Error eliminando /me:', error.message);
        return res.status(500).json({ error: 'No se pudo eliminar la cuenta' });
      }

      if (!data) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      return res.json({
        ok: true,
        message: 'Cuenta eliminada correctamente',
        tablas_limpiadas: tablasLimpiadas,
      });
    } catch (err) {
      console.error('Error en DELETE /me:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });


  // --------------------------------------------------
  // MIS ALERTAS — historial real preparado para el usuario
  // --------------------------------------------------
  app.get('/me/alertas', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const limit = Math.min(Number(req.query.limit || 12) || 12, 50);

      const { data: digests, error: digestsError } = await supabase
        .from('digests')
        .select('id, fecha, mensaje, alerta_ids, enviado, enviado_at, created_at, error_msg')
        .eq('user_id', userId)
        .order('fecha', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limit);

      if (digestsError) {
        console.error('Error en GET /me/alertas digests:', digestsError.message);
        return res.status(500).json({ error: 'Error consultando alertas' });
      }

      const alertaIds = [
        ...new Set(
          (digests || [])
            .flatMap((digest) => Array.isArray(digest.alerta_ids) ? digest.alerta_ids : [])
            .map((id) => Number(id))
            .filter(Boolean)
        ),
      ];

      let alertasPorId = {};

      if (alertaIds.length > 0) {
        const { data: alertas, error: alertasError } = await supabase
          .from('alertas')
          .select('id, titulo, resumen, resumen_final, url, fecha, region, fuente, provincias, sectores, subsectores, tipos_alerta, estado_ia, created_at')
          .in('id', alertaIds);

        if (alertasError) {
          console.error('Error en GET /me/alertas alertas:', alertasError.message);
          return res.status(500).json({ error: 'Error consultando alertas' });
        }

        alertasPorId = Object.fromEntries((alertas || []).map((alerta) => [Number(alerta.id), alerta]));
      }

      const digestsConAlertas = (digests || []).map((digest) => {
        const ids = Array.isArray(digest.alerta_ids)
          ? digest.alerta_ids.map((id) => Number(id)).filter(Boolean)
          : [];

        return {
          ...digest,
          alertas: ids.map((id) => alertasPorId[id]).filter(Boolean),
        };
      });

      const totalAlertas = digestsConAlertas.reduce(
        (total, digest) => total + digest.alertas.length,
        0
      );

      return res.json({
        digests: digestsConAlertas,
        resumen: {
          digests: digestsConAlertas.length,
          alertas: totalAlertas,
          ultimo_digest: digestsConAlertas[0] || null,
        },
      });
    } catch (err) {
      console.error('Error en GET /me/alertas:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

};
