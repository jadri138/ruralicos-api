// src/modules/partner/partner.clients.routes.js

const { requireOrg } = require('../../middleware/requireAdmin');
const { normalizePhone } = require('../../shared/phoneNormalizer');

const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);
const UNIQUE_VIOLATION = '23505';
const WRITE_ROLES = new Set(['owner', 'admin']);
const STATUSES = new Set(['active', 'inactive', 'prospect']);
const CLIENT_TYPES = new Set(['socio', 'cliente', 'prospecto']);

function isMissingTable(error) {
  return MISSING_TABLE_CODES.has(error?.code);
}

function canWrite(req) {
  return WRITE_ROLES.has(req.org?.memberRole);
}

function cleanText(value, max = 500) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 180) : null;
}

function cleanPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return { phone: null, phone_normalized: null };

  const normalized = normalizePhone(raw);
  if (!/^\d{6,15}$/.test(normalized)) {
    const error = new Error('Telefono no valido');
    error.status = 400;
    throw error;
  }

  return { phone: raw.slice(0, 40), phone_normalized: normalized };
}

function cleanObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeStringArray(value, maxItems = 20) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeProfile(input = {}) {
  const profile = cleanObject(input);
  return {
    province: cleanText(profile.province, 80),
    municipality: cleanText(profile.municipality, 120),
    activity_type: cleanText(profile.activity_type, 80),
    crops: normalizeStringArray(profile.crops),
    livestock: normalizeStringArray(profile.livestock),
    farm_size: cleanText(profile.farm_size, 80),
    tags: normalizeStringArray(profile.tags),
  };
}

function normalizePreferences(input = {}) {
  const preferences = cleanObject(input);
  return {
    digest_enabled: preferences.digest_enabled !== false,
    whatsapp_enabled: preferences.whatsapp_enabled !== false,
    email_enabled: Boolean(preferences.email_enabled),
    frequency: ['daily', 'weekly', 'urgent_only'].includes(preferences.frequency) ? preferences.frequency : 'daily',
    topics: normalizeStringArray(preferences.topics, 30),
    provinces: normalizeStringArray(preferences.provinces, 30),
    lonja_products: normalizeStringArray(preferences.lonja_products, 30),
  };
}

function buildDisplayName(body) {
  const explicit = cleanText(body.display_name || body.name, 160);
  if (explicit) return explicit;
  const fullName = [body.first_name, body.last_name].map((part) => cleanText(part, 80)).filter(Boolean).join(' ');
  return fullName || cleanEmail(body.email) || cleanText(body.phone, 40) || null;
}

function publicClient(row, zone = null) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    zone_id: row.zone_id || null,
    zone,
    display_name: row.display_name,
    first_name: row.first_name || null,
    last_name: row.last_name || null,
    phone: row.phone || null,
    phone_normalized: row.phone_normalized || null,
    email: row.email || null,
    status: row.status || 'active',
    client_type: row.client_type || 'socio',
    profile_json: cleanObject(row.profile_json),
    preferences_json: cleanObject(row.preferences_json),
    notes: row.notes || null,
    last_digest_at: row.last_digest_at || null,
    last_interaction_at: row.last_interaction_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function filterClient(client, filters) {
  if (filters.q) {
    const haystack = [
      client.display_name,
      client.phone,
      client.email,
      client.profile_json?.municipality,
      client.profile_json?.province,
      ...(client.profile_json?.crops || []),
      ...(client.profile_json?.livestock || []),
      ...(client.preferences_json?.topics || []),
    ].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(filters.q)) return false;
  }

  if (filters.status && client.status !== filters.status) return false;
  if (filters.client_type && client.client_type !== filters.client_type) return false;
  if (filters.topic && !client.preferences_json?.topics?.includes(filters.topic)) return false;

  if (filters.zone_id) {
    if (filters.zone_id === 'none') {
      if (client.zone_id != null) return false;
    } else if (Number(client.zone_id) !== Number(filters.zone_id)) {
      return false;
    }
  }

  return true;
}

function buildPayload(req, { partial = false } = {}) {
  const body = req.body || {};
  const payload = {};

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'display_name') || Object.prototype.hasOwnProperty.call(body, 'name')) {
    const displayName = buildDisplayName(body);
    if (!displayName) {
      const error = new Error('Nombre requerido');
      error.status = 400;
      throw error;
    }
    payload.display_name = displayName;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'first_name')) payload.first_name = cleanText(body.first_name, 80);
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'last_name')) payload.last_name = cleanText(body.last_name, 120);

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'phone')) {
    Object.assign(payload, cleanPhone(body.phone));
  }

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'email')) {
    payload.email = cleanEmail(body.email);
  }

  if (!partial && !payload.phone_normalized && !payload.email) {
    const error = new Error('Indica telefono o email del cliente');
    error.status = 400;
    throw error;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'status') || !partial) {
    payload.status = STATUSES.has(body.status) ? body.status : 'active';
  }

  if (Object.prototype.hasOwnProperty.call(body, 'client_type') || !partial) {
    payload.client_type = CLIENT_TYPES.has(body.client_type) ? body.client_type : 'socio';
  }

  if (Object.prototype.hasOwnProperty.call(body, 'zone_id')) {
    const zoneId = body.zone_id === null || body.zone_id === '' || body.zone_id === 'none' ? null : Number(body.zone_id);
    if (zoneId !== null && (!Number.isSafeInteger(zoneId) || zoneId <= 0)) {
      const error = new Error('zone_id invalido');
      error.status = 400;
      throw error;
    }
    payload.zone_id = zoneId;
  } else if (!partial) {
    payload.zone_id = null;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'profile_json') || Object.prototype.hasOwnProperty.call(body, 'profile') || !partial) {
    payload.profile_json = normalizeProfile(body.profile_json || body.profile || {});
  }

  if (Object.prototype.hasOwnProperty.call(body, 'preferences_json') || Object.prototype.hasOwnProperty.call(body, 'preferences') || !partial) {
    payload.preferences_json = normalizePreferences(body.preferences_json || body.preferences || {});
  }

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'notes')) payload.notes = cleanText(body.notes, 1000);

  payload.updated_at = new Date().toISOString();
  return payload;
}

module.exports = (app, supabase) => {
  app.get('/partner/clients', requireOrg, async (req, res) => {
    try {
      const orgId = req.org.organizationId;
      const filters = {
        q: String(req.query.q || '').trim().toLowerCase(),
        status: String(req.query.status || '').trim(),
        client_type: String(req.query.client_type || '').trim(),
        zone_id: String(req.query.zone_id || '').trim(),
        topic: String(req.query.topic || '').trim(),
      };

      const [clientsResult, zonesResult, organizationResult] = await Promise.all([
        supabase
          .from('organization_clients')
          .select('id, organization_id, zone_id, display_name, first_name, last_name, phone, phone_normalized, email, status, client_type, profile_json, preferences_json, notes, last_digest_at, last_interaction_at, created_at, updated_at')
          .eq('organization_id', orgId)
          .order('created_at', { ascending: false })
          .limit(1000),
        supabase
          .from('organization_zones')
          .select('id, name, color')
          .eq('organization_id', orgId),
        supabase
          .from('organizations')
          .select('settings_json')
          .eq('id', orgId)
          .maybeSingle(),
      ]);

      if (clientsResult.error) {
        if (isMissingTable(clientsResult.error)) {
          return res.json({ ok: true, available: false, items: [], limits: { current: 0, max: null } });
        }
        throw clientsResult.error;
      }
      if (zonesResult.error && !isMissingTable(zonesResult.error)) throw zonesResult.error;

      const zonesById = new Map((zonesResult.data || []).map((zone) => [Number(zone.id), zone]));
      const items = (clientsResult.data || [])
        .map((client) => publicClient(client, client.zone_id ? zonesById.get(Number(client.zone_id)) || null : null))
        .filter((client) => filterClient(client, filters));

      const settings = organizationResult.data?.settings_json && typeof organizationResult.data.settings_json === 'object'
        ? organizationResult.data.settings_json
        : {};
      const maxClients = Number(settings.client_limit || settings.max_clients || settings.client_quota || 0) || null;

      return res.json({
        ok: true,
        available: true,
        items,
        limits: {
          current: (clientsResult.data || []).filter((client) => client.status === 'active').length,
          max: maxClients,
        },
      });
    } catch (err) {
      console.error('Error en GET /partner/clients:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/partner/clients', requireOrg, async (req, res) => {
    try {
      if (!canWrite(req)) return res.status(403).json({ error: 'Tu rol no permite crear clientes' });

      const payload = {
        ...buildPayload(req),
        organization_id: req.org.organizationId,
        created_by_staff_id: req.org.impersonatedBy ? null : req.org.staffId,
      };

      const { data, error } = await supabase
        .from('organization_clients')
        .insert(payload)
        .select('id, organization_id, zone_id, display_name, first_name, last_name, phone, phone_normalized, email, status, client_type, profile_json, preferences_json, notes, last_digest_at, last_interaction_at, created_at, updated_at')
        .maybeSingle();

      if (error) {
        if (isMissingTable(error)) return res.json({ ok: true, available: false });
        if (error.code === UNIQUE_VIOLATION) return res.status(409).json({ error: 'Ya existe un cliente con ese telefono o email en esta cooperativa' });
        throw error;
      }

      return res.status(201).json({ ok: true, item: publicClient(data) });
    } catch (err) {
      console.error('Error en POST /partner/clients:', err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.patch('/partner/clients/:id', requireOrg, async (req, res) => {
    try {
      if (!canWrite(req)) return res.status(403).json({ error: 'Tu rol no permite editar clientes' });

      const clientId = Number(req.params.id);
      if (!Number.isSafeInteger(clientId) || clientId <= 0) return res.status(400).json({ error: 'client id invalido' });

      const payload = buildPayload(req, { partial: true });
      const { data, error } = await supabase
        .from('organization_clients')
        .update(payload)
        .eq('id', clientId)
        .eq('organization_id', req.org.organizationId)
        .select('id, organization_id, zone_id, display_name, first_name, last_name, phone, phone_normalized, email, status, client_type, profile_json, preferences_json, notes, last_digest_at, last_interaction_at, created_at, updated_at')
        .maybeSingle();

      if (error) {
        if (isMissingTable(error)) return res.json({ ok: true, available: false });
        if (error.code === UNIQUE_VIOLATION) return res.status(409).json({ error: 'Ya existe un cliente con ese telefono o email en esta cooperativa' });
        throw error;
      }
      if (!data) return res.status(404).json({ error: 'Cliente no encontrado' });

      return res.json({ ok: true, item: publicClient(data) });
    } catch (err) {
      console.error('Error en PATCH /partner/clients/:id:', err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete('/partner/clients/:id', requireOrg, async (req, res) => {
    try {
      if (!canWrite(req)) return res.status(403).json({ error: 'Tu rol no permite dar de baja clientes' });

      const clientId = Number(req.params.id);
      if (!Number.isSafeInteger(clientId) || clientId <= 0) return res.status(400).json({ error: 'client id invalido' });

      const { data, error } = await supabase
        .from('organization_clients')
        .update({ status: 'inactive', updated_at: new Date().toISOString() })
        .eq('id', clientId)
        .eq('organization_id', req.org.organizationId)
        .select('id')
        .maybeSingle();

      if (error) {
        if (isMissingTable(error)) return res.json({ ok: true, available: false });
        throw error;
      }
      if (!data) return res.status(404).json({ error: 'Cliente no encontrado' });

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error en DELETE /partner/clients/:id:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
