// src/routes/preferences.js
//
// Gestión de preferencias del usuario con validación de límites por plan.
//
// Cambios respecto a la versión anterior:
//   - Validación hard de límites (provincias, sectores, subsectores) según plan
//   - Campo libre 'preferencias_extra' solo en planes con campo_libre
//   - GET devuelve también el plan y los límites aplicables (útil para el frontend)
// ══════════════════════════════════════════════════════════════════════

const { requireAuth } = require('../../middleware/requireAdmin');
const { getPlan, validarPreferencias } = require('../../config/planes');
const { extraerPreferenciasBody, prepararPreferenciasExtra } = require('../../shared/preferenciasRequest');
const { normalizarPreferenciasUsuario } = require('../../shared/preferenceCanonical');

module.exports = (app, supabase) => {

  // ══════════════════════════════════════════════════════════════════════
  // GET /me/preferences
  // Devuelve preferencias + plan activo + límites aplicables
  // (el frontend los usa para saber cuántos campos mostrar)
  // ══════════════════════════════════════════════════════════════════════
  app.get('/me/preferences', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const { data, error } = await supabase
        .from('users')
        .select('subscription, preferences, preferencias_extra')
        .eq('id', userId)
        .single();

      if (error) {
        console.error('Error consultando preferences:', error.message);
        return res.status(500).json({ error: 'Error consultando preferencias' });
      }

      if (!data) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const plan = getPlan(data.subscription);

      return res.json({
        preferences:        normalizarPreferenciasUsuario(data.preferences || {}),
        preferencias_extra: plan.campo_libre ? data.preferencias_extra || null : null,
        plan: {
          nombre:            plan.nombre,
          limites:           plan.limites,
          campo_libre:       plan.campo_libre,
          acceso_anticipado: plan.acceso_anticipado,
          fuentes_permitidas: plan.fuentes_permitidas,
        },
      });

    } catch (err) {
      console.error('Error en GET /me/preferences:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // PUT /me/preferences
  // Guarda las preferencias del usuario con validación hard de límites.
  //
  // Body esperado:
  // {
  //   provincias:        [],    // array de strings
  //   sectores:          [],
  //   subsectores:       [],
  //   tipos_alerta:      {},    // objeto { ayudas_subvenciones: true, ... }
  //   preferencias_extra: ""   // string libre opcional
  // }
  // ══════════════════════════════════════════════════════════════════════
  app.put('/me/preferences', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      // 1) Obtener plan actual del usuario
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('subscription')
        .eq('id', userId)
        .single();

      if (userError || !userData) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const subscription = userData.subscription;
      const plan = getPlan(subscription);

      // 2) Aceptar body plano, { preferences: {...} }, snake_case y camelCase
      const { preferences: prefsBody, rawExtra, extraEnviado } = extraerPreferenciasBody(req.body);
      const preferences = normalizarPreferenciasUsuario(prefsBody);

      // 3) Validación hard de límites
      const validacion = validarPreferencias(subscription, preferences);
      if (!validacion.ok) {
        return res.status(400).json({
          error: 'Límites del plan superados',
          detalles: validacion.errores,
          plan: plan.nombre,
          limites: plan.limites,
        });
      }

      // 5) Preparar actualización
      const updateData = { preferences };

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

      // 6) Guardar en BD
      const { error: updError } = await supabase
        .from('users')
        .update(updateData)
        .eq('id', userId);

      if (updError) {
        console.error('Error actualizando preferences:', updError.message);
        return res.status(500).json({ error: 'Error guardando preferencias' });
      }

      return res.json({
        ok: true,
        preferences,
        preferencias_extra: updateData.preferencias_extra ?? null,
        plan: {
          nombre: plan.nombre,
          limites: plan.limites,
          campo_libre: plan.campo_libre,
          acceso_anticipado: plan.acceso_anticipado,
          fuentes_permitidas: plan.fuentes_permitidas,
        },
      });

    } catch (err) {
      console.error('Error en PUT /me/preferences:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });
};
