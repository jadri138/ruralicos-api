// src/routes/preferences.js
const { requireAuth } = require('../authMiddleware');

module.exports = (app, supabase) => {
  /**
   * GET /me/preferences
   * Devuelve las preferencias del usuario logeado
   */
  app.get('/me/preferences', requireAuth, async (req, res) => {
    try {
      // suponemos que en el token guardas el id del usuario en "sub"
      const userId = req.user.sub;

      const { data, error } = await supabase
        .from('users')
        .select('preferencias')
        .eq('id', userId)
        .single();

      if (error) {
        console.error('Error consultando preferencias:', error.message);
        return res.status(500).json({ error: 'Error consultando preferencias' });
      }

      if (!data) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      // si preferencias es null, devolvemos objeto vacío
      res.json(data.preferencias || {});
    } catch (err) {
      console.error('Error en GET /me/preferences:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });

  /**
   * PUT /me/preferences
   * Guarda las preferencias del usuario logeado
   */
  app.put('/me/preferences', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const preferencias = req.body; // debe venir JSON

      const { error } = await supabase
        .from('users')
        .update({ preferencias })
        .eq('id', userId);

      if (error) {
        console.error('Error actualizando preferencias:', error.message);
        return res.status(500).json({ error: 'Error guardando preferencias' });
      }

      res.json({ ok: true, preferencias });
    } catch (err) {
      console.error('Error en PUT /me/preferences:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });
};
