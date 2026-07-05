const crypto = require('crypto');
const { normalizarOrganizationId } = require('../mia/organizationContext');

function normalizarId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function hashIp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getAdminActor(req = {}) {
  const admin = req.admin || {};
  return {
    admin_user_id: normalizarId(admin.sub || admin.id || admin.admin_user_id),
    username: String(admin.username || admin.email || '').trim() || null,
  };
}

function construirAdminAuditRow({
  req = {},
  action,
  resourceType,
  resourceId = null,
  organizationId = null,
  metadata = {},
}) {
  const actor = getAdminActor(req);

  return {
    admin_user_id: actor.admin_user_id,
    actor_username: actor.username,
    organization_id: normalizarOrganizationId(organizationId),
    action: String(action || '').trim().slice(0, 120),
    resource_type: String(resourceType || '').trim().slice(0, 120),
    resource_id: resourceId === null || resourceId === undefined ? null : String(resourceId).slice(0, 120),
    metadata_json: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
    ip_hash: hashIp(req.ip || req.headers?.['x-forwarded-for']),
    user_agent: String(req.headers?.['user-agent'] || '').slice(0, 500) || null,
  };
}

async function registrarAdminAuditLog(supabase, options = {}) {
  const row = construirAdminAuditRow(options);
  if (!row.action || !row.resource_type) {
    return { ok: true, available: true, inserted: false, reason: 'audit_empty_action' };
  }

  try {
    const { data, error } = await supabase
      .from('admin_audit_log')
      .insert(row)
      .select('id')
      .single();

    if (error) throw error;
    return { ok: true, available: true, inserted: true, id: data?.id || null };
  } catch (error) {
    console.warn('[admin:audit] No se pudo registrar auditoria:', error.message);
    return { ok: false, available: false, inserted: false, error: error.message };
  }
}

module.exports = {
  construirAdminAuditRow,
  registrarAdminAuditLog,
  getAdminActor,
};
