// src/modules/admin/admin.mia.routes.js
//
// Consola y trazabilidad del agente MIA (overview, actividad, revision, outbox, conocimiento...).
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
      const timeWindow = leerVentanaHoras(req.query);

      let query = supabase
        .from('mia_inbound_messages')
        .select('id, source, external_message_id, from_phone, from_raw, chat_id, sender_kind, event_type, text_body, status, ignored_reason, user_id, organization_id, digest_id, conversation_id, decision_json, result_json, error_msg, duplicate_count, first_seen_at, last_seen_at, processed_at, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) query = query.eq('status', status);
      if (timeWindow) query = query.gte('created_at', timeWindow.since);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_inbound_messages_no_disponible', items: [], ...payloadVentanaHoras(timeWindow) });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [], ...payloadVentanaHoras(timeWindow) });
    } catch (err) {
      console.error('Error en /admin/mia/inbound:', err);
      return res.status(500).json({ error: err.message });
    }
  });


  app.get('/admin/mia/structured-memory', requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
      const userId = req.query.user_id ? Number(req.query.user_id) : null;
      const timeWindow = leerVentanaHoras(req.query);

      let query = supabase
        .from('mia_structured_memory')
        .select('id, user_id, organization_id, digest_id, inbound_id, source, memory_type, topic, detail, polarity, confidence, evidence, decision_version, metadata_json, incorporated_at, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (Number.isInteger(userId) && userId > 0) query = query.eq('user_id', userId);
      if (timeWindow) query = query.gte('created_at', timeWindow.since);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_structured_memory_no_disponible', items: [], ...payloadVentanaHoras(timeWindow) });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [], ...payloadVentanaHoras(timeWindow) });
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
      const timeWindow = leerVentanaHoras(req.query);

      let query = supabase
        .from('mia_decisions')
        .select('id, inbound_id, user_id, organization_id, digest_id, conversation_id, decision_version, intent, confidence, risk_flags, summary, decision_json, result_json, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (intent) query = query.eq('intent', intent);
      if (Number.isInteger(userId) && userId > 0) query = query.eq('user_id', userId);
      if (timeWindow) query = query.gte('created_at', timeWindow.since);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_decisions_no_disponible', items: [], ...payloadVentanaHoras(timeWindow) });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [], ...payloadVentanaHoras(timeWindow) });
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
      const timeWindow = leerVentanaHoras(req.query);

      let query = supabase
        .from('mia_actions')
        .select('id, decision_id, inbound_id, user_id, organization_id, digest_id, action_type, status, action_json, result_json, error_msg, created_at, executed_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) query = query.eq('status', status);
      if (actionType) query = query.eq('action_type', actionType);
      if (timeWindow) query = query.gte('created_at', timeWindow.since);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) {
          return res.json({ ok: true, available: false, reason: 'mia_actions_no_disponible', items: [], ...payloadVentanaHoras(timeWindow) });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: data || [], ...payloadVentanaHoras(timeWindow) });
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

};
