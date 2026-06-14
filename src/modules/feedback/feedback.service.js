// src/modules/feedback/feedback.service.js
//
// Logica de feedback/inbound: validacion del webhook, gestion de conversaciones
// MIA del dia, tracking de enlaces del digest, perfiles por tema y resolucion de
// usuario por telefono entrante. Reutilizable por feedback.routes.js. Extraido
// sin cambios de comportamiento.

const { checkCronToken } = require('../../middleware/cronToken');
const crypto = require('crypto');
const { getFechaMadridISO, getRangoDiaMadridUTC } = require('../../shared/fechaMadrid');
const { normalizePhone } = require('../../shared/phoneNormalizer');
const {
  aplicarFeedbackAlPerfil,
  extraerTextoEntrante,
  extraerTelefonoEntrante,
  leerPerfilIntereses,
  parsearVotosDigest,
  parsearVotosNaturalesPorAlertas,
  analizarFeedbackCompleto,
} = require('../aprendizaje');
const { enviarDigestPro } = require('../../platform/whatsapp');
const { extraerUltraMsg, esEventoMensajeUltraMsg } = require('../../shared/ultramsgParser');
const { registrarInboundMIA, actualizarInboundMIA } = require('../mia/inbound');
const { decidirMensajeMIA, esRespuestaOrigenCaptacionMIA } = require('../mia/decisionCore');
const { cargarDigestItemsMIA } = require('../mia/digestItems');
const { registrarMemoriaEstructuradaMIA } = require('../mia/structuredMemory');
const {
  ejecutarAccionesMIA,
  registrarCasoAgenteMIA,
  abrirConversacionAgenteMIA,
} = require('../mia/actionExecutor');
const {
  resolverPreguntaConBaseConocimientoMIA,
  aplicarRespuestaConocimientoADecision,
} = require('../mia/knowledgeBase');
const {
  registrarDecisionYAccionesMIA,
  actualizarDecisionResultadoMIA,
  actualizarAccionesPorTipoMIA,
} = require('../mia/decisionStore');
const {
  encolarRespuestaMIA,
  procesarOutboxItemMIA,
} = require('../mia/outbox');
const { guardarWebhookEventSeguro } = require('../mia/webhookEvent');
const {
  cargarPerfilOperativoMIA,
  aplicarPerfilOperativoAUsuario,
} = require('../mia/userProfile');
const { evaluarPoliticaDecisionMIA } = require('../mia/policy');
const {
  conOrganizationId,
  extraerOrganizationId,
  filtrarAlertasPorOrganization,
  cargarOrganizationContextMIA,
  aplicarOrganizationContextAUsuario,
  obtenerMiaBranding,
} = require('../mia/organizationContext');

function comprobarWebhookToken(req) {
  const esperado = String(process.env.ULTRAMSG_WEBHOOK_TOKEN || '').trim();
  const tokenObligatorio =
    process.env.NODE_ENV === 'production' ||
    process.env.RENDER === 'true' ||
    Boolean(process.env.RENDER_SERVICE_ID) ||
    String(process.env.REQUIRE_ULTRAMSG_WEBHOOK_TOKEN || '').toLowerCase() === 'true';

  if (!esperado) {
    if (!tokenObligatorio) return { ok: true };
    console.error('[webhook] Falta ULTRAMSG_WEBHOOK_TOKEN con validacion obligatoria');
    return {
      ok: false,
      status: 503,
      reason: 'webhook_token_no_configurado',
      error: 'Webhook no configurado',
    };
  }

  const authHeader = String(req.headers.authorization || '');
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const recibido =
    req.query.token ||
    req.headers['x-ruralicos-webhook-token'] ||
    req.headers['x-ultramsg-token'] ||
    bearerToken;

  const recibidoTexto = String(recibido || '').trim();
  if (recibidoTexto) {
    const esperadoBuffer = Buffer.from(esperado);
    const recibidoBuffer = Buffer.from(recibidoTexto);
    if (
      esperadoBuffer.length === recibidoBuffer.length &&
      crypto.timingSafeEqual(esperadoBuffer, recibidoBuffer)
    ) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    status: 401,
    reason: 'webhook_token_invalido',
    error: 'Webhook token invalido',
  };
}

function extraerFechaConversacionMIA(valor) {
  const match = String(valor || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function fechaMadridConversacionMIA(conversacion = {}) {
  const fechaContexto = extraerFechaConversacionMIA(conversacion.contexto_json?.fecha);
  if (fechaContexto) return fechaContexto;

  const abiertaAt = conversacion.abierta_at || conversacion.created_at || null;
  if (!abiertaAt) return '';

  const fecha = new Date(abiertaAt);
  if (Number.isNaN(fecha.getTime())) return '';
  return getFechaMadridISO(fecha);
}

function esConversacionMIADelDia(conversacion = {}, fechaHoy = getFechaMadridISO()) {
  return fechaMadridConversacionMIA(conversacion) === fechaHoy;
}

function getExpiracionFinDiaMadridISO(fecha = getFechaMadridISO()) {
  const fechaISO = extraerFechaConversacionMIA(fecha) || getFechaMadridISO();
  return getRangoDiaMadridUTC(fechaISO).fin;
}

function getClickBaseUrl() {
  return String(
    process.env.CLICK_BASE_URL ||
    process.env.PUBLIC_LINK_BASE_URL ||
    'https://ruralicos.es'
  ).replace(/\/+$/g, '');
}

function construirUrlTracking(token) {
  const baseUrl = getClickBaseUrl();
  const formato = String(process.env.CLICK_LINK_FORMAT || 'query').toLowerCase();
  const tokenSeguro = encodeURIComponent(token);
  return formato === 'path' ? `${baseUrl}/a/${tokenSeguro}` : `${baseUrl}/?a=${tokenSeguro}`;
}

function generarTokenClick() {
  return crypto.randomBytes(9).toString('base64url');
}

function escaparRegExp(texto) {
  return String(texto || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function aplicarLinksTrackingDigest(supabase, { mensaje, userId, digestId, alertas, organizationId = null }) {
  if ((process.env.CLICK_TRACKING_ENABLED || 'true').toLowerCase() === 'false') {
    return { mensaje, links: [], enabled: false };
  }

  let mensajeFinal = mensaje;
  const links = [];

  for (const alerta of alertas || []) {
    if (!alerta?.id || !alerta?.url || !mensajeFinal.includes(alerta.url)) continue;

    const token = generarTokenClick();
    const { data, error } = await supabase
      .from('alerta_click_links')
      .upsert(conOrganizationId({
        token,
        user_id: userId,
        digest_id: digestId,
        alerta_id: alerta.id,
        url_destino: alerta.url,
      }, organizationId), { onConflict: 'user_id,digest_id,alerta_id' })
      .select('token, alerta_id, url_destino')
      .single();

    if (error) {
      console.warn('[feedback:prueba] Tracking no disponible, manteniendo URLs oficiales:', error.message);
      return { mensaje, links, enabled: false, error: error.message };
    }

    const tokenFinal = data?.token || token;
    const urlTracking = construirUrlTracking(tokenFinal);
    mensajeFinal = mensajeFinal.replace(new RegExp(escaparRegExp(alerta.url), 'g'), urlTracking);
    links.push({
      alerta_id: alerta.id,
      token: tokenFinal,
      url_tracking: urlTracking,
      url_destino: alerta.url,
    });
  }

  return { mensaje: mensajeFinal, links, enabled: true };
}

async function abrirConversacionFeedbackPrueba(supabase, {
  userId,
  digestId,
  alertaIds,
  fecha,
  organizationId = null,
}) {
  const ahora = new Date().toISOString();

  const { error: cerrarError } = await supabase
    .from('user_conversations')
    .update({
      estado: 'expirada',
      cerrada_at: ahora,
    })
    .eq('user_id', userId)
    .eq('tipo', 'feedback_digest')
    .eq('estado', 'activa');

  if (cerrarError) {
    console.warn('[feedback:prueba] No se pudieron cerrar conversaciones previas:', cerrarError.message);
  }

  const { error } = await supabase
    .from('user_conversations')
    .insert(conOrganizationId({
      user_id: userId,
      tipo: 'feedback_digest',
      estado: 'activa',
      contexto_json: {
        digest_id: digestId,
        alerta_ids: alertaIds,
        fecha,
        origen: 'digest_prueba',
      },
      digest_id: digestId,
      expira_at: getExpiracionFinDiaMadridISO(fecha),
    }, organizationId));

  if (error) {
    console.warn('[feedback:prueba] No se pudo abrir conversacion de prueba:', error.message);
  }
}

async function sumarTagPerfil(supabase, userId, tema, delta, organizationId = null) {
  const { data: actual, error: selectError } = await supabase
    .from('user_interest_profile')
    .select('score, positivos, negativos')
    .eq('user_id', userId)
    .eq('tag', tema)
    .maybeSingle();

  if (selectError) {
    console.warn(`[feedback] Error leyendo tag ${tema}:`, selectError.message);
    return false;
  }

  const { error: upsertError } = await supabase
    .from('user_interest_profile')
    .upsert(conOrganizationId({
      user_id: userId,
      tag: tema,
      score: (Number(actual?.score) || 0) + delta,
      positivos: (Number(actual?.positivos) || 0) + (delta > 0 ? 1 : 0),
      negativos: (Number(actual?.negativos) || 0) + (delta < 0 ? 1 : 0),
      updated_at: new Date().toISOString(),
    }, organizationId), { onConflict: 'user_id,tag' });

  if (upsertError) {
    console.warn(`[feedback] Error actualizando tag ${tema}:`, upsertError.message);
    return false;
  }

  return true;
}

async function buscarConversacionActiva(supabase, userId, options = {}) {
  const fechaHoy = options.fechaHoy || getFechaMadridISO();
  const { data, error } = await supabase
    .from('user_conversations')
    .select('id, user_id, estado, tipo, contexto_json, digest_id, abierta_at, expira_at')
    .eq('user_id', userId)
    .eq('estado', 'activa')
    .gt('expira_at', new Date().toISOString())
    .order('abierta_at', { ascending: false })
    .limit(10);

  if (error) throw error;
  const conversaciones = Array.isArray(data) ? data : [];
  const obsoletas = conversaciones.filter((item) => !esConversacionMIADelDia(item, fechaHoy));
  const idsObsoletas = obsoletas.map((item) => item.id).filter(Boolean);

  if (idsObsoletas.length > 0) {
    const { error: cerrarError } = await supabase
      .from('user_conversations')
      .update({
        estado: 'expirada',
        cerrada_at: new Date().toISOString(),
      })
      .in('id', idsObsoletas);

    if (cerrarError) {
      console.warn('[mia:conversation] No se pudieron expirar conversaciones de dias anteriores:', cerrarError.message);
    }
  }

  return conversaciones.find((item) => esConversacionMIADelDia(item, fechaHoy)) || null;
}

async function cargarDigestYAlertas(supabase, userId, conversacionActiva, organizationId = null, options = {}) {
  let digest = null;
  const fechaHoy = options.fechaHoy || getFechaMadridISO();

  const digestId = conversacionActiva?.contexto_json?.digest_id || conversacionActiva?.digest_id;
  if (digestId) {
    const { data, error } = await supabase
      .from('digests')
      .select('id, user_id, fecha, alerta_ids, organization_id')
      .eq('id', digestId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    digest = data || null;
  }

  if (!digest) {
    const { data, error } = await supabase
      .from('digests')
      .select('id, user_id, fecha, alerta_ids, organization_id, enviado_at, created_at')
      .eq('user_id', userId)
      .eq('fecha', fechaHoy)
      .eq('enviado', true)
      .order('enviado_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    digest = data || null;
  }

  const digestItems = await cargarDigestItemsMIA(supabase, digest?.id);
  const alertaIds = Array.isArray(digestItems) && digestItems.length > 0
    ? digestItems.map((item) => Number(item.alerta_id)).filter(Boolean)
    : Array.isArray(digest?.alerta_ids)
      ? digest.alerta_ids.map(Number).filter(Boolean)
      : [];

  if (!digest || alertaIds.length === 0) {
    return { digest, alertaIds: [], alertasOrdenadas: [] };
  }

  const { data: alertas, error: errAlertas } = await supabase
    .from('alertas')
    .select('id, titulo, resumen, resumen_final, provincias, sectores, subsectores, tipos_alerta, fuente, organization_id')
    .in('id', alertaIds);

  if (errAlertas) throw errAlertas;

  const alertasPorId = new Map((alertas || []).map((alerta) => [Number(alerta.id), alerta]));
  const alertasVisibles = filtrarAlertasPorOrganization(
    alertaIds.map((id) => alertasPorId.get(id)).filter(Boolean),
    organizationId
  );
  return {
    digest,
    alertaIds,
    alertasOrdenadas: alertasVisibles,
  };
}

function candidatosTelefonoUsuario(telefono) {
  const normalizado = normalizePhone(telefono);
  const candidatos = new Set();

  if (normalizado) candidatos.add(normalizado);
  if (normalizado.length === 11 && normalizado.startsWith('34')) {
    candidatos.add(normalizado.slice(2));
  }
  if (normalizado.length === 9) {
    candidatos.add(`34${normalizado}`);
  }

  return [...candidatos].filter(Boolean);
}

async function buscarUsuarioPorTelefonoEntrante(supabase, telefono, select) {
  const candidatos = candidatosTelefonoUsuario(telefono);
  if (candidatos.length === 0) return null;

  const { data, error } = await supabase
    .from('users')
    .select(select)
    .in('phone', candidatos)
    .limit(candidatos.length);

  if (error) throw error;

  const users = data || [];
  if (users.length === 0) return null;

  return candidatos
    .map((candidato) => users.find((user) => String(user.phone || '') === candidato))
    .find(Boolean) || users[0];
}

module.exports = {
  comprobarWebhookToken,
  extraerFechaConversacionMIA,
  fechaMadridConversacionMIA,
  esConversacionMIADelDia,
  getExpiracionFinDiaMadridISO,
  getClickBaseUrl,
  construirUrlTracking,
  generarTokenClick,
  escaparRegExp,
  aplicarLinksTrackingDigest,
  abrirConversacionFeedbackPrueba,
  sumarTagPerfil,
  buscarConversacionActiva,
  cargarDigestYAlertas,
  candidatosTelefonoUsuario,
  buscarUsuarioPorTelefonoEntrante,
};
