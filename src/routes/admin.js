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
        .select('status, created_at, message_type')
        .gte('created_at', inicioHoy)
        .lt('created_at', inicioManana);

      if (logsError) {
        console.error('Error obteniendo logs WhatsApp:', logsError.message);
        return res.status(500).json({ error: 'Error obteniendo logs WhatsApp' });
      }

      const enviadosHoyPro = logs.filter(
        (l) => l.status === 'sent' && l.message_type === 'alerta_pro'
      ).length;

      const enviadosHoyFree = logs.filter(
        (l) => l.status === 'sent' && l.message_type === 'alerta_free'
      ).length;

      const fallidosHoyPro = logs.filter(
        (l) => l.status === 'failed' && l.message_type === 'alerta_pro'
      ).length;

      const fallidosHoyFree = logs.filter(
        (l) => l.status === 'failed' && l.message_type === 'alerta_free'
      ).length;

      const enviadosHoy = enviadosHoyPro + enviadosHoyFree;
      const fallidosHoy = fallidosHoyPro + fallidosHoyFree;

      // === INGRESOS MES (lo dejamos en 0 de momento) ===
      const ingresosMes = 0;

      return res.json({
        totalUsuarios,
        enviadosHoy,
        fallidosHoy,
        ingresosMes,
        enviadosHoyPro,
        enviadosHoyFree,
        fallidosHoyPro,
        fallidosHoyFree,
      });
    } catch (err) {
      console.error('Error en /admin/dashboard:', err);
      return res.status(500).json({ error: 'Error interno en dashboard' });
    }
  });
};
