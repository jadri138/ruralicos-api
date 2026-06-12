const { requireAdmin } = require('../../authMiddleware');
const { normalizePhone } = require('../utils/phoneNormalizer');
const { getFechaMadridISO, getRangoDiaMadridUTC } = require('../utils/fechaMadrid');
const { actualizarPerfilUsuarioMIA } = require('../brain/miaProfile');
const { enviarDigestPro } = require('../whatsapp');
const {
  cargarOutboxPendiente,
  procesarOutboxItemMIA,
  generarOutboxHealthMIA,
} = require('../mia/outbox');
const {
  analizarWebhookEventParaReplay,
  parseJsonObject,
} = require('../mia/replay');
const { resolverPreguntaConBaseConocimientoMIA } = require('../mia/knowledgeBase');
const { generarQualityReportMIA } = require('../mia/qualityReport');
const { generarAnswerAuditMIA } = require('../mia/answerAudit');
const { cargarPerfilOperativoMIA } = require('../mia/userProfile');
const { ejecutarEvalsMIA } = require('../mia/evalHarness');
const { generarReporteCalidadOperativaMIA } = require('../mia/alertQuality');
const {
  ingestKnowledgeDocument,
  normalizeBase64,
} = require('../mia/knowledgeIngest');
const {
  cargarOrganizationContextMIA,
  normalizarOrganizationId,
  obtenerMiaBranding,
} = require('../mia/organizationContext');
const {
  registrarAdminAuditLog,
  getAdminActor,
} = require('../admin/auditLog');
const { notificarCambioPlan } = require('../services/planChangeNotifier');
const {
  construirDatasetRevisionMIA,
  construirReviewRowMIA,
  esTablaRevisionNoDisponible,
} = require('../mia/alertReview');

const PLANES_VALIDOS = ['free', 'corral', 'agricultor', 'cooperativa'];
const ORGANIZATION_STATUS_VALIDOS = ['active', 'paused', 'disabled'];
const ORGANIZATION_MEMBER_ROLES = ['owner', 'admin', 'agent', 'viewer', 'member'];
const USER_SELECT_ADMIN = 'id, name, first_name, last_name_1, last_name_2, legal_name, phone, email, subscription, organization_id, preferences, preferencias_extra, contexto_narrativo, perfil_version, perfil_actualizado_at, ultima_interaccion_at, created_at';

function limpiarBusquedaUsuario(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function escaparLike(value) {
  return limpiarBusquedaUsuario(value).replace(/[\\%_]/g, '\\$&');
}

function isMissingTableError(error) {
  return error && ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(error.code);
}

function normalizarAdminUserId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getAdminUserIdFromRequest(req) {
  return normalizarAdminUserId(req?.admin?.sub || req?.admin?.id || req?.admin?.admin_user_id);
}

async function auditarAdmin(supabase, req, action, resourceType, resourceId, organizationId, metadata = {}) {
  return registrarAdminAuditLog(supabase, {
    req,
    action,
    resourceType,
    resourceId,
    organizationId,
    metadata,
  });
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
    organization_id: user.organization_id || null,
  };
}

function getPublicBaseUrl() {
  return process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

function crearSlugOrganizacion(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || null;
}

function limpiarJsonPlano(value, fallback = {}) {
  if (value === undefined) return undefined;
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') return parseJsonObject(value);
  return fallback;
}

function limpiarOrganizacionBody(body = {}, { partial = false } = {}) {
  const patch = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 180);
    if (!name) throw new Error('name requerido');
    patch.name = name;
  }

  if (body.slug !== undefined || (!partial && patch.name)) {
    patch.slug = crearSlugOrganizacion(body.slug || patch.name);
  }

  if (body.kind !== undefined || !partial) {
    const kind = String(body.kind || 'cooperativa').trim().slice(0, 40);
    patch.kind = kind || 'cooperativa';
  }

  if (body.status !== undefined || !partial) {
    const status = String(body.status || 'active').trim();
    if (!ORGANIZATION_STATUS_VALIDOS.includes(status)) {
      throw new Error('status invalido');
    }
    patch.status = status;
  }

  if (body.branding_json !== undefined || body.branding !== undefined) {
    patch.branding_json = limpiarJsonPlano(body.branding_json ?? body.branding, {});
  }

  if (body.settings_json !== undefined || body.settings !== undefined) {
    patch.settings_json = limpiarJsonPlano(body.settings_json ?? body.settings, {});
  }

  return patch;
}

async function hitCronPath(path) {
  const token = process.env.CRON_TOKEN;
  if (!token) {
    throw new Error('CRON_TOKEN no configurado');
  }

  const baseUrl = getPublicBaseUrl().replace(/\/+$/, '');
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    headers: { 'x-cron-token': token },
  });
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

function idsNumericosUnicos(rows = [], field) {
  return [...new Set((rows || [])
    .map((row) => Number(row?.[field]))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
}

async function selectRowsByIds(supabase, table, select, ids, field = 'id') {
  const cleanIds = [...new Set((ids || [])
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (cleanIds.length === 0) return { data: [], error: null };
  return supabase
    .from(table)
    .select(select)
    .in(field, cleanIds);
}

async function resolverUsuarioAdminDigest(supabase, params = {}) {
  const userId = normalizarAdminUserId(params.user_id);
  const phone = params.phone ? normalizePhone(params.phone) : null;
  const name = limpiarBusquedaUsuario(params.name || params.q);
  const select = 'id, name, legal_name, phone, email, subscription, organization_id';

  if (userId) {
    const { data, error } = await supabase
      .from('users')
      .select(select)
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    return data ? { user: data } : { error: 'Usuario no encontrado', status: 404 };
  }

  if (phone) {
    const { data, error } = await supabase
      .from('users')
      .select(select)
      .eq('phone', phone)
      .maybeSingle();
    if (error) throw error;
    return data ? { user: data } : { error: 'Usuario no encontrado', status: 404 };
  }

  if (name) {
    const pattern = `%${escaparLike(name)}%`;
    const { data, error } = await supabase
      .from('users')
      .select(select)
      .or(`name.ilike.${pattern},legal_name.ilike.${pattern}`)
      .order('legal_name', { ascending: true, nullsFirst: false })
      .limit(8);
    if (error) throw error;

    const matches = data || [];
    const exactos = matches.filter((user) =>
      String(user.legal_name || user.name || '').trim().toLowerCase() === name.toLowerCase()
    );

    if (exactos.length === 1) return { user: exactos[0] };
    if (matches.length === 1) return { user: matches[0] };
    if (matches.length > 1) {
      const suggestions = matches.map(resumenUsuarioSugerido);
      return {
        error: 'Hay varios usuarios con ese nombre. Elige uno por ID.',
        status: 409,
        suggestions,
        ids: suggestions.map((user) => user.id),
      };
    }

    return { error: 'Usuario no encontrado', status: 404 };
  }

  return { error: 'Indica user_id, phone o name', status: 400 };
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
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, email, phone, subscription, organization_id, created_at, preferences, preferencias_extra')
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
        organization_id:    u.organization_id    || null,
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
        .select('id, name, legal_name, phone, email, subscription, organization_id')
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

  app.get('/admin/organizations', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('organizations')
        .select('id, name, slug, kind, status, branding_json, settings_json, created_at, updated_at')
        .order('name', { ascending: true });

      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'organizations_no_disponible', items: [] });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [] });
    } catch (err) {
      console.error('Error en /admin/organizations:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/audit-log', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
      const organizationId = normalizarOrganizationId(req.query.organization_id);
      const action = req.query.action ? String(req.query.action).trim().slice(0, 120) : null;
      const resourceType = req.query.resource_type ? String(req.query.resource_type).trim().slice(0, 120) : null;

      let query = supabase
        .from('admin_audit_log')
        .select('id, admin_user_id, actor_username, organization_id, action, resource_type, resource_id, metadata_json, ip_hash, user_agent, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (organizationId) query = query.eq('organization_id', organizationId);
      if (action) query = query.eq('action', action);
      if (resourceType) query = query.eq('resource_type', resourceType);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'admin_audit_log_no_disponible', items: [] });
        }
        throw error;
      }

      return res.json({
        ok: true,
        available: true,
        actor: getAdminActor(req),
        items: data || [],
      });
    } catch (err) {
      console.error('Error en /admin/audit-log:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/organizations', requireAdmin, async (req, res) => {
    try {
      const row = limpiarOrganizacionBody(req.body || {});
      const { data, error } = await supabase
        .from('organizations')
        .insert(row)
        .select('id, name, slug, kind, status, branding_json, settings_json, created_at, updated_at')
        .single();

      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'organizations_no_disponible' });
        }
        throw error;
      }

      await auditarAdmin(supabase, req, 'organization.create', 'organization', data.id, data.id, {
        name: data.name,
        slug: data.slug,
        status: data.status,
      });

      return res.status(201).json({ ok: true, available: true, item: data });
    } catch (err) {
      const status = /requerido|invalido/i.test(err.message || '') ? 400 : 500;
      console.error('Error en POST /admin/organizations:', err);
      return res.status(status).json({ error: err.message });
    }
  });

  app.patch('/admin/organizations/:id', requireAdmin, async (req, res) => {
    try {
      const id = normalizarOrganizationId(req.params.id);
      if (!id) return res.status(400).json({ error: 'id invalido' });

      const patch = limpiarOrganizacionBody(req.body || {}, { partial: true });
      patch.updated_at = new Date().toISOString();
      if (Object.keys(patch).length <= 1) return res.status(400).json({ error: 'No hay campos para actualizar' });

      const { data, error } = await supabase
        .from('organizations')
        .update(patch)
        .eq('id', id)
        .select('id, name, slug, kind, status, branding_json, settings_json, created_at, updated_at')
        .single();

      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'organizations_no_disponible' });
        }
        throw error;
      }

      await auditarAdmin(supabase, req, 'organization.update', 'organization', data.id, data.id, {
        fields: Object.keys(patch).filter((field) => field !== 'updated_at'),
        status: data.status,
      });

      return res.json({ ok: true, available: true, item: data });
    } catch (err) {
      const status = /requerido|invalido/i.test(err.message || '') ? 400 : 500;
      console.error('Error en PATCH /admin/organizations/:id:', err);
      return res.status(status).json({ error: err.message });
    }
  });

  app.get('/admin/organizations/:id/users', requireAdmin, async (req, res) => {
    try {
      const id = normalizarOrganizationId(req.params.id);
      if (!id) return res.status(400).json({ error: 'id invalido' });

      const [{ data, error }, membersResult] = await Promise.all([
        supabase
        .from('users')
        .select('id, name, legal_name, first_name, phone, email, subscription, organization_id, created_at')
        .eq('organization_id', id)
          .order('created_at', { ascending: false }),
        supabase
          .from('organization_members')
          .select('user_id, role, status, updated_at')
          .eq('organization_id', id),
      ]);

      if (error) throw error;
      if (membersResult.error && !isMissingTableError(membersResult.error)) {
        console.warn('[admin:organizations] No se pudo cargar organization_members:', membersResult.error.message);
      }

      const membersByUserId = new Map(
        (membersResult.error ? [] : membersResult.data || [])
          .map((member) => [Number(member.user_id), member])
      );
      const users = (data || []).map((user) => {
        const member = membersByUserId.get(Number(user.id));
        return {
          ...user,
          member_role: member?.role || null,
          member_status: member?.status || null,
          member_updated_at: member?.updated_at || null,
        };
      });

      return res.json({
        ok: true,
        organization_id: id,
        users,
        member_roles_available: !membersResult.error,
      });
    } catch (err) {
      console.error('Error en /admin/organizations/:id/users:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/organizations/:id/users/:userId', requireAdmin, async (req, res) => {
    try {
      const organizationId = normalizarOrganizationId(req.params.id);
      const userId = Number(req.params.userId);
      if (!organizationId) return res.status(400).json({ error: 'organization id invalido' });
      if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'user id invalido' });

      const role = String(req.body?.role || 'member').trim().slice(0, 40) || 'member';
      if (!ORGANIZATION_MEMBER_ROLES.includes(role)) {
        return res.status(400).json({ error: `role invalido. Opciones: ${ORGANIZATION_MEMBER_ROLES.join(', ')}` });
      }
      const { data: user, error: userError } = await supabase
        .from('users')
        .update({ organization_id: organizationId })
        .eq('id', userId)
        .select(USER_SELECT_ADMIN)
        .single();

      if (userError) throw userError;

      const memberResult = await supabase
        .from('organization_members')
        .upsert({
          organization_id: organizationId,
          user_id: userId,
          role,
          status: 'active',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'organization_id,user_id' })
        .select('organization_id, user_id, role, status')
        .maybeSingle();

      const memberAvailable = !memberResult.error || !isMissingTableError(memberResult.error);
      if (memberResult.error && !isMissingTableError(memberResult.error)) {
        console.warn('[admin:organizations] No se pudo actualizar organization_members:', memberResult.error.message);
      }

      await auditarAdmin(supabase, req, 'organization.user.assign', 'user', userId, organizationId, {
        user_id: userId,
        role,
        member_available: memberAvailable,
      });

      return res.json({
        ok: true,
        organization_id: organizationId,
        user,
        member: memberResult.data || null,
        member_available: memberAvailable,
        member_error: memberResult.error && !isMissingTableError(memberResult.error) ? memberResult.error.message : null,
      });
    } catch (err) {
      console.error('Error en POST /admin/organizations/:id/users/:userId:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/admin/organizations/:id/users/:userId', requireAdmin, async (req, res) => {
    try {
      const organizationId = normalizarOrganizationId(req.params.id);
      const userId = Number(req.params.userId);
      if (!organizationId) return res.status(400).json({ error: 'organization id invalido' });
      if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'user id invalido' });

      const { data: user, error: userError } = await supabase
        .from('users')
        .update({ organization_id: null })
        .eq('id', userId)
        .eq('organization_id', organizationId)
        .select(USER_SELECT_ADMIN)
        .maybeSingle();

      if (userError) throw userError;
      if (!user) return res.status(404).json({ error: 'Usuario no pertenece a esta organizacion' });

      const memberResult = await supabase
        .from('organization_members')
        .update({
          status: 'inactive',
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId)
        .eq('user_id', userId)
        .select('organization_id, user_id, role, status')
        .maybeSingle();

      if (memberResult.error && !isMissingTableError(memberResult.error)) {
        console.warn('[admin:organizations] No se pudo marcar baja en organization_members:', memberResult.error.message);
      }

      await auditarAdmin(supabase, req, 'organization.user.remove', 'user', userId, organizationId, {
        user_id: userId,
        member_available: !memberResult.error,
      });

      return res.json({
        ok: true,
        organization_id: organizationId,
        user,
        member: memberResult.data || null,
        member_available: !memberResult.error,
        member_error: memberResult.error && !isMissingTableError(memberResult.error) ? memberResult.error.message : null,
      });
    } catch (err) {
      console.error('Error en DELETE /admin/organizations/:id/users/:userId:', err);
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
        const subscription = String(req.body.subscription || '').trim().toLowerCase();
        if (!PLANES_VALIDOS.includes(subscription)) {
          return res.status(400).json({ error: `Plan invalido. Opciones: ${PLANES_VALIDOS.join(', ')}` });
        }
        updates.subscription = subscription;
      }

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'organization_id')) {
        const organizationId = normalizarOrganizationId(req.body.organization_id);
        if (req.body.organization_id !== null && req.body.organization_id !== '' && !organizationId) {
          return res.status(400).json({ error: 'organization_id invalido' });
        }
        updates.organization_id = organizationId;
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

      let userAntesPlan = null;
      if (Object.prototype.hasOwnProperty.call(updates, 'subscription')) {
        const { data: previousUser, error: previousError } = await supabase
          .from('users')
          .select('id, phone, name, first_name, legal_name, email, subscription')
          .eq('id', id)
          .single();

        if (previousError || !previousUser) {
          if (previousError) console.error('Error leyendo usuario antes de cambiar plan admin:', previousError.message);
          return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        userAntesPlan = previousUser;
      }

      const { data, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', id)
        .select('id, name, first_name, last_name_1, last_name_2, legal_name, email, phone, subscription, organization_id, created_at, preferences, preferencias_extra')
        .single();

      if (error || !data) {
        console.error('Error actualizando usuario admin:', error?.message);
        return res.status(500).json({ error: 'Error actualizando usuario' });
      }

      const planChangeNotification = userAntesPlan
        ? await notificarCambioPlan({
            user: data,
            planAnterior: userAntesPlan.subscription,
            planNuevo: data.subscription,
          })
        : null;

      await auditarAdmin(supabase, req, 'user.update', 'user', data.id, data.organization_id || updates.organization_id || null, {
        fields: Object.keys(updates),
      });

      return res.json({
        success: true,
        user: data,
        ...(planChangeNotification ? { plan_change_notification: planChangeNotification } : {}),
      });
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
            error: 'Falta crear la tabla scraper_runs. Aplica la migracion operativa en Supabase antes de usar este panel.',
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
            error: 'Falta crear la tabla pipeline_runs. Aplica la migracion operativa en Supabase antes de usar este panel.',
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
          message: 'Falta la tabla official_list_matches. Aplica la migracion operativa en Supabase.',
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

  app.get('/admin/mia/alert-review', requireAdmin, async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
      const userId = req.query.user_id ? Number(req.query.user_id) : null;
      const onlyUnreviewed = String(req.query.only_unreviewed || '').toLowerCase() === 'true';
      const verdict = req.query.verdict ? String(req.query.verdict).trim() : null;

      let digestItemsQuery = supabase
        .from('digest_items')
        .select('digest_id, user_id, fecha, item_numero, alerta_id, score, motivo_seleccion, resumen_usado, tags_json, organization_id')
        .eq('fecha', fecha)
        .order('digest_id', { ascending: false })
        .order('item_numero', { ascending: true })
        .limit(limit);

      if (Number.isSafeInteger(userId) && userId > 0) digestItemsQuery = digestItemsQuery.eq('user_id', userId);
      let digestItemsResult = await digestItemsQuery;

      if (digestItemsResult.error && ['42703', 'PGRST204'].includes(digestItemsResult.error.code)) {
        let fallbackDigestItemsQuery = supabase
          .from('digest_items')
          .select('digest_id, user_id, fecha, item_numero, alerta_id, score, motivo_seleccion, resumen_usado, tags_json')
          .eq('fecha', fecha)
          .order('digest_id', { ascending: false })
          .order('item_numero', { ascending: true })
          .limit(limit);
        if (Number.isSafeInteger(userId) && userId > 0) fallbackDigestItemsQuery = fallbackDigestItemsQuery.eq('user_id', userId);
        digestItemsResult = await fallbackDigestItemsQuery;
      }

      if (digestItemsResult.error) {
        if (isMissingTableError(digestItemsResult.error)) {
          return res.json({
            ok: true,
            available: false,
            reason: 'digest_items_no_disponible',
            fecha,
            items: [],
            summary: {},
          });
        }
        throw digestItemsResult.error;
      }

      const digestItems = digestItemsResult.data || [];

      const alertaIds = idsNumericosUnicos(digestItems, 'alerta_id');
      const userIds = idsNumericosUnicos(digestItems, 'user_id');
      const digestIds = idsNumericosUnicos(digestItems, 'digest_id');

      const [
        alertasResult,
        usersResult,
        feedbacksResult,
        reviewsResult,
      ] = await Promise.all([
        selectRowsByIds(
          supabase,
          'alertas',
          'id, titulo, url, fecha, fuente, region, resumen, resumen_final, contenido, provincias, sectores, subsectores, tipos_alerta, estado_ia, duplicado_de, embedding_generated_at, created_at',
          alertaIds
        ),
        selectRowsByIds(
          supabase,
          'users',
          'id, name, first_name, legal_name, phone, subscription, preferences, preferencias_extra, organization_id',
          userIds
        ),
        digestIds.length
          ? supabase
            .from('alerta_feedback')
            .select('id, user_id, digest_id, alerta_id, item_numero, valor, raw_text, created_at')
            .in('digest_id', digestIds)
          : { data: [], error: null },
        digestIds.length
          ? supabase
            .from('mia_alert_reviews')
            .select('id, digest_item_id, digest_id, user_id, alerta_id, item_numero, organization_id, reviewer_admin_user_id, reviewer_username, verdict, expected_action, reason_codes, notes, expert_version, expert_score, expert_verdict, decision_json, correction_json, reviewed_at, created_at, updated_at')
            .in('digest_id', digestIds)
            .order('reviewed_at', { ascending: false })
          : { data: [], error: null },
      ]);

      for (const result of [alertasResult, usersResult, feedbacksResult]) {
        if (result.error) throw result.error;
      }

      let reviewsAvailable = true;
      let reviews = reviewsResult.data || [];
      if (reviewsResult.error) {
        if (!esTablaRevisionNoDisponible(reviewsResult.error)) throw reviewsResult.error;
        reviewsAvailable = false;
        reviews = [];
      }

      const dataset = construirDatasetRevisionMIA({
        digestItems,
        alertas: alertasResult.data || [],
        users: usersResult.data || [],
        feedbacks: feedbacksResult.data || [],
        reviews,
        onlyUnreviewed,
        verdict,
      });

      return res.json({
        ok: true,
        available: true,
        reviews_available: reviewsAvailable,
        fecha,
        limit,
        only_unreviewed: onlyUnreviewed,
        ...dataset,
      });
    } catch (err) {
      console.error('Error en /admin/mia/alert-review:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/mia/alert-review', requireAdmin, async (req, res) => {
    try {
      const digestId = Number(req.body?.digest_id);
      const userId = Number(req.body?.user_id);
      const alertaId = Number(req.body?.alerta_id);

      if (!Number.isSafeInteger(digestId) || digestId <= 0 ||
          !Number.isSafeInteger(userId) || userId <= 0 ||
          !Number.isSafeInteger(alertaId) || alertaId <= 0) {
        return res.status(400).json({ error: 'digest_id, user_id y alerta_id son obligatorios' });
      }

      const [
        userResult,
        alertaResult,
        digestItemResult,
      ] = await Promise.all([
        supabase
          .from('users')
          .select('id, name, first_name, legal_name, phone, subscription, preferences, preferencias_extra, organization_id')
          .eq('id', userId)
          .maybeSingle(),
        supabase
          .from('alertas')
          .select('id, titulo, url, fecha, fuente, region, resumen, resumen_final, contenido, provincias, sectores, subsectores, tipos_alerta, estado_ia, duplicado_de, embedding_generated_at, created_at')
          .eq('id', alertaId)
          .maybeSingle(),
        supabase
          .from('digest_items')
          .select('digest_id, user_id, fecha, item_numero, alerta_id, score, motivo_seleccion, resumen_usado, tags_json, organization_id')
          .eq('digest_id', digestId)
          .eq('user_id', userId)
          .eq('alerta_id', alertaId)
          .maybeSingle(),
      ]);

      if (userResult.error) throw userResult.error;
      if (alertaResult.error) throw alertaResult.error;
      if (!userResult.data) return res.status(404).json({ error: 'Usuario no encontrado' });
      if (!alertaResult.data) return res.status(404).json({ error: 'Alerta no encontrada' });

      const digestItem = digestItemResult.error ? null : digestItemResult.data;
      const organizationId = normalizarOrganizationId(
        req.body?.organization_id ||
        digestItem?.organization_id ||
        userResult.data.organization_id
      );
      const decisionJson = req.body?.decision_json ||
        req.body?.decision ||
        digestItem?.tags_json?.decision_digest ||
        {};

      const row = construirReviewRowMIA({
        body: {
          ...req.body,
          item_numero: req.body?.item_numero || digestItem?.item_numero,
          organization_id: organizationId,
          decision_json: decisionJson,
        },
        actor: getAdminActor(req),
        alerta: alertaResult.data,
        user: userResult.data,
        organizationId,
      });

      const { data, error } = await supabase
        .from('mia_alert_reviews')
        .upsert(row, { onConflict: 'digest_id,user_id,alerta_id' })
        .select('*')
        .single();

      if (error) {
        if (esTablaRevisionNoDisponible(error)) {
          return res.status(503).json({
            ok: false,
            available: false,
            reason: 'mia_alert_reviews_no_disponible',
            message: 'Falta crear la tabla mia_alert_reviews en Supabase.',
          });
        }
        throw error;
      }

      await auditarAdmin(supabase, req, 'mia_alert_review.upsert', 'mia_alert_review', data.id || `${digestId}:${userId}:${alertaId}`, organizationId, {
        digest_id: digestId,
        user_id: userId,
        alerta_id: alertaId,
        verdict: row.verdict,
        expected_action: row.expected_action,
        reason_codes: row.reason_codes,
      });

      return res.json({ ok: true, review: data });
    } catch (err) {
      console.error('Error en POST /admin/mia/alert-review:', err);
      const isValidation = /obligatorio|invalido/i.test(err.message || '');
      return res.status(isValidation ? 400 : 500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/inbound', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
      const status = req.query.status ? String(req.query.status).trim() : null;

      let query = supabase
        .from('mia_inbound_messages')
        .select('id, source, external_message_id, from_phone, from_raw, chat_id, sender_kind, event_type, text_body, status, ignored_reason, user_id, organization_id, digest_id, conversation_id, decision_json, result_json, error_msg, duplicate_count, first_seen_at, last_seen_at, processed_at, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_inbound_messages_no_disponible', items: [] });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [] });
    } catch (err) {
      console.error('Error en /admin/mia/inbound:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/structured-memory', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
      const userId = req.query.user_id ? Number(req.query.user_id) : null;

      let query = supabase
        .from('mia_structured_memory')
        .select('id, user_id, organization_id, digest_id, inbound_id, source, memory_type, topic, detail, polarity, confidence, evidence, decision_version, metadata_json, incorporated_at, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (Number.isInteger(userId) && userId > 0) query = query.eq('user_id', userId);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_structured_memory_no_disponible', items: [] });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [] });
    } catch (err) {
      console.error('Error en /admin/mia/structured-memory:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/outbox', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
      const status = req.query.status ? String(req.query.status).trim() : null;

      let query = supabase
        .from('mia_outbox')
        .select('id, decision_id, inbound_id, user_id, organization_id, channel, to_phone, body, status, attempts, last_error, next_attempt_at, sent_at, metadata_json, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_outbox_no_disponible', items: [] });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [] });
    } catch (err) {
      console.error('Error en /admin/mia/outbox:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/outbox-health', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(720, Number(req.query.hours || 72)));
      const limit = Math.max(50, Math.min(5000, Number(req.query.limit || 1000)));
      const report = await generarOutboxHealthMIA(supabase, { hours, limit });
      return res.json({ ok: report.ok !== false, ...report, params: { hours, limit } });
    } catch (err) {
      console.error('Error en /admin/mia/outbox-health:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/decisions', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
      const intent = req.query.intent ? String(req.query.intent).trim() : null;
      const userId = req.query.user_id ? Number(req.query.user_id) : null;

      let query = supabase
        .from('mia_decisions')
        .select('id, inbound_id, user_id, organization_id, digest_id, conversation_id, decision_version, intent, confidence, risk_flags, summary, decision_json, result_json, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (intent) query = query.eq('intent', intent);
      if (Number.isInteger(userId) && userId > 0) query = query.eq('user_id', userId);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_decisions_no_disponible', items: [] });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [] });
    } catch (err) {
      console.error('Error en /admin/mia/decisions:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/actions', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
      const status = req.query.status ? String(req.query.status).trim() : null;
      const actionType = req.query.action_type ? String(req.query.action_type).trim() : null;

      let query = supabase
        .from('mia_actions')
        .select('id, decision_id, inbound_id, user_id, organization_id, digest_id, action_type, status, action_json, result_json, error_msg, created_at, executed_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) query = query.eq('status', status);
      if (actionType) query = query.eq('action_type', actionType);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_actions_no_disponible', items: [] });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [] });
    } catch (err) {
      console.error('Error en /admin/mia/actions:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/agent-cases', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
      const status = req.query.status ? String(req.query.status).trim() : null;
      const userId = req.query.user_id ? Number(req.query.user_id) : null;

      let query = supabase
        .from('mia_agent_cases')
        .select('id, user_id, organization_id, inbound_id, decision_id, digest_id, conversation_id, status, priority, reason, question_text, summary, assigned_to, assigned_to_admin_user_id, resolution_text, decision_json, metadata_json, created_at, updated_at, closed_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) query = query.eq('status', status);
      if (Number.isInteger(userId) && userId > 0) query = query.eq('user_id', userId);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_agent_cases_no_disponible', items: [] });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [] });
    } catch (err) {
      console.error('Error en /admin/mia/agent-cases:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/knowledge-search', requireAdmin, async (req, res) => {
    try {
      const texto = String(req.query.q || req.query.texto || '').trim();
      if (!texto) return res.status(400).json({ error: 'Falta q o texto' });

      const limit = Math.max(1, Math.min(10, Number(req.query.limit || 5)));
      const organizationId = req.query.organization_id ? Number(req.query.organization_id) : null;
      const organizationContext = Number.isInteger(organizationId) && organizationId > 0
        ? await cargarOrganizationContextMIA(supabase, { organization_id: organizationId })
        : null;
      const result = await resolverPreguntaConBaseConocimientoMIA(supabase, {
        texto,
        limit,
        organizationId: Number.isInteger(organizationId) && organizationId > 0 ? organizationId : null,
        organizationContext,
      });

      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Error en /admin/mia/knowledge-search:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/knowledge-documents', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 80)));
      const organizationId = normalizarOrganizationId(req.query.organization_id);

      let query = supabase
        .from('mia_knowledge_documents')
        .select('id, organization_id, titulo, categoria, fuente, fuente_tipo, url, fecha_documento, version, status, metadata_json, created_at, updated_at')
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (organizationId) query = query.eq('organization_id', organizationId);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_knowledge_documents_no_disponible', items: [] });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [] });
    } catch (err) {
      console.error('Error en /admin/mia/knowledge-documents:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/mia/knowledge-upload', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const fileName = String(body.file_name || body.fileName || '').trim();
      const fileBase64 = normalizeBase64(body.file_base64 || body.fileBase64 || body.content_base64 || '');
      const title = String(body.title || body.titulo || '').trim();
      const category = String(body.category || body.categoria || '').trim();

      if (!fileName) return res.status(400).json({ error: 'file_name requerido' });
      if (!fileBase64) return res.status(400).json({ error: 'file_base64 requerido' });
      if (!title) return res.status(400).json({ error: 'title requerido' });
      if (!category) return res.status(400).json({ error: 'category requerida' });

      const buffer = Buffer.from(fileBase64, 'base64');
      if (!buffer.length) return res.status(400).json({ error: 'Archivo vacio' });
      if (buffer.length > 18 * 1024 * 1024) {
        return res.status(413).json({ error: 'Archivo demasiado grande. Maximo 18 MB.' });
      }

      const result = await ingestKnowledgeDocument(supabase, {
        buffer,
        fileName,
        title,
        category,
        source: body.source || body.fuente || null,
        sourceType: body.source_type || body.fuente_tipo || 'manual',
        url: body.url || null,
        date: body.date || body.fecha_documento || null,
        version: body.version || null,
        organizationId: normalizarOrganizationId(body.organization_id),
        chunkWords: body.chunk_words || body.chunkWords,
        overlapWords: body.overlap_words || body.overlapWords,
        useMockEmbeddings: body.mock === true,
        dryRun: body.dry_run === true,
      });

      return res.json(result);
    } catch (err) {
      console.error('Error en /admin/mia/knowledge-upload:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.patch('/admin/mia/agent-cases/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id invalido' });

      const status = req.body?.status ? String(req.body.status).trim() : null;
      const allowedStatus = new Set(['open', 'in_progress', 'resolved', 'dismissed']);
      const patch = {
        updated_at: new Date().toISOString(),
      };

      if (status) {
        if (!allowedStatus.has(status)) return res.status(400).json({ error: 'status invalido' });
        patch.status = status;
        if (['resolved', 'dismissed'].includes(status)) patch.closed_at = new Date().toISOString();
        if (['open', 'in_progress'].includes(status)) patch.closed_at = null;
      }

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'assigned_to')) {
        patch.assigned_to = String(req.body.assigned_to || '').trim().slice(0, 120) || null;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'assigned_to_admin_user_id')) {
        const assignedId = req.body.assigned_to_admin_user_id === null || req.body.assigned_to_admin_user_id === ''
          ? null
          : normalizarAdminUserId(req.body.assigned_to_admin_user_id);
        if (req.body.assigned_to_admin_user_id !== null && req.body.assigned_to_admin_user_id !== '' && !assignedId) {
          return res.status(400).json({ error: 'assigned_to_admin_user_id invalido' });
        }
        patch.assigned_to_admin_user_id = assignedId;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'resolution_text')) {
        patch.resolution_text = String(req.body.resolution_text || '').trim().slice(0, 2000) || null;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'priority')) {
        const priority = String(req.body.priority || '').trim();
        const allowedPriority = new Set(['baja', 'normal', 'media', 'alta', 'critica']);
        if (!allowedPriority.has(priority)) return res.status(400).json({ error: 'priority invalida' });
        patch.priority = priority;
      }

      const { data, error } = await supabase
        .from('mia_agent_cases')
        .update(patch)
        .eq('id', id)
        .select('id, user_id, organization_id, status, priority, reason, assigned_to, assigned_to_admin_user_id, resolution_text, updated_at, closed_at')
        .single();

      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_agent_cases_no_disponible' });
        }
        throw error;
      }

      await auditarAdmin(supabase, req, 'mia_agent_case.update', 'mia_agent_case', data.id, data.organization_id || null, {
        fields: Object.keys(patch).filter((field) => field !== 'updated_at'),
        status: data.status,
        priority: data.priority,
      });

      return res.json({ ok: true, available: true, item: data });
    } catch (err) {
      console.error('Error en PATCH /admin/mia/agent-cases/:id:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/mia/agent-cases/:id/reply', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id invalido' });

      const texto = String(req.body?.texto || req.body?.message || '').trim();
      if (texto.length < 2) return res.status(400).json({ error: 'texto requerido' });
      if (texto.length > 2500) return res.status(400).json({ error: 'texto demasiado largo' });

      const dryRun = req.body?.dry_run === true || req.query.dry_run === 'true';
      const { data: caso, error: caseError } = await supabase
        .from('mia_agent_cases')
        .select('id, user_id, organization_id, inbound_id, decision_id, digest_id, conversation_id, status, priority, reason, question_text, summary, metadata_json')
        .eq('id', id)
        .maybeSingle();

      if (caseError) {
        if (isMissingTableError(caseError)) {
          return res.json({ ok: true, available: false, reason: 'mia_agent_cases_no_disponible' });
        }
        throw caseError;
      }
      if (!caso?.id) return res.status(404).json({ error: 'caso_no_encontrado' });

      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, phone, name, first_name, organization_id')
        .eq('id', caso.user_id)
        .maybeSingle();

      if (userError) throw userError;
      if (!user?.phone) return res.status(400).json({ error: 'usuario_sin_telefono' });

      const phone = normalizePhone(user.phone);
      const organizationId = normalizarOrganizationId(caso.organization_id || user.organization_id);
      const organizationContext = await cargarOrganizationContextMIA(supabase, { organization_id: organizationId });
      const branding = obtenerMiaBranding(organizationContext);
      const assignedTo = String(req.body?.assigned_to || branding.reply_sender || 'Ruralicos').trim().slice(0, 120) || 'Ruralicos';
      let assignedToAdminUserId = getAdminUserIdFromRequest(req);
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'assigned_to_admin_user_id')) {
        assignedToAdminUserId = req.body.assigned_to_admin_user_id === null || req.body.assigned_to_admin_user_id === ''
          ? null
          : normalizarAdminUserId(req.body.assigned_to_admin_user_id);
        if (req.body.assigned_to_admin_user_id !== null && req.body.assigned_to_admin_user_id !== '' && !assignedToAdminUserId) {
          return res.status(400).json({ error: 'assigned_to_admin_user_id invalido' });
        }
      }
      const prefix = `Respuesta de ${branding.reply_sender}`;
      const body = texto.toLowerCase().startsWith(String(branding.reply_sender || '').toLowerCase())
        ? texto
        : `${prefix}:\n${texto}`;

      if (dryRun) {
        return res.json({
          ok: true,
          dry_run: true,
          available: true,
          case_id: caso.id,
          user_id: user.id,
          phone,
          body,
        });
      }

      await enviarDigestPro(phone, body);

      const now = new Date().toISOString();
      const metadata = parseJsonObject(caso.metadata_json);
      const { data: updatedCase, error: updateCaseError } = await supabase
        .from('mia_agent_cases')
        .update({
          status: 'resolved',
          assigned_to: assignedTo,
          assigned_to_admin_user_id: assignedToAdminUserId,
          resolution_text: texto,
          metadata_json: {
            ...metadata,
            agent_reply: {
              sent_at: now,
              channel: 'whatsapp',
              phone,
              assigned_to: assignedTo,
              assigned_to_admin_user_id: assignedToAdminUserId,
              organization_id: organizationId || null,
              reply_sender: branding.reply_sender,
            },
          },
          updated_at: now,
          closed_at: now,
        })
        .eq('id', caso.id)
        .select('id, organization_id, status, assigned_to, assigned_to_admin_user_id, resolution_text, updated_at, closed_at')
        .single();

      if (updateCaseError) throw updateCaseError;

      await auditarAdmin(supabase, req, 'mia_agent_case.reply', 'mia_agent_case', caso.id, organizationId, {
        user_id: user.id,
        inbound_id: caso.inbound_id || null,
        decision_id: caso.decision_id || null,
        sent: true,
        channel: 'whatsapp',
      });

      const { error: conversationError } = await supabase
        .from('user_conversations')
        .update({
          estado: 'resuelta',
          cerrada_at: now,
        })
        .eq('user_id', user.id)
        .eq('tipo', 'respuesta_consulta')
        .eq('estado', 'activa');

      if (conversationError && !isMissingTableError(conversationError)) {
        console.warn('[mia:agent_reply] No se pudo cerrar conversacion agente:', conversationError.message);
      }

      return res.json({
        ok: true,
        dry_run: false,
        available: true,
        sent: true,
        case: updatedCase,
        user: {
          id: user.id,
          phone,
          name: user.first_name || user.name || null,
        },
      });
    } catch (err) {
      console.error('Error en POST /admin/mia/agent-cases/:id/reply:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/console', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, Number(req.query.hours || 24)));
      const desde = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      async function safeCount(query, key) {
        const { count, error } = await query;
        if (error) {
          if (isMissingTableError(error)) return { key, available: false, count: 0 };
          throw error;
        }
        return { key, available: true, count: count || 0 };
      }

      const counts = await Promise.all([
        safeCount(supabase.from('mia_inbound_messages').select('id', { count: 'exact', head: true }).gte('created_at', desde), 'inbound_total'),
        safeCount(supabase.from('mia_inbound_messages').select('id', { count: 'exact', head: true }).eq('status', 'processed').gte('created_at', desde), 'inbound_processed'),
        safeCount(supabase.from('mia_inbound_messages').select('id', { count: 'exact', head: true }).eq('status', 'ignored').gte('created_at', desde), 'inbound_ignored'),
        safeCount(supabase.from('mia_inbound_messages').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', desde), 'inbound_failed'),
        safeCount(supabase.from('mia_decisions').select('id', { count: 'exact', head: true }).gte('created_at', desde), 'decisions_total'),
        safeCount(supabase.from('mia_actions').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', desde), 'actions_failed'),
        safeCount(supabase.from('mia_outbox').select('id', { count: 'exact', head: true }).in('status', ['queued', 'failed']), 'outbox_pending'),
        safeCount(supabase.from('mia_structured_memory').select('id', { count: 'exact', head: true }).gte('created_at', desde), 'structured_memory_new'),
        safeCount(supabase.from('mia_agent_cases').select('id', { count: 'exact', head: true }).in('status', ['open', 'in_progress']), 'agent_cases_open'),
      ]);

      const byKey = Object.fromEntries(counts.map((item) => [item.key, item.count]));
      const available = counts.every((item) => item.available);

      const [
        decisionsRecent,
        outboxRecent,
        inboundFailed,
        webhookReplay,
        agentCases,
      ] = await Promise.all([
        supabase
          .from('mia_decisions')
          .select('id, user_id, intent, confidence, risk_flags, summary, created_at')
          .gte('created_at', desde)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('mia_outbox')
          .select('id, user_id, to_phone, status, attempts, last_error, next_attempt_at, created_at')
          .in('status', ['queued', 'failed'])
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('mia_inbound_messages')
          .select('id, from_phone, status, ignored_reason, error_msg, text_body, created_at')
          .eq('status', 'failed')
          .gte('created_at', desde)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('webhook_events')
          .select('id, source, processed, result_json, error_msg, body_json, created_at')
          .eq('source', 'ultramsg')
          .eq('processed', false)
          .gte('created_at', desde)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('mia_agent_cases')
          .select('id, user_id, status, priority, reason, question_text, summary, created_at')
          .in('status', ['open', 'in_progress'])
          .order('created_at', { ascending: false })
          .limit(20),
      ]);

      const optional = (result, fallback = []) => {
        if (result.error && isMissingTableError(result.error)) return fallback;
        if (result.error) throw result.error;
        return result.data || fallback;
      };
      const replayCandidates = optional(webhookReplay)
        .map((event) => analizarWebhookEventParaReplay(event))
        .filter((candidate) => candidate.eligible);
      byKey.replay_candidates = replayCandidates.length;

      return res.json({
        ok: byKey.inbound_failed === 0 && byKey.actions_failed === 0 && byKey.replay_candidates === 0,
        available,
        hours,
        metrics: byKey,
        recent: {
          decisions: optional(decisionsRecent),
          outbox_pending: optional(outboxRecent),
          inbound_failed: optional(inboundFailed),
          agent_cases: optional(agentCases),
          replay_candidates: replayCandidates.slice(0, 20),
        },
      });
    } catch (err) {
      console.error('Error en /admin/mia/console:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/quality-report', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(720, Number(req.query.hours || 24)));
      const limit = Math.max(50, Math.min(2000, Number(req.query.limit || 500)));
      const report = await generarQualityReportMIA(supabase, { hours, limit });
      return res.json({ ok: true, ...report });
    } catch (err) {
      console.error('Error en /admin/mia/quality-report:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/answer-audit', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(720, Number(req.query.hours || 72)));
      const limit = Math.max(50, Math.min(3000, Number(req.query.limit || 500)));
      const report = await generarAnswerAuditMIA(supabase, { hours, limit });
      return res.json({ ok: report.ok !== false, ...report, params: { hours, limit } });
    } catch (err) {
      console.error('Error en /admin/mia/answer-audit:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/profile', requireAdmin, async (req, res) => {
    try {
      const userId = req.query.user_id ? Number(req.query.user_id) : null;
      const phone = req.query.phone ? normalizePhone(String(req.query.phone)) : null;
      if ((!Number.isInteger(userId) || userId <= 0) && !phone) {
        return res.status(400).json({ error: 'Indica user_id o phone' });
      }

      let user = null;
      if (Number.isInteger(userId) && userId > 0) {
        const { data, error } = await supabase
          .from('users')
          .select('id, name, first_name, subscription, preferences, preferencias_extra, contexto_narrativo, organization_id')
          .eq('id', userId)
          .maybeSingle();
        if (error) throw error;
        user = data;
      } else if (phone) {
        const { data, error } = await supabase
          .from('users')
          .select('id, name, first_name, subscription, preferences, preferencias_extra, contexto_narrativo, organization_id')
          .eq('phone', phone)
          .maybeSingle();
        if (error) throw error;
        user = data;
      }

      if (!user?.id) return res.status(404).json({ error: 'usuario_no_encontrado' });

      const profile = await cargarPerfilOperativoMIA(supabase, user.id, { user });
      return res.json({ ok: true, profile });
    } catch (err) {
      console.error('Error en /admin/mia/profile:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/evals', requireAdmin, async (req, res) => {
    try {
      const includeDetails = String(req.query.details || 'false').toLowerCase() === 'true';
      const report = ejecutarEvalsMIA();
      if (!includeDetails) {
        return res.json({
          ok: report.ok,
          scenarios_total: report.scenarios_total,
          scenarios_passed: report.scenarios_passed,
          checks_total: report.checks_total,
          checks_failed: report.checks_failed,
          failed_checks: report.failed_checks,
        });
      }
      return res.json(report);
    } catch (err) {
      console.error('Error en /admin/mia/evals:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/mia/replay-candidates', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(720, Number(req.query.hours || 168)));
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
      const includeRaw = req.query.include_raw === 'true';
      const includeProcessed = req.query.include_processed === 'true';
      const soloElegibles = req.query.only_eligible === 'true';
      const desde = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      let query = supabase
        .from('webhook_events')
        .select('id, source, processed, result_json, error_msg, body_json, created_at')
        .eq('source', 'ultramsg')
        .gte('created_at', desde);

      if (!includeProcessed) query = query.eq('processed', false);
      query = query
        .order('created_at', { ascending: false })
        .limit(limit);

      const { data, error } = await query;
      if (error) throw error;

      let items = (data || []).map((event) => analizarWebhookEventParaReplay(event, { includeRaw }));
      if (soloElegibles) items = items.filter((item) => item.eligible);

      const reasons = {};
      for (const item of items) {
        const key = item.reason || 'sin_reason';
        reasons[key] = (reasons[key] || 0) + 1;
      }

      return res.json({
        ok: true,
        hours,
        include_processed: includeProcessed,
        include_raw: includeRaw,
        total: items.length,
        elegibles: items.filter((item) => item.eligible).length,
        forceables: items.filter((item) => item.forceable).length,
        reasons,
        items,
      });
    } catch (err) {
      console.error('Error en /admin/mia/replay-candidates:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/mia/replay-webhook-events', requireAdmin, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
        : [];
      const hours = Math.max(1, Math.min(720, Number(req.body?.hours || req.query.hours || 168)));
      const limit = Math.max(1, Math.min(50, Number(req.body?.limit || req.query.limit || 10)));
      const force = req.body?.force === true || req.query.force === 'true';
      const dryRun = req.body?.dry_run !== false && req.query.dry_run !== 'false';
      const desde = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      let query = supabase
        .from('webhook_events')
        .select('id, source, processed, result_json, error_msg, body_json, created_at')
        .eq('source', 'ultramsg')
        .eq('processed', false);

      if (ids.length > 0) {
        query = query.in('id', ids);
      } else {
        query = query.gte('created_at', desde);
      }
      query = query
        .order('created_at', { ascending: true })
        .limit(limit);

      const { data, error } = await query;
      if (error) throw error;

      const eventos = data || [];
      const candidatos = eventos
        .map((event) => ({
          event,
          candidate: analizarWebhookEventParaReplay(event, { includeRaw: true }),
        }))
        .filter(({ candidate }) => force ? (candidate.eligible || candidate.forceable) : candidate.eligible);

      if (dryRun) {
        return res.json({
          ok: true,
          dry_run: true,
          force,
          encontrados: eventos.length,
          replayables: candidatos.length,
          items: candidatos.map(({ candidate }) => candidate),
        });
      }

      if (req.body?.confirm !== 'REPLAY') {
        return res.status(400).json({
          error: 'Para ejecutar replay real envia dry_run=false y confirm="REPLAY".',
          encontrados: eventos.length,
          replayables: candidatos.length,
        });
      }

      const webhookToken = String(process.env.ULTRAMSG_WEBHOOK_TOKEN || '').trim();
      if (!webhookToken) {
        return res.status(503).json({ error: 'ULTRAMSG_WEBHOOK_TOKEN no configurado. Replay real bloqueado.' });
      }

      const baseUrl = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      const replayUrl = `${baseUrl}/webhooks/ultramsg/feedback`;
      const resultados = [];

      for (const { event, candidate } of candidatos) {
        try {
          const response = await fetch(replayUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-ruralicos-webhook-token': webhookToken,
            },
            body: JSON.stringify(event.body_json || {}),
          });
          const raw = await response.text();
          let body = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = { raw: raw.slice(0, 2000) };
          }

          const ok = response.ok && body?.ok !== false;
          const originalResult = parseJsonObject(event.result_json);
          await supabase
            .from('webhook_events')
            .update({
              processed: ok,
              result_json: {
                ...originalResult,
                replay: {
                  attempted_at: new Date().toISOString(),
                  ok,
                  http_status: response.status,
                  response: body,
                },
              },
              error_msg: ok ? null : `Replay fallo HTTP ${response.status}`,
            })
            .eq('id', event.id);

          resultados.push({
            id: event.id,
            ok,
            http_status: response.status,
            reason: candidate.reason,
            response: body,
          });
        } catch (errReplay) {
          await supabase
            .from('webhook_events')
            .update({
              result_json: {
                ...parseJsonObject(event.result_json),
                replay: {
                  attempted_at: new Date().toISOString(),
                  ok: false,
                  error: errReplay.message,
                },
              },
              error_msg: `Replay fallo: ${errReplay.message}`.slice(0, 1000),
            })
            .eq('id', event.id);

          resultados.push({
            id: event.id,
            ok: false,
            reason: candidate.reason,
            error: errReplay.message,
          });
        }
      }

      return res.json({
        ok: resultados.every((item) => item.ok),
        dry_run: false,
        force,
        encontrados: eventos.length,
        replayables: candidatos.length,
        procesados: resultados.length,
        exitosos: resultados.filter((item) => item.ok).length,
        fallidos: resultados.filter((item) => !item.ok).length,
        resultados,
      });
    } catch (err) {
      console.error('Error en /admin/mia/replay-webhook-events:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/mia/outbox/send-pending', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(50, Number(req.body?.limit || req.query.limit || 20)));
      const dryRun = req.body?.dry_run === true || req.query.dry_run === 'true';
      const pendientes = await cargarOutboxPendiente(supabase, limit);

      if (!pendientes.available) {
        return res.json({ ok: true, available: false, reason: pendientes.reason, enviados: 0, items: [] });
      }
      if (!pendientes.ok) return res.status(500).json({ ok: false, error: pendientes.error });

      const resultados = [];
      for (const item of pendientes.items) {
        if (dryRun) {
          resultados.push({ id: item.id, dry_run: true, to_phone: item.to_phone, body: item.body });
          continue;
        }

        const result = await procesarOutboxItemMIA(supabase, item, enviarDigestPro);
        resultados.push(result);
      }

      return res.json({
        ok: resultados.every((item) => item.ok !== false),
        available: true,
        dry_run: dryRun,
        procesados: resultados.length,
        enviados: resultados.filter((item) => item.status === 'sent').length,
        fallidos: resultados.filter((item) => item.ok === false).length,
        omitidos: resultados.filter((item) => item.skipped).length,
        resultados,
      });
    } catch (err) {
      console.error('Error en /admin/mia/outbox/send-pending:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/operations/scrapers-quality', requireAdmin, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(30, Number(req.query.days || 7)));
      const desde = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('scraper_runs')
        .select('id, fuente, endpoint, fecha_objetivo, started_at, finished_at, duration_ms, status, http_status, nuevas, duplicadas, errores, relevantes, error_msg')
        .gte('started_at', desde)
        .order('started_at', { ascending: false })
        .limit(2000);

      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'scraper_runs_no_disponible', fuentes: [] });
        }
        throw error;
      }

      const porFuente = new Map();
      for (const run of data || []) {
        const fuente = run.fuente || run.endpoint || 'desconocida';
        if (!porFuente.has(fuente)) {
          porFuente.set(fuente, {
            fuente,
            runs: 0,
            ok: 0,
            warnings: 0,
            errors: 0,
            nuevas: 0,
            duplicadas: 0,
            errores_reportados: 0,
            relevantes: 0,
            ultimo_run_at: null,
            ultimo_ok_at: null,
            ultimo_error: null,
            duracion_media_ms: 0,
            flags: [],
          });
        }

        const item = porFuente.get(fuente);
        item.runs++;
        item.nuevas += Number(run.nuevas || 0);
        item.duplicadas += Number(run.duplicadas || 0);
        item.errores_reportados += Number(run.errores || 0);
        item.relevantes += Number(run.relevantes || 0);
        item.duracion_media_ms += Number(run.duration_ms || 0);
        item.ultimo_run_at = item.ultimo_run_at || run.started_at;

        if (run.status === 'ok') {
          item.ok++;
          item.ultimo_ok_at = item.ultimo_ok_at || run.started_at;
        } else if (run.status === 'warning') {
          item.warnings++;
        } else if (run.status === 'error') {
          item.errors++;
          item.ultimo_error = item.ultimo_error || run.error_msg || `HTTP ${run.http_status || 'desconocido'}`;
        }
      }

      const fuentes = [...porFuente.values()].map((item) => {
        item.duracion_media_ms = item.runs ? Math.round(item.duracion_media_ms / item.runs) : 0;
        if (item.ok === 0) item.flags.push('sin_ok_reciente');
        if (item.errors > 0) item.flags.push('errores_recientes');
        if (item.runs >= 2 && item.nuevas === 0 && item.duplicadas === 0) item.flags.push('sin_volumen');
        if (item.duplicadas > item.nuevas * 5 && item.duplicadas > 20) item.flags.push('duplicados_altos');
        if (item.errores_reportados > 0) item.flags.push('errores_en_respuesta');
        return item;
      });

      return res.json({
        ok: fuentes.every((fuente) => fuente.flags.length === 0),
        available: true,
        days,
        total_runs: (data || []).length,
        fuentes: fuentes.sort((a, b) => b.flags.length - a.flags.length || a.fuente.localeCompare(b.fuente)),
      });
    } catch (err) {
      console.error('Error en /admin/operations/scrapers-quality:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  async function handleOperationalDataQuality(req, res) {
    try {
      const days = Math.max(1, Math.min(60, Number(req.query.days || 7)));
      const limit = Math.max(100, Math.min(5000, Number(req.query.limit || 1000)));
      const fecha = req.query.fecha ? String(req.query.fecha).trim() : null;

      if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return res.status(400).json({ error: 'fecha debe tener formato YYYY-MM-DD' });
      }

      const report = await generarReporteCalidadOperativaMIA(supabase, {
        days,
        fecha,
        limit,
      });

      return res.json({
        ...report,
        params: { days, fecha, limit },
      });
    } catch (err) {
      console.error('Error en /admin/operations/data-quality:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  app.get('/admin/operations/data-quality', requireAdmin, handleOperationalDataQuality);
  app.get('/admin/operations/alerts-quality', requireAdmin, handleOperationalDataQuality);

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
      const resolved = await resolverUsuarioAdminDigest(supabase, {
        user_id: req.body?.user_id || req.query.user_id,
        phone: req.body?.phone || req.query.phone,
        name: req.body?.name || req.query.name,
        q: req.body?.q || req.query.q,
      });

      if (!resolved.user) {
        return res.status(resolved.status || 400).json({
          error: resolved.error || 'Usuario no encontrado',
          ...(resolved.suggestions ? { suggestions: resolved.suggestions, ids: resolved.ids } : {}),
        });
      }

      const userId = resolved.user.id;

      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.fecha || req.query.fecha || '')
        ? (req.body?.fecha || req.query.fecha)
        : getFechaMadridISO();

      const params = new URLSearchParams({
        user_id: String(userId),
        fecha,
        ia: String(req.body?.ia ?? req.query.ia ?? false),
        rescate: String(req.body?.rescate ?? req.query.rescate ?? true),
      });
      const preview = await hitCronPath(`/alertas/preview-digest?${params.toString()}`);

      return res.json({
        ok: true,
        fecha,
        user_id: userId,
        user: resumenUsuarioSugerido(resolved.user),
        preview,
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
