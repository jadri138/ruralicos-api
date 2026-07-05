// src/modules/admin/admin.usuarios.routes.js
//
// Gestion de usuarios y organizaciones (cooperativas).
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

      if (error) throw error;

      return res.json({ ok: true, available: true, items: data || [] });
    } catch (err) {
      console.error('Error en /admin/organizations:', err);
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

      if (error) throw error;

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

      if (error) throw error;

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
      if (membersResult.error) {
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

      const memberAvailable = !memberResult.error;
      if (memberResult.error) {
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
        member_error: memberResult.error ? memberResult.error.message : null,
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

      const { data: existingUser, error: findError } = await supabase
        .from('users')
        .select('id')
        .eq('id', userId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (findError) throw findError;
      if (!existingUser) return res.status(404).json({ error: 'Usuario no pertenece a esta organizacion' });

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

      if (memberResult.error) throw memberResult.error;

      const { data: user, error: userError } = await supabase
        .from('users')
        .update({ organization_id: null })
        .eq('id', userId)
        .eq('organization_id', organizationId)
        .select(USER_SELECT_ADMIN)
        .maybeSingle();

      if (userError) throw userError;
      if (!user) return res.status(404).json({ error: 'Usuario no pertenece a esta organizacion' });

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
        member_error: memberResult.error ? memberResult.error.message : null,
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

};
