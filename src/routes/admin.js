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

      // WhatsApp hoy — digest_pro y alerta_pro cuentan como PRO
      const esPro  = (t) => t === 'alerta_pro'  || t === 'digest_pro';
      const esFree = (t) => t === 'alerta_free';

      const enviadosHoyPro  = (logs || []).filter(l => l.status === 'sent'   && esPro(l.message_type)).length;
      const enviadosHoyFree = (logs || []).filter(l => l.status === 'sent'   && esFree(l.message_type)).length;
      const fallidosHoyPro  = (logs || []).filter(l => l.status === 'failed' && esPro(l.message_type)).length;
      const fallidosHoyFree = (logs || []).filter(l => l.status === 'failed' && esFree(l.message_type)).length;

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
  // GET /admin/whatsapp-logs
  // ──────────────────────────────────────────────────────────────────
  app.get('/admin/whatsapp-logs', requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);

      const { data, error } = await supabase
        .from('whatsapp_logs')
        .select('id, phone, status, message_type, created_at, error_msg')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ logs: data || [] });

    } catch (err) {
      console.error('Error en /admin/whatsapp-logs:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /admin/digests
  // ──────────────────────────────────────────────────────────────────
  app.get('/admin/digests', requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);

      const { data, error } = await supabase
        .from('digests')
        .select('id, user_id, fecha, mensaje, enviado, enviado_at, created_at, alerta_ids')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ digests: data || [] });

    } catch (err) {
      console.error('Error en /admin/digests:', err);
      return res.status(500).json({ error: 'Error interno' });
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
