// routes/admin.js
module.exports = (app, supabase) => {
  app.get('/admin/dashboard', async (req, res) => {
    try {
      // === USUARIOS TOTALES ===
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id');

      if (usersError) {
        console.error('Error obteniendo usuarios:', usersError.message);
        return res.status(500).json({ error: 'Error obteniendo usuarios' });
      }

      const totalUsuarios = users ? users.length : 0;

      // === ENVÍOS WHATSAPP HOY ===
      const hoy = new Date();

      const inicioHoy = new Date(
        hoy.getFullYear(),
        hoy.getMonth(),
        hoy.getDate()
      ).toISOString();

      const inicioManana = new Date(
        hoy.getFullYear(),
        hoy.getMonth(),
        hoy.getDate() + 1
      ).toISOString();

      const { data: logs, error: logsError } = await supabase
        .from('whatsapp_logs')
        .select('status, created_at')
        .gte('created_at', inicioHoy)
        .lt('created_at', inicioManana);

      if (logsError) {
        console.error('Error obteniendo logs WhatsApp:', logsError.message);
        return res.status(500).json({ error: 'Error obteniendo logs WhatsApp' });
      }

      const enviadosHoy = logs.filter((l) => l.status === 'sent').length;
      const fallidosHoy = logs.filter((l) => l.status === 'failed').length;

      // === INGRESOS MES (de momento 0, lo haremos luego) ===
      const ingresosMes = 0;

      return res.json({
        totalUsuarios,
        enviadosHoy,
        fallidosHoy,
        ingresosMes,
      });
    } catch (err) {
      console.error('Error en /admin/dashboard:', err);
      return res.status(500).json({ error: 'Error interno en dashboard' });
    }
  });
};
