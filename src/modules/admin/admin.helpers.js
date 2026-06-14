// src/modules/admin/admin.helpers.js
//
// Requires, constantes y funciones auxiliares compartidas por las rutas de
// administracion (auditoria, validacion de organizaciones, ventanas de tiempo,
// resolucion de usuarios para digest, etc.). Extraido de admin.routes.js.

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

function leerVentanaHoras(query = {}, { maxHours = 720 } = {}) {
  if (query.hours === undefined || query.hours === null || query.hours === '') return null;
  const hours = Math.max(1, Math.min(maxHours, Number(query.hours) || 24));
  return {
    hours,
    since: new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(),
  };
}

function payloadVentanaHoras(timeWindow) {
  return timeWindow ? { hours: timeWindow.hours, since: timeWindow.since } : {};
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

module.exports = {
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
};
