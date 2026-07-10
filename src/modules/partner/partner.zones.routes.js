// src/modules/partner/partner.zones.routes.js
//
// Zonas geograficas de la cooperativa (panel PARTNER). Todo se filtra por
// req.org.organizationId (requireOrg): una cooperativa solo ve y toca sus zonas.
// Escritura (crear/editar/borrar) limitada a roles owner/admin (puedeEscribir).

const { requireOrg } = require('../../middleware/requireAdmin');
const { orgClient } = require('./tenantClient');
const { responderError } = require('../../shared/responderError');

const UNIQUE_VIOLATION = '23505';
const ROLES_ESCRITURA = new Set(['owner', 'admin']);

function puedeEscribir(req) {
  return ROLES_ESCRITURA.has(req.org?.memberRole);
}

function normalizarNombre(value) {
  return String(value || '').trim().slice(0, 120);
}

function normalizarColor(value) {
  const color = String(value || '').trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : null;
}

function normalizarNotas(value) {
  return value ? String(value).slice(0, 500) : null;
}

function zonaPublica(zone, counts = {}) {
  const clientCount = Number(counts.clientCount || 0);
  const memberCount = Number(counts.memberCount || 0);
  return {
    id: zone.id,
    name: zone.name,
    color: zone.color || null,
    notes: zone.notes || null,
    client_count: clientCount,
    member_count: memberCount,
    assigned_count: clientCount || memberCount,
  };
}

module.exports = (app, supabase) => {
  // ──────────────────────────────────────────────────────────────────
  // GET /partner/zones — zonas de la cooperativa con nº de socios
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/zones', requireOrg, async (req, res) => {
    try {
      const db = orgClient(supabase, req);

      const { data: zones, error } = await db
        .from('organization_zones')
        .select('id, name, color, notes')
        .order('name', { ascending: true });

      if (error) throw error;

      const clientCounts = new Map();
      const memberCounts = new Map();

      const { data: clients, error: clientsError } = await db
        .from('organization_clients')
        .select('zone_id, status');
      if (clientsError) throw clientsError;
      for (const client of clients || []) {
        if (client.zone_id != null && client.status !== 'inactive') {
          const key = Number(client.zone_id);
          clientCounts.set(key, (clientCounts.get(key) || 0) + 1);
        }
      }

      const { data: members, error: membersError } = await db
        .from('organization_members')
        .select('zone_id');
      if (membersError) throw membersError;
      for (const member of members || []) {
        if (member.zone_id != null) {
          const key = Number(member.zone_id);
          memberCounts.set(key, (memberCounts.get(key) || 0) + 1);
        }
      }

      return res.json({
        ok: true,
        available: true,
        items: (zones || []).map((zone) => zonaPublica(zone, {
          clientCount: clientCounts.get(Number(zone.id)) || 0,
          memberCount: memberCounts.get(Number(zone.id)) || 0,
        })),
      });
    } catch (err) {
      return responderError(req, res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /partner/zones — crear zona  body: { name, color?, notes? }
  // ──────────────────────────────────────────────────────────────────
  app.post('/partner/zones', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite crear zonas' });

      const db = orgClient(supabase, req);
      const name = normalizarNombre(req.body?.name);
      if (!name) return res.status(400).json({ error: 'Nombre de zona requerido' });

      const { data, error } = await db
        .from('organization_zones')
        .insert({
          name,
          color: normalizarColor(req.body?.color),
          notes: normalizarNotas(req.body?.notes),
        })
        .select('id, name, color, notes')
        .maybeSingle();

      if (error) {
        if (error.code === UNIQUE_VIOLATION) return res.status(409).json({ error: 'Ya existe una zona con ese nombre' });
        throw error;
      }

      return res.status(201).json({ ok: true, item: zonaPublica(data) });
    } catch (err) {
      return responderError(req, res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // PATCH /partner/zones/:id — editar zona  body: { name?, color?, notes? }
  // ──────────────────────────────────────────────────────────────────
  app.patch('/partner/zones/:id', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite editar zonas' });

      const db = orgClient(supabase, req);
      const zoneId = Number(req.params.id);
      if (!Number.isSafeInteger(zoneId) || zoneId <= 0) return res.status(400).json({ error: 'zone id invalido' });

      const updates = { updated_at: new Date().toISOString() };
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
        const name = normalizarNombre(req.body.name);
        if (!name) return res.status(400).json({ error: 'Nombre de zona requerido' });
        updates.name = name;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'color')) {
        updates.color = normalizarColor(req.body.color);
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'notes')) {
        updates.notes = normalizarNotas(req.body.notes);
      }

      const { data, error } = await db
        .from('organization_zones')
        .update(updates)
        .eq('id', zoneId)
        .select('id, name, color, notes')
        .maybeSingle();

      if (error) {
        if (error.code === UNIQUE_VIOLATION) return res.status(409).json({ error: 'Ya existe una zona con ese nombre' });
        throw error;
      }
      if (!data) return res.status(404).json({ error: 'Zona no encontrada' });

      return res.json({ ok: true, item: zonaPublica(data) });
    } catch (err) {
      return responderError(req, res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // DELETE /partner/zones/:id — borrar zona (los socios quedan sin zona)
  // ──────────────────────────────────────────────────────────────────
  app.delete('/partner/zones/:id', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite borrar zonas' });

      const db = orgClient(supabase, req);
      const zoneId = Number(req.params.id);
      if (!Number.isSafeInteger(zoneId) || zoneId <= 0) return res.status(400).json({ error: 'zone id invalido' });

      // El FK `on delete set null` deja a los socios de la zona sin zona automaticamente.
      const { data, error } = await db
        .from('organization_zones')
        .delete()
        .eq('id', zoneId)
        .select('id')
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Zona no encontrada' });

      return res.json({ ok: true });
    } catch (err) {
      return responderError(req, res, err);
    }
  });
};
