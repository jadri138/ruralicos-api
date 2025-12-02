// src/routes/preferences.js
const { requireAuth } = require('../authMiddleware');

module.exports = (app, supabase) => {
  /**
   * GET /me/preferences
   * Devuelve las preferencias del usuario logeado
   */
  app.get('/me/preferences', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub; // id del usuario en el JWT

      const { data, error } = await supabase
        .from('users')
        .select('preferences')   // 👈 columna correcta
        .eq('id', userId)
        .single();

      if (error) {
        console.error('Error consultando preferences:', error.message);
        return res.status(500).json({ error: 'Error consultando preferencias' });
      }

      if (!data) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      // si preferences es null devolvemos {}
      res.json(data.preferences || {});
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
      const preferences = req.body; // JSON tal cual

      const { error } = await supabase
        .from('users')
        .update({ preferences })   // 👈 misma columna
        .eq('id', userId);

      if (error) {
        console.error('Error actualizando preferences:', error.message);
        return res.status(500).json({ error: 'Error guardando preferencias' });
      }

      res.json({ ok: true, preferences });
    } catch (err) {
      console.error('Error en PUT /me/preferences:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });
};
