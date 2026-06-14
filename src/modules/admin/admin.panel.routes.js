// src/modules/admin/admin.panel.routes.js
//
// Panel general: dashboard, logs de WhatsApp, digests y registro de auditoria.
// Helpers compartidos en admin.helpers.js.

const { requireAdmin } = require('../../middleware/requireAdmin');
const { normalizePhone } = require('../../shared/phoneNormalizer');
const { getFechaMadridISO, getRangoDiaMadridUTC } = require('../../shared/fechaMadrid');
const { actualizarPerfilUsuarioMIA } = require('../aprendizaje/miaProfile');
const { enviarDigestPro } = require('../../platform/whatsapp');
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
} = require('./auditLog');
const { notificarCambioPlan } = require('../../services/planChangeNotifier');
const {
  construirDatasetRevisionMIA,
  construirReviewRowMIA,
  esTablaRevisionNoDisponible,
} = require('../mia/alertReview');

const {
  PLANES_VALIDOS,
  ORGANIZATION_STATUS_VALIDOS,
  ORGANIZATION_MEMBER_ROLES,
  USER_SELECT_ADMIN,
  limpiarBusquedaUsuario,
  escaparLike,
  isMissingTableError,
  leerVentanaHoras,
  payloadVentanaHoras,
  normalizarAdminUserId,
  getAdminUserIdFromRequest,
  auditarAdmin,
  limpiarCampoNombre,
  construirNombreLegal,
  resumenUsuarioSugerido,
  getPublicBaseUrl,
  crearSlugOrganizacion,
  limpiarJsonPlano,
  limpiarOrganizacionBody,
  hitCronPath,
  countQuery,
  idsNumericosUnicos,
  selectRowsByIds,
  resolverUsuarioAdminDigest,
} = require('./admin.helpers');

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

};
