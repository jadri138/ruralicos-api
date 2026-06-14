// src/modules/admin/admin.alertas.routes.js
//
// Gestion de alertas y cotejo con listas oficiales.
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

};
