const { requireAdmin } = require('../../authMiddleware');

// routes/admin.js
module.exports = (app, supabase) => {

  // ──────────────────────────────────────────────────────────────────
  // GET /admin/dashboard
  // ──────────────────────────────────────────────────────────────────
  app.get('/admin/dashboard', requireAdmin, async (req, res) => {
    try {
      const ahora    = new Date();
      const fechaHoy = ahora.toISOString().slice(0, 10);

      const inicioHoy    = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).toISOString();
      const inicioManana = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + 1).toISOString();
      const hace7dias    = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - 6).toISOString();

      // Todas las queries en paralelo
      const [
        { data: users,       error: errUsers },
        { data: logs,        error: errLogs  },
        { count: alertasHoy, error: errAlertas },
      ] = await Promise.all([
        supabase.from('users').select('id, subscription, created_at'),
        supabase.from('whatsapp_logs').select('status, message_type').gte('created_at', inicioHoy).lt('created_at', inicioManana),
        supabase.from('alertas').select('id', { count: 'exact', head: true }).eq('fecha', fechaHoy),
      ]);

      if (errUsers)   return res.status(500).json({ error: errUsers.message });
      if (errLogs)    return res.status(500).json({ error: errLogs.message });

      // Usuarios
      const totalUsuarios = (users || []).length;
      const usuariosPorPlan = { free: 0, corral: 0, agricultor: 0, cooperativa: 0 };
      let nuevosUltimos7dias = 0;

      for (const u of (users || [])) {
        const plan = u.subscription || 'free';
        usuariosPorPlan[plan] = (usuariosPorPlan[plan] ?? 0) + 1;
        if (u.created_at && u.created_at >= hace7dias) nuevosUltimos7dias++;
      }

      // WhatsApp hoy
      const enviadosHoyPro  = (logs || []).filter(l => l.status === 'sent'   && l.message_type === 'alerta_pro').length;
      const enviadosHoyFree = (logs || []).filter(l => l.status === 'sent'   && l.message_type === 'alerta_free').length;
      const fallidosHoyPro  = (logs || []).filter(l => l.status === 'failed' && l.message_type === 'alerta_pro').length;
      const fallidosHoyFree = (logs || []).filter(l => l.status === 'failed' && l.message_type === 'alerta_free').length;

      return res.json({
        totalUsuarios,
        usuariosPorPlan,
        nuevosUltimos7dias,
        alertasHoy:      alertasHoy ?? 0,
        enviadosHoy:     enviadosHoyPro + enviadosHoyFree,
        enviadosHoyPro,
        enviadosHoyFree,
        fallidosHoy:     fallidosHoyPro + fallidosHoyFree,
        fallidosHoyPro,
        fallidosHoyFree,
        ingresosMes:     0,
      });

    } catch (err) {
      console.error('Error en /admin/dashboard:', err);
      return res.status(500).json({ error: 'Error interno en dashboard' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /admin/users
  // ──────────────────────────────────────────────────────────────────
  app.get('/admin/users', requireAdmin, async (req, res) => {
    try {
      const { data: users, error } = await supabase
        .from('users')
        .select('id, name, email, phone, subscription, created_at, preferences, preferencias_extra')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error obteniendo lista de usuarios:', error.message);
        return res.status(500).json({ error: 'Error obteniendo lista de usuarios' });
      }

      const usersSafe = (users || []).map((u) => ({
        id:                 u.id,
        name:               u.name               || '',
        email:              u.email              || '',
        phone:              u.phone              || '',
        subscription:       u.subscription       || 'free',
        created_at:         u.created_at,
        preferences:        u.preferences        || {},
        preferencias_extra: u.preferencias_extra || null,
      }));

      return res.json({ users: usersSafe });

    } catch (err) {
      console.error('Error en /admin/users:', err);
      return res.status(500).json({ error: 'Error interno en /admin/users' });
    }
  });
};
