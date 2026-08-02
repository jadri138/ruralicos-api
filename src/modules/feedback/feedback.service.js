// src/modules/feedback/feedback.service.js
//
// Logica de feedback/inbound: validacion del webhook, gestion de conversaciones
// MIA del dia y resolucion de usuario por telefono entrante. Reutilizable por
// feedback.routes.js.


const crypto = require('crypto');
const { getFechaMadridISO, getRangoDiaMadridUTC } = require('../../shared/fechaMadrid');
const { normalizePhone } = require('../../shared/phoneNormalizer');





const { cargarDigestItemsMIA } = require('../mia/digestItems');








const { filtrarAlertasPorOrganization } = require('../mia/organizationContext');

const LATE_DIGEST_REFERENCE_WINDOW_HOURS = 72;

function clampHours(value, fallback = LATE_DIGEST_REFERENCE_WINDOW_HOURS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(168, Math.trunc(parsed)));
}

function normalizarReferenciaDigest(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extraerItemsReferenciadosInequivocamente(texto, totalItems) {
  const total = Number(totalItems || 0);
  if (!Number.isInteger(total) || total <= 0) return [];

  const normalizado = normalizarReferenciaDigest(texto);
  if (!normalizado) return [];

  const items = new Set();
  const add = (value) => {
    const item = Number(value);
    if (Number.isInteger(item) && item >= 1 && item <= total) items.add(item);
  };
  const patrones = [
    /[+-]\s*(\d{1,2})\b/g,
    /\b(\d{1,2})\s*[+-]\b/g,
    /\b(?:item|items|numero|numeros|alerta|alertas|aviso|avisos)\s*(?:n(?:o|º|°)?\.?\s*)?(\d{1,2})\b/g,
    /\b(?:me interesa|me gusta|no me interesa|no quiero|quita|quitar|fuera)\s+(?:el|la|los|las)?\s*(\d{1,2})\b/g,
    /\b(?:el|la)\s+(\d{1,2})\b(?=[^.!?]{0,40}\b(?:si|no|interesa|gusta|util|quita|fuera)\b)/g,
  ];
  for (const patron of patrones) {
    for (const match of normalizado.matchAll(patron)) add(match[1]);
  }

  if (/^\d{1,2}$/.test(normalizado)) add(normalizado);

  const ordinales = new Map([
    ['primero', 1], ['primera', 1],
    ['segundo', 2], ['segunda', 2],
    ['tercero', 3], ['tercera', 3],
    ['cuarto', 4], ['cuarta', 4],
    ['quinto', 5], ['quinta', 5],
  ]);
  for (const [ordinal, item] of ordinales) {
    const conNombre = new RegExp(`\\b${ordinal}\\s+(?:item|alerta|aviso)\\b`);
    const conValoracion = new RegExp(
      `(?:\\b(?:me interesa|me gusta|no me interesa|no quiero|quita|fuera)\\s+(?:el|la)\\s+${ordinal}\\b|` +
      `\\b(?:el|la)\\s+${ordinal}\\b[^.!?]{0,40}\\b(?:si|no|interesa|gusta|util|quita|fuera)\\b)`
    );
    const ordinalSolo = new RegExp(`^(?:el|la)\\s+${ordinal}$`);
    if (conNombre.test(normalizado) || conValoracion.test(normalizado) || ordinalSolo.test(normalizado)) add(item);
  }

  return [...items].sort((left, right) => left - right);
}

function fechaReferenciaEntrega(digest = {}) {
  const candidates = [digest.read_at, digest.delivered_at, digest.enviado_at, digest.created_at]
    .map((value) => new Date(value || ''))
    .filter((date) => !Number.isNaN(date.getTime()));
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => right.getTime() - left.getTime())[0];
}

async function cargarUltimoDigestEntregadoReciente(supabase, userId, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('Fecha invalida para asociar feedback tardio');
  const windowHours = clampHours(options.lateWindowHours);
  const cutoff = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const fechaHoy = options.fechaHoy || getFechaMadridISO(now);
  const fechaDesde = getFechaMadridISO(cutoff);
  const { data, error } = await supabase
    .from('digests')
    .select('id, user_id, fecha, alerta_ids, organization_id, enviado_at, delivered_at, read_at, delivery_status, created_at')
    .eq('user_id', userId)
    .in('delivery_status', ['DELIVERED', 'READ'])
    .gte('fecha', fechaDesde)
    .lte('fecha', fechaHoy)
    .order('delivered_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(Math.ceil(windowHours / 24) + 2);

  if (error) throw error;
  return (data || [])
    .map((digest) => ({ digest, referenceAt: fechaReferenciaEntrega(digest) }))
    .filter((item) => item.referenceAt && item.referenceAt >= cutoff && item.referenceAt <= now)
    .sort((left, right) => right.referenceAt.getTime() - left.referenceAt.getTime())[0]?.digest || null;
}

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
  let digestItems = null;
  let lateAssociation = null;

  const digestId = conversacionActiva?.contexto_json?.digest_id || conversacionActiva?.digest_id;
  if (digestId) {
    const { data, error } = await supabase
      .from('digests')
      .select('id, user_id, fecha, alerta_ids, organization_id, delivered_at, read_at, delivery_status')
      .eq('id', digestId)
      .eq('user_id', userId)
      .in('delivery_status', ['DELIVERED', 'READ'])
      .maybeSingle();
    if (error) throw error;
    digest = data || null;
  }

  if (!digest) {
    const { data, error } = await supabase
      .from('digests')
      .select('id, user_id, fecha, alerta_ids, organization_id, enviado_at, delivered_at, read_at, delivery_status, created_at')
      .eq('user_id', userId)
      .eq('fecha', fechaHoy)
      .in('delivery_status', ['DELIVERED', 'READ'])
      .order('delivered_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    digest = data || null;
  }

  if (!digest && !conversacionActiva && options.mensajeUsuario) {
    const digestReciente = await cargarUltimoDigestEntregadoReciente(supabase, userId, options);
    if (digestReciente) {
      digestItems = await cargarDigestItemsMIA(supabase, digestReciente.id);
      const alertaIdsRecientes = Array.isArray(digestItems) && digestItems.length > 0
        ? digestItems.map((item) => Number(item.alerta_id)).filter(Boolean)
        : Array.isArray(digestReciente.alerta_ids)
          ? digestReciente.alerta_ids.map(Number).filter(Boolean)
          : [];
      const itemsReferenciados = extraerItemsReferenciadosInequivocamente(
        options.mensajeUsuario,
        alertaIdsRecientes.length
      );
      if (itemsReferenciados.length > 0) {
        digest = digestReciente;
        lateAssociation = {
          associated: true,
          item_numbers: itemsReferenciados,
          window_hours: clampHours(options.lateWindowHours),
        };
      }
    }
  }

  if (!lateAssociation) {
    digestItems = await cargarDigestItemsMIA(supabase, digest?.id);
  }
  const alertaIds = Array.isArray(digestItems) && digestItems.length > 0
    ? digestItems.map((item) => Number(item.alerta_id)).filter(Boolean)
    : Array.isArray(digest?.alerta_ids)
      ? digest.alerta_ids.map(Number).filter(Boolean)
      : [];

  if (!digest || alertaIds.length === 0) {
    return { digest, alertaIds: [], alertasOrdenadas: [], lateAssociation };
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
  if (lateAssociation && alertasVisibles.length !== alertaIds.length) {
    return { digest: null, alertaIds: [], alertasOrdenadas: [], lateAssociation: null };
  }
  return {
    digest,
    alertaIds,
    alertasOrdenadas: alertasVisibles,
    lateAssociation,
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
  buscarConversacionActiva,
  cargarDigestYAlertas,
  cargarUltimoDigestEntregadoReciente,
  extraerItemsReferenciadosInequivocamente,
  candidatosTelefonoUsuario,
  buscarUsuarioPorTelefonoEntrante,
};
