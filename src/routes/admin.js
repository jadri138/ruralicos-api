const { requireAdmin } = require('../../authMiddleware');

// routes/admin.js
module.exports = (app, supabase) => {

  // DASHBOARD RESUMEN
  app.get('/admin/dashboard', requireAdmin, async (req, res) => {
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
        return res
          .status(500)
          .json({ error: 'Error obteniendo logs WhatsApp' });
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

      const ingresosMes = 0; // ya lo montaremos con pagos

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

  // LISTA DE USUARIOS PARA EL PANEL
  app.get('/admin/users', requireAdmin, async (req, res) => {
    try {
      const { data: users, error } = await supabase
        .from('users')
        .select('id, name, phone, subscription, created_at, preferences')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error obteniendo lista de usuarios:', error.message);
        return res
          .status(500)
          .json({ error: 'Error obteniendo lista de usuarios' });
      }

      // Por si algún campo viene null
      const usersSafe = (users || []).map((u) => ({
        id: u.id,
        name: u.name || "",
        phone: u.phone || '',
        subscription: u.subscription || 'free',
        created_at: u.created_at,
        preferences: u.preferences || {},
      }));

      return res.json({ users: usersSafe });
    } catch (err) {
      console.error('Error en /admin/users:', err);
      return res.status(500).json({ error: 'Error interno en /admin/users' });
    }
  });
};
