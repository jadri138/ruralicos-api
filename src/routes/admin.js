const { requireAdmin } = require('../../authMiddleware');
const { normalizePhone } = require('../utils/phoneNormalizer');
const { getFechaMadridISO, getRangoDiaMadridUTC } = require('../utils/fechaMadrid');
const { actualizarPerfilUsuarioMIA } = require('../brain/miaProfile');

const PLANES_VALIDOS = ['free', 'corral', 'agricultor', 'cooperativa'];
const USER_SELECT_ADMIN = 'id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, preferences, preferencias_extra, contexto_narrativo, perfil_version, perfil_actualizado_at, ultima_interaccion_at, created_at';

function limpiarBusquedaUsuario(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function escaparLike(value) {
  return limpiarBusquedaUsuario(value).replace(/[\\%_]/g, '\\$&');
}

function isMissingTableError(error) {
  return error && ['42P01', '42703', 'PGRST205'].includes(error.code);
}

function limpiarCampoNombre(value, max = 80) {
  const cleaned = String(value || '').trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.slice(0, max) : null;
}

function construirNombreLegal(fields) {
  const partes = [fields.first_name, fields.last_name_1, fields.last_name_2]
    .map((value) => limpiarCampoNombre(value))
    .filter(Boolean);
  if (partes.length === 3) return partes.join(' ');
  return limpiarCampoNombre(fields.legal_name || fields.name, 180);
}

function resumenUsuarioSugerido(user) {
  return {
    id: user.id,
    name: user.legal_name || user.name || '',
    phone: user.phone || '',
    email: user.email || '',
    subscription: user.subscription || '',
  };
}

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

async function countQuery(query) {
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
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
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, email, phone, subscription, created_at, preferences, preferencias_extra')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error obteniendo lista de usuarios:', error.message);
        return res.status(500).json({ error: 'Error obteniendo lista de usuarios' });
      }

      const usersSafe = (users || []).map((u) => ({
        id:                 u.id,
        name:               u.name               || '',
        first_name:         u.first_name         || '',
        last_name_1:        u.last_name_1        || '',
        last_name_2:        u.last_name_2        || '',
        legal_name:         u.legal_name         || u.name || '',
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

  app.get('/admin/users/search', requireAdmin, async (req, res) => {
    try {
      const q = limpiarBusquedaUsuario(req.query.q || req.query.name);
      const limit = Math.max(1, Math.min(20, Number(req.query.limit || 8)));

      if (q.length < 2) {
        return res.json({ ok: true, q, ids: [], users: [] });
      }

      const pattern = `%${escaparLike(q)}%`;
      const { data, error } = await supabase
        .from('users')
        .select('id, name, legal_name, phone, email, subscription')
        .or(`name.ilike.${pattern},legal_name.ilike.${pattern}`)
        .order('legal_name', { ascending: true, nullsFirst: false })
        .limit(limit);

      if (error) return res.status(500).json({ error: error.message });

      const users = (data || []).map(resumenUsuarioSugerido);
      return res.json({
        ok: true,
        q,
        ids: users.map((u) => u.id),
        users,
      });
    } catch (err) {
      console.error('Error en /admin/users/search:', err);
      return res.status(500).json({ error: err.message });
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
        updates.legal_name = name || null;
      }

      if (req.body.first_name !== undefined) {
        updates.first_name = limpiarCampoNombre(req.body.first_name);
      }

      if (req.body.last_name_1 !== undefined) {
        updates.last_name_1 = limpiarCampoNombre(req.body.last_name_1);
      }

      if (req.body.last_name_2 !== undefined) {
        updates.last_name_2 = limpiarCampoNombre(req.body.last_name_2);
      }

      if (
        req.body.first_name !== undefined ||
        req.body.last_name_1 !== undefined ||
        req.body.last_name_2 !== undefined
      ) {
        const legalName = construirNombreLegal({
          first_name: updates.first_name ?? req.body.first_name,
          last_name_1: updates.last_name_1 ?? req.body.last_name_1,
          last_name_2: updates.last_name_2 ?? req.body.last_name_2,
          legal_name: req.body.legal_name,
          name: req.body.name,
        });
        updates.legal_name = legalName;
        updates.name = legalName;
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
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, email, phone, subscription, created_at, preferences, preferencias_extra')
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

  app.get('/admin/official-list-matches', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
      const fuente = limpiarBusquedaUsuario(req.query.fuente || '');
      const enviadoRaw = req.query.enviado;

      let query = supabase
        .from('official_list_matches')
        .select(`
          id,
          user_id,
          alerta_id,
          fuente,
          contexto,
          listado_titulo,
          persona_detectada,
          archivo,
          linea,
          url_fuente,
          metadata,
          enviado,
          enviado_at,
          created_at,
          users(id, name, legal_name, phone, subscription),
          alertas(id, titulo, url, fecha, fuente)
        `)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (fuente) query = query.eq('fuente', fuente.toUpperCase());
      if (enviadoRaw === 'true') query = query.eq('enviado', true);
      if (enviadoRaw === 'false') query = query.eq('enviado', false);

      const { data, error } = await query;
      if (error && isMissingTableError(error)) {
        return res.json({
          ok: true,
          missing_table: true,
          message: 'Ejecuta docs/official_list_matches_schema.sql',
          matches: [],
        });
      }
      if (error) return res.status(500).json({ error: error.message });

      return res.json({ ok: true, matches: data || [] });
    } catch (err) {
      console.error('Error en /admin/official-list-matches:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.patch('/admin/official-list-matches/:id', requireAdmin, async (req, res) => {
    try {
      const updates = {};

      if (req.body.enviado !== undefined) {
        updates.enviado = Boolean(req.body.enviado);
        updates.enviado_at = updates.enviado ? new Date().toISOString() : null;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No hay campos para actualizar' });
      }

      const { data, error } = await supabase
        .from('official_list_matches')
        .update(updates)
        .eq('id', req.params.id)
        .select('id, enviado, enviado_at')
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true, match: data });
    } catch (err) {
      console.error('Error en PATCH /admin/official-list-matches/:id:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/overview', requireAdmin, async (req, res) => {
    try {
      const fechaHoy = getFechaMadridISO();
      const { inicio: inicioHoy, fin: inicioManana } = getRangoDiaMadridUTC(fechaHoy);

      const [
        usuariosTotales,
        usuariosConPerfil,
        memoriasHoy,
        feedbackHoy,
        clicksHoy,
        exploracionesPendientes,
        perfilesActualizadosHoy,
        webhookErrores,
        pipelineErrores,
      ] = await Promise.all([
        countQuery(supabase.from('users').select('id', { count: 'exact', head: true })),
        countQuery(supabase.from('users').select('id', { count: 'exact', head: true }).not('perfil_embedding', 'is', null)),
        countQuery(supabase.from('user_memory').select('id', { count: 'exact', head: true }).gte('created_at', inicioHoy).lt('created_at', inicioManana)),
        countQuery(supabase.from('alerta_feedback').select('id', { count: 'exact', head: true }).gte('created_at', inicioHoy).lt('created_at', inicioManana)),
        countQuery(supabase.from('alerta_clicks').select('id', { count: 'exact', head: true }).gte('created_at', inicioHoy).lt('created_at', inicioManana)),
        countQuery(supabase.from('exploration_log').select('id', { count: 'exact', head: true }).eq('procesado', false)),
        countQuery(supabase.from('users').select('id', { count: 'exact', head: true }).gte('perfil_actualizado_at', inicioHoy).lt('perfil_actualizado_at', inicioManana)),
        supabase.from('webhook_events').select('id, created_at, error_msg, result_json', { count: 'exact' }).not('error_msg', 'is', null).order('created_at', { ascending: false }).limit(10),
        supabase.from('pipeline_runs').select('id, stage, endpoint, created_at, status, error_msg', { count: 'exact' }).eq('status', 'error').order('created_at', { ascending: false }).limit(10),
      ]);

      return res.json({
        ok: true,
        fecha: fechaHoy,
        usuarios_totales: usuariosTotales,
        usuarios_con_perfil_embedding: usuariosConPerfil,
        usuarios_sin_perfil_embedding: Math.max(0, usuariosTotales - usuariosConPerfil),
        memorias_hoy: memoriasHoy,
        feedback_hoy: feedbackHoy,
        clicks_hoy: clicksHoy,
        exploraciones_pendientes: exploracionesPendientes,
        perfiles_actualizados_hoy: perfilesActualizadosHoy,
        errores_recientes: {
          webhook: webhookErrores.data || [],
          pipeline: pipelineErrores.data || [],
        },
      });
    } catch (err) {
      console.error('Error en /admin/mia/overview:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/user', requireAdmin, async (req, res) => {
    try {
      const userId = req.query.user_id ? Number(req.query.user_id) : null;
      const phone = req.query.phone ? normalizePhone(req.query.phone) : null;
      const name = limpiarBusquedaUsuario(req.query.name || req.query.q);

      if (!userId && !phone && !name) {
        return res.status(400).json({ error: 'Indica user_id, phone o name' });
      }

      let user = null;
      let userError = null;

      if (userId) {
        const result = await supabase
          .from('users')
          .select(USER_SELECT_ADMIN)
          .eq('id', userId)
          .maybeSingle();
        user = result.data;
        userError = result.error;
      } else if (phone) {
        const result = await supabase
          .from('users')
          .select(USER_SELECT_ADMIN)
          .eq('phone', phone)
          .maybeSingle();
        user = result.data;
        userError = result.error;
      } else {
        const pattern = `%${escaparLike(name)}%`;
        const result = await supabase
          .from('users')
          .select(USER_SELECT_ADMIN)
          .or(`name.ilike.${pattern},legal_name.ilike.${pattern}`)
          .order('legal_name', { ascending: true, nullsFirst: false })
          .limit(8);

        userError = result.error;
        const matches = result.data || [];
        const exactos = matches.filter((u) =>
          String(u.legal_name || u.name || '').trim().toLowerCase() === name.toLowerCase()
        );

        if (!userError && exactos.length === 1) {
          user = exactos[0];
        } else if (!userError && matches.length === 1) {
          user = matches[0];
        } else if (!userError && matches.length > 1) {
          const suggestions = matches.map(resumenUsuarioSugerido);
          return res.status(409).json({
            error: 'Hay varios usuarios con ese nombre. Elige uno por ID.',
            suggestions,
            ids: suggestions.map((u) => u.id),
          });
        }
      }

      if (userError) return res.status(500).json({ error: userError.message });
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const [
        tags,
        memorias,
        feedbacks,
        clicks,
        digests,
        exploracion,
      ] = await Promise.all([
        supabase.from('user_interest_profile').select('tag, score, positivos, negativos, updated_at').eq('user_id', user.id).order('score', { ascending: false }).limit(50),
        supabase.from('user_memory').select('id, tipo, contenido, alerta_id, digest_id, peso_inicial, incorporado_a_embedding, created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
        supabase.from('alerta_feedback').select('id, digest_id, alerta_id, item_numero, valor, raw_text, created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
        supabase.from('alerta_clicks').select('id, digest_id, alerta_id, url_destino, created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
        supabase.from('digests').select('id, fecha, alerta_ids, enviado, enviado_at, created_at, error_msg').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20),
        supabase.from('exploration_log').select('id, digest_id, alerta_id, tipo_exploracion, motivo, resultado, procesado, created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20),
      ]);

      for (const result of [tags, memorias, feedbacks, clicks, digests, exploracion]) {
        if (result.error) throw result.error;
      }

      const tagsData = tags.data || [];

      return res.json({
        ok: true,
        user,
        tags: {
          positivos: tagsData.filter((t) => Number(t.score) > 0).slice(0, 20),
          negativos: tagsData.filter((t) => Number(t.score) < 0).sort((a, b) => Number(a.score) - Number(b.score)).slice(0, 20),
          todos: tagsData,
        },
        memorias: memorias.data || [],
        feedbacks: feedbacks.data || [],
        clicks: clicks.data || [],
        digests: digests.data || [],
        exploracion: exploracion.data || [],
      });
    } catch (err) {
      console.error('Error en /admin/mia/user:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/mia/recalculate', requireAdmin, async (req, res) => {
    try {
      const userId = Number(req.body?.user_id || req.query.user_id);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Indica user_id valido' });
      }

      const resultado = await actualizarPerfilUsuarioMIA(supabase, userId);
      return res.json(resultado);
    } catch (err) {
      console.error('Error en /admin/mia/recalculate:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/activity', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, Number(req.query.hours || 24)));
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 80)));
      const desde = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      const [
        memorias,
        feedbacks,
        clicks,
        conversaciones,
        exploraciones,
        webhook,
      ] = await Promise.all([
        supabase
          .from('user_memory')
          .select('id, user_id, tipo, contenido, alerta_id, digest_id, peso_inicial, incorporado_a_embedding, created_at, users(id, name, phone, subscription)')
          .gte('created_at', desde)
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase
          .from('alerta_feedback')
          .select('id, user_id, digest_id, alerta_id, item_numero, valor, raw_text, created_at, users(id, name, phone, subscription), alertas(id, titulo, fuente)')
          .gte('created_at', desde)
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase
          .from('alerta_clicks')
          .select('id, user_id, digest_id, alerta_id, url_destino, created_at, users(id, name, phone, subscription), alertas(id, titulo, fuente)')
          .gte('created_at', desde)
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase
          .from('user_conversations')
          .select('id, user_id, estado, tipo, digest_id, contexto_json, abierta_at, cerrada_at, expira_at, users(id, name, phone, subscription)')
          .gte('abierta_at', desde)
          .order('abierta_at', { ascending: false })
          .limit(limit),
        supabase
          .from('exploration_log')
          .select('id, user_id, digest_id, alerta_id, tipo_exploracion, motivo, resultado, procesado, created_at, users(id, name, phone, subscription), alertas(id, titulo, fuente)')
          .gte('created_at', desde)
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase
          .from('webhook_events')
          .select('id, created_at, processed, error_msg, result_json, body_json')
          .gte('created_at', desde)
          .order('created_at', { ascending: false })
          .limit(limit),
      ]);

      for (const result of [memorias, feedbacks, clicks, conversaciones, exploraciones, webhook]) {
        if (result.error) throw result.error;
      }

      return res.json({
        ok: true,
        hours,
        memorias: memorias.data || [],
        feedbacks: feedbacks.data || [],
        clicks: clicks.data || [],
        conversaciones: conversaciones.data || [],
        exploraciones: exploraciones.data || [],
        webhook: webhook.data || [],
      });
    } catch (err) {
      console.error('Error en /admin/mia/activity:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/mia/backfill-profiles', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(50, Number(req.body?.limit || req.query.limit || 10)));
      const soloPendientes = String(req.body?.solo_pendientes ?? req.query.solo_pendientes ?? 'true').toLowerCase() !== 'false';
      const params = new URLSearchParams({ limit: String(limit) });
      if (!soloPendientes) params.set('soloPendientes', 'false');
      const result = await hitCronPath(`/cerebro/perfil/backfill?${params.toString()}`);
      return res.json(result);
    } catch (err) {
      console.error('Error en /admin/mia/backfill-profiles:', err);
      return res.status(err.status || 500).json(err.body || { error: err.message });
    }
  });

  app.post('/admin/mia/run-cycle', requireAdmin, async (req, res) => {
    try {
      const params = new URLSearchParams({
        explorar: String(req.body?.explorar ?? false),
        limit: String(Math.max(1, Math.min(200, Number(req.body?.limit || 100)))),
        maxLoops: String(Math.max(1, Math.min(20, Number(req.body?.maxLoops || 1)))),
      });
      const result = await hitCronPath(`/cerebro/ciclo-diario?${params.toString()}`);
      return res.json(result);
    } catch (err) {
      console.error('Error en /admin/mia/run-cycle:', err);
      return res.status(err.status || 500).json(err.body || { error: err.message });
    }
  });

  app.post('/admin/mia/embeddings-alertas', requireAdmin, async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.fecha || req.query.fecha || '')
        ? (req.body?.fecha || req.query.fecha)
        : getFechaMadridISO();
      const params = new URLSearchParams({
        fecha,
        limit: String(Math.max(1, Math.min(200, Number(req.body?.limit || req.query.limit || 100)))),
        maxLoops: String(Math.max(1, Math.min(50, Number(req.body?.maxLoops || req.query.maxLoops || 10)))),
      });
      const result = await hitCronPath(`/cerebro/embeddings/inicializar?${params.toString()}`);
      return res.json(result);
    } catch (err) {
      console.error('Error en /admin/mia/embeddings-alertas:', err);
      return res.status(err.status || 500).json(err.body || { error: err.message });
    }
  });

  app.post('/admin/mia/dry-run-digest', requireAdmin, async (req, res) => {
    try {
      const userId = Number(req.body?.user_id || req.query.user_id);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Indica user_id valido' });
      }

      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.fecha || req.query.fecha || '')
        ? (req.body?.fecha || req.query.fecha)
        : getFechaMadridISO();

      const [diagnostico, preview] = await Promise.all([
        hitCronPath(`/alertas/diagnosticar-digest?user_id=${encodeURIComponent(userId)}&fecha=${encodeURIComponent(fecha)}`),
        supabase
          .from('digests')
          .select('id, user_id, fecha, mensaje, enviado, enviado_at, alerta_ids, created_at, error_msg')
          .eq('user_id', userId)
          .eq('fecha', fecha)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (preview.error) throw preview.error;

      return res.json({
        ok: true,
        fecha,
        user_id: userId,
        digest_existente: preview.data || null,
        diagnostico,
      });
    } catch (err) {
      console.error('Error en /admin/mia/dry-run-digest:', err);
      return res.status(err.status || 500).json(err.body || { error: err.message });
    }
  });

  app.get('/admin/operations/health-deep', requireAdmin, async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const { inicio, fin } = getRangoDiaMadridUTC(fecha);

      const [
        alertasTotal,
        alertasListas,
        alertasPendientesIA,
        alertasConEmbedding,
        digestsPreparados,
        digestsEnviados,
        whatsappFallidos,
        feedbackHoy,
        clicksHoy,
        memoriasHoy,
        conversacionesActivas,
        pipelineRuns,
        scraperRuns,
        webhookErrores,
      ] = await Promise.all([
        countQuery(supabase.from('alertas').select('id', { count: 'exact', head: true }).eq('fecha', fecha)),
        countQuery(supabase.from('alertas').select('id', { count: 'exact', head: true }).eq('fecha', fecha).eq('estado_ia', 'listo').is('duplicado_de', null)),
        countQuery(supabase.from('alertas').select('id', { count: 'exact', head: true }).eq('fecha', fecha).neq('estado_ia', 'listo')),
        countQuery(supabase.from('alertas').select('id', { count: 'exact', head: true }).eq('fecha', fecha).not('embedding', 'is', null)),
        countQuery(supabase.from('digests').select('id', { count: 'exact', head: true }).eq('fecha', fecha)),
        countQuery(supabase.from('digests').select('id', { count: 'exact', head: true }).eq('fecha', fecha).eq('enviado', true)),
        countQuery(supabase.from('whatsapp_logs').select('id', { count: 'exact', head: true }).gte('created_at', inicio).lt('created_at', fin).eq('status', 'failed')),
        countQuery(supabase.from('alerta_feedback').select('id', { count: 'exact', head: true }).gte('created_at', inicio).lt('created_at', fin)),
        countQuery(supabase.from('alerta_clicks').select('id', { count: 'exact', head: true }).gte('created_at', inicio).lt('created_at', fin)),
        countQuery(supabase.from('user_memory').select('id', { count: 'exact', head: true }).gte('created_at', inicio).lt('created_at', fin)),
        countQuery(supabase.from('user_conversations').select('id', { count: 'exact', head: true }).eq('estado', 'activa')),
        supabase.from('pipeline_runs').select('id, stage, endpoint, fecha_objetivo, started_at, finished_at, duration_ms, status, procesadas, errores, error_msg').eq('fecha_objetivo', fecha).order('started_at', { ascending: false }).limit(30),
        supabase.from('scraper_runs').select('id, fuente, endpoint, fecha_objetivo, started_at, finished_at, duration_ms, status, nuevas, duplicadas, errores, error_msg').eq('fecha_objetivo', fecha).order('started_at', { ascending: false }).limit(50),
        supabase.from('webhook_events').select('id, created_at, error_msg, result_json').not('error_msg', 'is', null).order('created_at', { ascending: false }).limit(10),
      ]);

      if (pipelineRuns.error) throw pipelineRuns.error;
      if (scraperRuns.error) throw scraperRuns.error;
      if (webhookErrores.error) throw webhookErrores.error;

      const pipelineErrorCount = (pipelineRuns.data || []).filter((r) => r.status === 'error').length;
      const scraperErrorCount = (scraperRuns.data || []).filter((r) => r.status === 'error' || Number(r.errores || 0) > 0).length;
      const ok =
        pipelineErrorCount === 0 &&
        scraperErrorCount === 0 &&
        whatsappFallidos === 0 &&
        alertasPendientesIA === 0;

      return res.json({
        ok,
        fecha,
        resumen: {
          alertas_total: alertasTotal,
          alertas_listas: alertasListas,
          alertas_pendientes_ia: alertasPendientesIA,
          alertas_con_embedding: alertasConEmbedding,
          digests_preparados: digestsPreparados,
          digests_enviados: digestsEnviados,
          whatsapp_fallidos: whatsappFallidos,
          feedback_hoy: feedbackHoy,
          clicks_hoy: clicksHoy,
          memorias_hoy: memoriasHoy,
          conversaciones_activas: conversacionesActivas,
        },
        pipeline: {
          errores: pipelineErrorCount,
          runs: pipelineRuns.data || [],
        },
        scrapers: {
          errores: scraperErrorCount,
          runs: scraperRuns.data || [],
        },
        webhook_errores_recientes: webhookErrores.data || [],
      });
    } catch (err) {
      console.error('Error en /admin/operations/health-deep:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
