const { requireAdmin } = require('../../authMiddleware');
const { normalizePhone } = require('../utils/phoneNormalizer');
const { getFechaMadridISO, getRangoDiaMadridUTC } = require('../utils/fechaMadrid');

const PLANES_VALIDOS = ['free', 'corral', 'agricultor', 'cooperativa'];

function getPublicBaseUrl() {
  return process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

async function hitCronPath(path) {
  const token = process.env.CRON_TOKEN;
  if (!token) {
    throw new Error('CRON_TOKEN no configurado');
  }

  const baseUrl = getPublicBaseUrl().replace(/\/+$/, '');
  const url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const response = await fetch(url);
  const raw = await response.text();
  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw: raw.slice(0, 2000) };
    }
  }

  if (!response.ok) {
    const error = new Error(`${path} devolvio ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

// routes/admin.js
module.exports = (app, supabase) => {

  // ──────────────────────────────────────────────────────────────────
  // GET /admin/dashboard
  // ──────────────────────────────────────────────────────────────────
  app.get('/admin/dashboard', requireAdmin, async (req, res) => {
    try {
      const ahora = new Date();
      const fechaHoy = getFechaMadridISO(ahora);
      const { inicio: inicioHoy, fin: inicioManana } = getRangoDiaMadridUTC(fechaHoy);
      const hace7dias = new Date(ahora.getTime() - (6 * 24 * 60 * 60 * 1000)).toISOString();

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

  // Actualizar usuario desde el panel admin
  app.patch('/admin/users/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = {};

      if (req.body.name !== undefined) {
        const name = String(req.body.name || '').trim();
        updates.name = name || null;
      }

      if (req.body.email !== undefined) {
        const email = String(req.body.email || '').trim().toLowerCase();
        updates.email = email || null;
      }

      if (req.body.phone !== undefined) {
        const phone = normalizePhone(req.body.phone);
        updates.phone = phone || null;
      }

      if (req.body.subscription !== undefined) {
        const subscription = String(req.body.subscription || '').trim();
        if (!PLANES_VALIDOS.includes(subscription)) {
          return res.status(400).json({ error: `Plan invalido. Opciones: ${PLANES_VALIDOS.join(', ')}` });
        }
        updates.subscription = subscription;
      }

      if (req.body.preferences !== undefined) {
        if (!req.body.preferences || typeof req.body.preferences !== 'object' || Array.isArray(req.body.preferences)) {
          return res.status(400).json({ error: 'preferences debe ser un objeto JSON' });
        }
        updates.preferences = req.body.preferences;
      }

      if (req.body.preferencias_extra !== undefined) {
        const extra = String(req.body.preferencias_extra || '').trim();
        updates.preferencias_extra = extra ? extra.slice(0, 1000) : null;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No hay campos para actualizar' });
      }

      const { data, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', id)
        .select('id, name, email, phone, subscription, created_at, preferences, preferencias_extra')
        .single();

      if (error || !data) {
        console.error('Error actualizando usuario admin:', error?.message);
        return res.status(500).json({ error: 'Error actualizando usuario' });
      }

      return res.json({ success: true, user: data });
    } catch (err) {
      console.error('Error en PATCH /admin/users/:id:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  app.get('/admin/users/:id/diagnostico-digest', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const result = await hitCronPath(`/alertas/diagnosticar-digest?user_id=${encodeURIComponent(id)}&fecha=${encodeURIComponent(fecha)}`);
      return res.json(result);
    } catch (err) {
      console.error('Error diagnosticando digest desde admin:', err);
      return res.status(err.status || 500).json(err.body || { error: err.message });
    }
  });

  app.get('/admin/users/:id/preview-digest', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();

      const [{ data: user, error: errUser }, { data: digest, error: errDigest }] = await Promise.all([
        supabase
          .from('users')
          .select('id, name, phone, subscription, preferences, preferencias_extra')
          .eq('id', id)
          .single(),
        supabase
          .from('digests')
          .select('id, user_id, fecha, mensaje, enviado, enviado_at, alerta_ids, created_at')
          .eq('user_id', id)
          .eq('fecha', fecha)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (errUser || !user) return res.status(404).json({ error: 'Usuario no encontrado' });
      if (errDigest) return res.status(500).json({ error: errDigest.message });

      if (digest) {
        return res.json({
          success: true,
          fecha,
          user,
          digest,
          existe: true,
        });
      }

      const diagnostico = await hitCronPath(`/alertas/diagnosticar-digest?user_id=${encodeURIComponent(id)}&fecha=${encodeURIComponent(fecha)}`);
      return res.json({
        success: true,
        fecha,
        user,
        digest: null,
        existe: false,
        diagnostico,
        mensaje: 'No existe digest generado para esta fecha. Revisa el diagnostico o lanza preparar-digest.',
      });
    } catch (err) {
      console.error('Error en /admin/users/:id/preview-digest:', err);
      return res.status(err.status || 500).json(err.body || { error: err.message });
    }
  });

  // Estado operativo de boletines/alertas por fecha
  app.get('/admin/boletines/estado', requireAdmin, async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();

      const { data: alertas, error: errAlertas } = await supabase
        .from('alertas')
        .select('id, fuente, estado_ia, duplicado_de, created_at')
        .eq('fecha', fecha);

      if (errAlertas) return res.status(500).json({ error: errAlertas.message });

      const { inicio, fin } = getRangoDiaMadridUTC(fecha);

      const { data: logs, error: errLogs } = await supabase
        .from('whatsapp_logs')
        .select('id, status, message_type, error_msg, created_at')
        .gte('created_at', inicio)
        .lt('created_at', fin);

      if (errLogs) return res.status(500).json({ error: errLogs.message });

      const fuentes = {};
      for (const alerta of alertas || []) {
        const fuente = String(alerta.fuente || 'SIN_FUENTE').toUpperCase();
        if (!fuentes[fuente]) {
          fuentes[fuente] = {
            fuente,
            total: 0,
            duplicadas: 0,
            estados: {},
          };
        }
        fuentes[fuente].total++;
        if (alerta.duplicado_de) fuentes[fuente].duplicadas++;
        const estado = alerta.estado_ia || 'sin_estado';
        fuentes[fuente].estados[estado] = (fuentes[fuente].estados[estado] || 0) + 1;
      }

      const fallosWhatsapp = (logs || []).filter((log) => log.status === 'failed');

      return res.json({
        fecha,
        alertasTotal: (alertas || []).length,
        fuentes: Object.values(fuentes).sort((a, b) => a.fuente.localeCompare(b.fuente)),
        whatsapp: {
          total: (logs || []).length,
          enviados: (logs || []).filter((log) => log.status === 'sent').length,
          fallidos: fallosWhatsapp.length,
          errores: fallosWhatsapp.slice(0, 20),
        },
      });
    } catch (err) {
      console.error('Error en /admin/boletines/estado:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

app.post('/admin/tareas/scrapers-diario', requireAdmin, async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.fecha || '')
        ? `?fecha=${encodeURIComponent(req.body.fecha)}`
        : '';
      const result = await hitCronPath(`/tareas/scrapers-diario${fecha}`);
      return res.json(result);
    } catch (err) {
      console.error('Error lanzando scrapers desde admin:', err);
      return res.status(err.status || 500).json(err.body || { error: err.message });
    }
  });

  app.post('/admin/tareas/scraper', requireAdmin, async (req, res) => {
    try {
      const path = String(req.body?.path || '').trim();
      if (!path) return res.status(400).json({ error: 'Falta path del scraper' });

      const params = new URLSearchParams({ path });
      if (/^\d{4}-\d{2}-\d{2}$/.test(req.body?.fecha || '')) {
        params.set('fecha', req.body.fecha);
      }

      const result = await hitCronPath(`/tareas/scraper?${params.toString()}`);
      return res.json(result);
    } catch (err) {
      console.error('Error lanzando scraper desde admin:', err);
      return res.status(err.status || 500).json(err.body || { error: err.message });
    }
  });

  app.post('/admin/tareas/pipeline-diario', requireAdmin, async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.fecha || '')
        ? `?fecha=${encodeURIComponent(req.body.fecha)}`
        : '';
      const result = await hitCronPath(`/tareas/pipeline-diario${fecha}`);
      return res.json(result);
    } catch (err) {
      console.error('Error lanzando pipeline desde admin:', err);
      return res.status(err.status || 500).json(err.body || { error: err.message });
    }
  });

  app.get('/admin/scraper-runs', requireAdmin, async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const limit = Math.min(Number(req.query.limit || 200), 500);

      const { data, error } = await supabase
        .from('scraper_runs')
        .select('id, fuente, endpoint, fecha_objetivo, started_at, finished_at, duration_ms, status, http_status, nuevas, duplicadas, errores, relevantes, mensaje, error_msg')
        .eq('fecha_objetivo', fecha)
        .order('started_at', { ascending: false })
        .limit(limit);

      if (error) {
        if (error.code === '42P01') {
          return res.status(503).json({
            error: 'Falta crear la tabla scraper_runs. Ejecuta docs/scraper_runs_schema.sql en Supabase.',
          });
        }
        return res.status(500).json({ error: error.message });
      }

      const latestByFuente = {};
      for (const run of data || []) {
        if (!latestByFuente[run.fuente]) latestByFuente[run.fuente] = run;
      }

      return res.json({
        fecha,
        runs: data || [],
        latest: Object.values(latestByFuente).sort((a, b) => a.fuente.localeCompare(b.fuente)),
      });
    } catch (err) {
      console.error('Error en /admin/scraper-runs:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  app.get('/admin/pipeline-runs', requireAdmin, async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const limit = Math.min(Number(req.query.limit || 200), 500);

      const { data, error } = await supabase
        .from('pipeline_runs')
        .select('id, stage, endpoint, fecha_objetivo, started_at, finished_at, duration_ms, status, loops, procesadas, errores, error_msg')
        .eq('fecha_objetivo', fecha)
        .order('started_at', { ascending: false })
        .limit(limit);

      if (error) {
        if (error.code === '42P01') {
          return res.status(503).json({
            error: 'Falta crear la tabla pipeline_runs. Ejecuta docs/pipeline_runs_schema.sql en Supabase.',
          });
        }
        return res.status(500).json({ error: error.message });
      }

      const latestByStage = {};
      for (const run of data || []) {
        if (!latestByStage[run.stage]) latestByStage[run.stage] = run;
      }

      return res.json({
        fecha,
        runs: data || [],
        latest: Object.values(latestByStage).sort((a, b) => a.stage.localeCompare(b.stage)),
      });
    } catch (err) {
      console.error('Error en /admin/pipeline-runs:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  app.patch('/admin/alertas/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = {};
      const camposTexto = ['titulo', 'resumen', 'resumen_final', 'estado_ia', 'fuente', 'region', 'url'];
      const camposJson = ['provincias', 'sectores', 'subsectores', 'tipos_alerta'];

      for (const campo of camposTexto) {
        if (req.body[campo] !== undefined) {
          const value = String(req.body[campo] || '').trim();
          updates[campo] = value || null;
        }
      }

      for (const campo of camposJson) {
        if (req.body[campo] !== undefined) {
          if (req.body[campo] !== null && typeof req.body[campo] !== 'object') {
            return res.status(400).json({ error: `${campo} debe ser JSON` });
          }
          updates[campo] = req.body[campo];
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No hay campos para actualizar' });
      }

      const { data, error } = await supabase
        .from('alertas')
        .update(updates)
        .eq('id', id)
        .select('*')
        .single();

      if (error || !data) {
        console.error('Error actualizando alerta admin:', error?.message);
        return res.status(500).json({ error: 'Error actualizando alerta' });
      }

      return res.json({ success: true, alerta: data });
    } catch (err) {
      console.error('Error en PATCH /admin/alertas/:id:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  app.post('/admin/alertas/:id/reprocesar', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const fase = String(req.body?.fase || 'clasificar');
      const estado = fase === 'resumir'
        ? 'pendiente_resumir'
        : fase === 'revisar'
          ? 'pendiente_revisar'
          : 'pendiente_clasificar';

      const { data, error } = await supabase
        .from('alertas')
        .update({
          estado_ia: estado,
          ...(estado === 'pendiente_clasificar'
            ? { resumen_borrador: null, resumen_final: null }
            : {}),
        })
        .eq('id', id)
        .select('id, titulo, estado_ia')
        .single();

      if (error || !data) {
        console.error('Error marcando alerta para reprocesar:', error?.message);
        return res.status(500).json({ error: 'Error marcando alerta para reprocesar' });
      }

      return res.json({ success: true, alerta: data });
    } catch (err) {
      console.error('Error en POST /admin/alertas/:id/reprocesar:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });
};
