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
  analizarAlcanceAudiencia,
  calcularCuotaDominanciaDigest,
  registrarSnapshotAlcance,
} = require('../alertas/seleccion/audienceReach');
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
} = require('../mia/alertReview');
const {
  construirWhyNotSentResponse,
  construirWhySentDigest,
  normalizarDigestExplainParams,
} = require('./digestExplain');

const {
  PLANES_VALIDOS,
  ORGANIZATION_STATUS_VALIDOS,
  ORGANIZATION_MEMBER_ROLES,
  USER_SELECT_ADMIN,
  limpiarBusquedaUsuario,
  escaparLike,
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

  const previewAudienceHandler = async (req, res) => {
    try {
      const alertaId = Number(req.params.id);
      if (!Number.isInteger(alertaId) || alertaId <= 0) {
        return res.status(400).json({ error: 'alerta_id_invalido' });
      }
      const organizationId = normalizarOrganizationId(req.query.organization_id);
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha || ''))
        ? String(req.query.fecha)
        : getFechaMadridISO();
      let alertQuery = supabase
        .from('alertas')
        .select('id, titulo, contenido, resumen, resumen_final, fuente, provincias, sectores, subsectores, tipos_alerta, taxonomy_tags, estado_ia')
        .eq('id', alertaId);
      if (organizationId) alertQuery = alertQuery.eq('organization_id', organizationId);
      const alertResult = await alertQuery.single();
      if (alertResult.error || !alertResult.data) {
        return res.status(404).json({ error: 'alerta_no_encontrada' });
      }

      let usersQuery = supabase
        .from('users')
        .select('id, subscription, preferences, preferencias_extra, contexto_narrativo');
      if (organizationId) usersQuery = usersQuery.eq('organization_id', organizationId);
      const usersResult = await usersQuery;
      if (usersResult.error) throw usersResult.error;

      const countDigestPlacements = async (targetAlertId = null) => {
        let query = supabase
          .from('digest_items')
          .select('id', { count: 'exact', head: true })
          .eq('fecha', fecha);
        if (organizationId) query = query.eq('organization_id', organizationId);
        if (targetAlertId) query = query.eq('alerta_id', targetAlertId);
        const result = await query;
        if (result.error) throw result.error;
        return Number(result.count || 0);
      };
      const [totalPlacements, alertPlacements] = await Promise.all([
        countDigestPlacements(),
        countDigestPlacements(alertaId),
      ]);
      const dailyDigestShare = calcularCuotaDominanciaDigest(alertPlacements, totalPlacements);
      const reach = analizarAlcanceAudiencia(alertResult.data, usersResult.data || [], {
        singleAlertDigestShare: dailyDigestShare,
      });
      const registration = req.method === 'POST'
        ? await registrarSnapshotAlcance(supabase, alertaId, reach, { fecha, organizationId })
        : null;
      return res.json({
        ok: true,
        registered: Boolean(registration),
        alerta: { id: alertResult.data.id, titulo: alertResult.data.titulo },
        preview: reach,
        registration,
        summary: {
          text: `Esta alerta se enviaria a ${reach.matched_users} de ${reach.eligible_users} usuarios.`,
          warning: reach.flags.includes('cross_sector_mass_match')
            ? 'La alerta coincide con perfiles de un sector incompatible.'
            : null,
        },
      });
    } catch (err) {
      console.error('Error en /admin/alertas/:id/preview-audience:', err);
      return res.status(500).json({ error: err.message });
    }
  };

  app.get('/admin/alertas/:id/preview-audience', requireAdmin, previewAudienceHandler);
  app.post('/admin/alertas/:id/preview-audience', requireAdmin, previewAudienceHandler);


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

  app.get('/admin/digest/why-sent', requireAdmin, async (req, res) => {
    try {
      const params = normalizarDigestExplainParams(req.query);
      let digestQuery = supabase
        .from('digests')
        .select('id, user_id, fecha, mensaje, enviado, enviado_at, created_at, alerta_ids, organization_id')
        .order('created_at', { ascending: false })
        .limit(params.limit);

      if (params.digest_id) digestQuery = digestQuery.eq('id', params.digest_id);
      if (params.user_id) digestQuery = digestQuery.eq('user_id', params.user_id);
      if (params.fecha) digestQuery = digestQuery.eq('fecha', params.fecha);

      const { data: digests, error: digestError } = await digestQuery;
      if (digestError) throw digestError;

      const digestRows = digests || [];
      const digestIds = digestRows.map((digest) => Number(digest.id)).filter(Number.isFinite);
      const alertaIds = [...new Set(digestRows.flatMap((digest) => Array.isArray(digest.alerta_ids) ? digest.alerta_ids : [])
        .map(Number)
        .filter(Number.isFinite))];

      let digestItems = [];
      let attempts = [];
      let alertas = [];
      let factSheets = [];
      const warnings = [];

      if (digestIds.length > 0) {
        const { data, error } = await supabase
          .from('digest_items')
          .select('id, digest_id, user_id, fecha, item_numero, alerta_id, score, motivo_seleccion, resumen_usado, tags_json, selection_score, selection_action, selection_reason, selection_risk, similarity_score, selection_decision')
          .in('digest_id', digestIds)
          .order('item_numero', { ascending: true });
        if (error) throw error;
        digestItems = data || [];

        const attemptsResult = await supabase
          .from('digest_attempts')
          .select('id, user_id, digest_id, fecha, kind, status, motivo_no_envio, error_msg, metadata_json, total_alertas_dia, total_alertas_ventana, tras_quality_gate, tras_filtro_usuario, tras_scoring, alertas_finales, created_at, updated_at')
          .in('digest_id', digestIds)
          .order('created_at', { ascending: false });
        if (attemptsResult.error) throw attemptsResult.error;
        attempts = attemptsResult.data || [];
      }

      const itemAlertaIds = idsNumericosUnicos(digestItems, 'alerta_id');
      const allAlertaIds = [...new Set([...alertaIds, ...itemAlertaIds])];
      if (allAlertaIds.length > 0) {
        const alertasResult = await selectRowsByIds(
          supabase,
          'alertas',
          'id, titulo, fuente, fecha, url, provincias, sectores, subsectores, tipos_alerta, resumen_final, organization_id',
          allAlertaIds
        );
        if (alertasResult.error) throw alertasResult.error;
        alertas = alertasResult.data || [];

        const factResult = await supabase
          .from('alert_fact_sheets')
          .select('alerta_id, status, truth_score, risk_score, evidence_coverage, flags, reasons, shadow_decision, fact_sheet, generated_at')
          .in('alerta_id', allAlertaIds)
          .order('generated_at', { ascending: false });
        if (factResult.error) throw factResult.error;
        factSheets = factResult.data || [];
      }

      const items = digestRows.map((digest) => construirWhySentDigest({
        digest,
        digestItems,
        alertas,
        factSheets,
        attempts,
      }));

      return res.json({
        ok: true,
        available: true,
        warnings,
        digest: params.digest_id ? items[0] || null : undefined,
        items,
      });
    } catch (err) {
      console.error('Error en /admin/digest/why-sent:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/digest/why-not-sent', requireAdmin, async (req, res) => {
    try {
      const params = normalizarDigestExplainParams(req.query);
      let query = supabase
        .from('digest_attempts')
        .select('id, user_id, digest_id, fecha, kind, status, motivo_no_envio, error_msg, metadata_json, total_alertas_dia, total_alertas_ventana, tras_quality_gate, tras_filtro_usuario, tras_scoring, alertas_finales, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(params.limit);

      if (params.user_id) query = query.eq('user_id', params.user_id);
      if (params.fecha) query = query.eq('fecha', params.fecha);
      if (params.kind) query = query.eq('kind', params.kind);
      if (!params.digest_id) query = query.in('status', ['no_send', 'failed', 'skipped_existing']);
      if (params.digest_id) query = query.eq('digest_id', params.digest_id);

      const { data, error } = await query;
      if (error) throw error;

      const attempts = data || [];
      const userIds = idsNumericosUnicos(attempts, 'user_id');
      const usersResult = await selectRowsByIds(
        supabase,
        'users',
        'id, name, legal_name, phone, subscription, organization_id',
        userIds
      );
      if (usersResult.error) throw usersResult.error;

      return res.json({
        ok: true,
        available: true,
        items: construirWhyNotSentResponse({
          attempts,
          users: usersResult.data || [],
        }),
      });
    } catch (err) {
      console.error('Error en /admin/digest/why-not-sent:', err);
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
      if (error) throw error;

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
