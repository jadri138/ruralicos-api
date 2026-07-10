// src/modules/admin/admin.operaciones.routes.js
//
// Operaciones: estado de boletines, scrapers, pipeline diario y salud del sistema.
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
} = require('../mia/alertReview');

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

      if (error) throw error;

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


  app.get('/admin/operations/health-deep', requireAdmin, async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const { inicio, fin } = getRangoDiaMadridUTC(fecha);
      const estadosPendientesIA = ['pendiente_clasificar', 'pendiente_resumir', 'pendiente_revisar'];

      const [
        alertasTotal,
        alertasListas,
        alertasPendientesIA,
        alertasDescartadas,
        alertasDuplicadas,
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
        countQuery(supabase.from('alertas').select('id', { count: 'exact', head: true }).eq('fecha', fecha).in('estado_ia', estadosPendientesIA)),
        countQuery(supabase.from('alertas').select('id', { count: 'exact', head: true }).eq('fecha', fecha).eq('estado_ia', 'descartado')),
        countQuery(supabase.from('alertas').select('id', { count: 'exact', head: true }).eq('fecha', fecha).eq('estado_ia', 'duplicado')),
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
          alertas_descartadas: alertasDescartadas,
          alertas_duplicadas: alertasDuplicadas,
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
