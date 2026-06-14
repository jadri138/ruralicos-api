const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);

function esTablaNoDisponible(error) {
  return MISSING_TABLE_CODES.has(error?.code);
}

function normalizarOrganizationId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function extraerOrganizationId(value = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    return normalizarOrganizationId(value);
  }

  return normalizarOrganizationId(
    value.organization_id ??
    value.organizationId ??
    value.organization?.id ??
    value.mia_organization_context?.organization_id
  );
}

function conOrganizationId(row = {}, organizationId = null) {
  const id = normalizarOrganizationId(organizationId);
  return id ? { ...row, organization_id: id } : { ...row };
}

function alertaVisibleParaOrganization(alerta = {}, organizationId = null) {
  const alertaOrganizationId = extraerOrganizationId(alerta);
  const userOrganizationId = normalizarOrganizationId(organizationId);

  if (!alertaOrganizationId) return true;
  return Boolean(userOrganizationId && alertaOrganizationId === userOrganizationId);
}

function filtrarAlertasPorOrganization(alertas = [], organizationId = null) {
  return (Array.isArray(alertas) ? alertas : [])
    .filter((alerta) => alertaVisibleParaOrganization(alerta, organizationId));
}

function construirOrganizationContext(row = null, fallbackId = null) {
  const branding = row?.branding_json && typeof row.branding_json === 'object'
    ? row.branding_json
    : {};
  const organizationId = normalizarOrganizationId(row?.id ?? fallbackId);
  const name = String(row?.name || '').trim() || null;
  const brandName = String(
    branding.assistant_brand ||
    branding.brand_name ||
    branding.name ||
    name ||
    'Ruralicos'
  ).trim();

  return {
    organization_id: organizationId,
    name,
    slug: row?.slug || null,
    kind: row?.kind || (organizationId ? 'cooperativa' : 'ruralicos'),
    status: row?.status || 'active',
    brand_name: brandName || 'Ruralicos',
    reply_sender: String(branding.reply_sender || branding.sender || 'Ruralicos').trim() || 'Ruralicos',
    assistant_name: String(branding.assistant_name || 'MIA').trim() || 'MIA',
    branding_json: branding,
    settings_json: row?.settings_json && typeof row.settings_json === 'object' ? row.settings_json : {},
    available: Boolean(row?.id || !organizationId),
  };
}

function obtenerMiaBranding(context = {}) {
  const branding = context?.branding_json && typeof context.branding_json === 'object'
    ? context.branding_json
    : {};

  const brandName = String(
    context?.brand_name ||
    branding.assistant_brand ||
    branding.brand_name ||
    branding.name ||
    context?.name ||
    'Ruralicos'
  ).trim() || 'Ruralicos';

  const replySender = String(
    context?.reply_sender ||
    branding.reply_sender ||
    branding.sender ||
    brandName ||
    'Ruralicos'
  ).trim() || 'Ruralicos';

  const assistantName = String(
    context?.assistant_name ||
    branding.assistant_name ||
    'MIA'
  ).trim() || 'MIA';

  const website = String(
    context?.website ||
    branding.website ||
    branding.url ||
    (replySender.toLowerCase() === 'ruralicos' ? 'ruralicos.com' : '')
  ).trim() || null;

  return {
    brand_name: brandName,
    reply_sender: replySender,
    assistant_name: assistantName,
    agent_label: String(context?.agent_label || branding.agent_label || `un agente de ${replySender}`).trim(),
    support_label: String(context?.support_label || branding.support_label || `el equipo de ${replySender}`).trim(),
    digest_title: String(context?.digest_title || branding.digest_title || `${replySender} - Alertas`).trim(),
    website,
    white_label: Boolean(context?.white_label || branding.white_label),
  };
}

function obtenerRemitenteMIA(context = {}) {
  return obtenerMiaBranding(context).reply_sender;
}

function obtenerEtiquetaAgenteMIA(context = {}) {
  return obtenerMiaBranding(context).agent_label;
}

async function cargarOrganizationContextMIA(supabase, user = {}) {
  const organizationId = extraerOrganizationId(user);
  if (!organizationId) return construirOrganizationContext(null, null);

  try {
    const { data, error } = await supabase
      .from('organizations')
      .select('id, name, slug, kind, status, branding_json, settings_json')
      .eq('id', organizationId)
      .maybeSingle();

    if (error) throw error;
    return construirOrganizationContext(data || null, organizationId);
  } catch (error) {
    if (!esTablaNoDisponible(error)) {
      console.warn('[mia:organization] No se pudo cargar organization context:', error.message);
    }
    return {
      ...construirOrganizationContext(null, organizationId),
      available: false,
      error: error.message,
    };
  }
}

function aplicarOrganizationContextAUsuario(user = {}, context = {}) {
  return {
    ...user,
    organization_id: context.organization_id || extraerOrganizationId(user),
    mia_organization_context: context,
  };
}

module.exports = {
  normalizarOrganizationId,
  extraerOrganizationId,
  conOrganizationId,
  alertaVisibleParaOrganization,
  filtrarAlertasPorOrganization,
  construirOrganizationContext,
  obtenerMiaBranding,
  obtenerRemitenteMIA,
  obtenerEtiquetaAgenteMIA,
  cargarOrganizationContextMIA,
  aplicarOrganizationContextAUsuario,
};
