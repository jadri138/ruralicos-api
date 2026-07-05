const { normalizePhone } = require('../../shared/phoneNormalizer');
const {
  extraerTextoEntrante,
  extraerTelefonoEntrante,
} = require('../aprendizaje');
const { extraerUltraMsg } = require('../../shared/ultramsgParser');
const { normalizarOrganizationId } = require('./organizationContext');

function normalizarId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function extraerReason(result = null, error = null) {
  if (error) return 'error';
  return String(
    result?.reason ||
    result?.ignored_reason ||
    result?.mia_policy?.reason ||
    result?.mia_policy?.decision ||
    ''
  ).trim() || null;
}

function extraerTelefonoYTexto(req, result = null) {
  const body = req?.body || {};
  let ultra = {};
  try {
    ultra = extraerUltraMsg(body);
  } catch {
    ultra = {};
  }

  const telefonoRaw =
    result?.telefono ||
    result?.phone ||
    result?.from_phone ||
    ultra.telefono ||
    extraerTelefonoEntrante(body);

  const textoRaw =
    result?.texto ||
    result?.raw_text ||
    result?.rawText ||
    result?.text_body ||
    ultra.texto ||
    extraerTextoEntrante(body);

  return {
    telefono: normalizePhone(telefonoRaw) || String(telefonoRaw || '').trim().slice(0, 120) || null,
    texto: String(textoRaw || '').trim().replace(/\s+/g, ' ').slice(0, 500) || null,
  };
}

function construirWebhookEventRow(req, result = null, error = null, { extended = true } = {}) {
  const query = { ...(req?.query || {}) };
  if (query.token) query.token = '[redacted]';

  const row = {
    source: 'ultramsg',
    path: req?.path || null,
    method: req?.method || null,
    content_type: req?.headers?.['content-type'] || null,
    query_json: query,
    body_json: req?.body || {},
    processed: Boolean(result?.ok && !result?.ignored),
    result_json: result,
    error_msg: error ? String(error.message || error).slice(0, 1000) : null,
  };

  if (!extended) return row;

  const { telefono, texto } = extraerTelefonoYTexto(req, result);
  return {
    ...row,
    organization_id: normalizarOrganizationId(result?.organization_id),
    user_id: normalizarId(result?.user_id),
    mia_inbound_id: normalizarId(result?.mia_inbound_id),
    mia_decision_id: normalizarId(result?.mia_decision_id),
    from_phone: telefono,
    text_preview: texto,
    reason: extraerReason(result, error),
  };
}

async function guardarWebhookEventSeguro(supabase, req, result = null, error = null) {
  const extendedRow = construirWebhookEventRow(req, result, error, { extended: true });

  try {
    const { data, error: insertError } = await supabase
      .from('webhook_events')
      .insert(extendedRow)
      .select('id')
      .single();

    if (!insertError) return data?.id || null;

    console.warn('[webhook_events] No se pudo guardar evento:', insertError.message);
    return null;
  } catch (err) {
    console.warn('[webhook_events] Error inesperado guardando evento:', err.message);
    return null;
  }
}

module.exports = {
  construirWebhookEventRow,
  guardarWebhookEventSeguro,
};
