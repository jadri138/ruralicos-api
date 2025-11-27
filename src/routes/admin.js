module.exports = (app, supabase) => {
  app.get('/admin/dashboard', async (req, res) => {
    try {
      // 1. Total de usuarios (tabla "users")
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id');

      if (usersError) {
        console.error('Error obteniendo usuarios:', usersError);
        return res.status(500).json({ error: 'Error obteniendo usuarios' });
      }

      const totalUsuarios = users ? users.length : 0;

     
      const enviadosHoy = 0;
      const fallidosHoy = 0;
      const ingresosMes = 0;

      res.json({
        totalUsuarios,
        enviadosHoy,
        fallidosHoy,
        ingresosMes,
      });
    } catch (err) {
      console.error('Error en /admin/dashboard:', err);
      res.status(500).json({ error: 'Error interno en dashboard' });
    }
  });
};
