// src/modules/partner/partner.data.routes.js
//
// Datos del panel PARTNER (cooperativa). TODO se filtra por req.org.organizationId
// gracias a requireOrg: una cooperativa solo ve y toca lo suyo.
//
// Escritura (alta/baja de socios, edicion de branding) limitada a roles owner/admin.
// agent/viewer son de solo lectura.

const { requireOrg } = require('../../middleware/requireAdmin');
const { orgClient } = require('./tenantClient');
const { responderError } = require('../../shared/responderError');
const { normalizePhone, LONGITUD_TELEFONO } = require('../../shared/phoneNormalizer');

const ROLES_SOCIO = new Set(['admin', 'agent', 'viewer', 'member']);
const ROLES_ESCRITURA = new Set(['owner', 'admin']);
const SETTINGS_EDITABLES = new Set(['contact_name', 'contact_phone', 'contact_email', 'notes']);

function puedeEscribir(req) {
  return ROLES_ESCRITURA.has(req.org?.memberRole);
}

function socioPublico(user, member, zone) {
  const zoneId = member?.zone_id ?? null;
  return {
    id: user.id,
    name: user.legal_name || user.name || `Socio ${user.id}`,
    phone: user.phone || null,
    email: user.email || null,
    subscription: user.subscription || 'free',
    member_role: member?.role || null,
    member_status: member?.status || null,
    zone_id: zoneId,
    zone: zone || null, // { id, name, color } | null
    created_at: user.created_at || null,
  };
}

module.exports = (app, supabase) => {
  // Carga los ids de socios de la organizacion (helper reutilizado).
  async function idsSociosDeOrg(db) {
    const { data, error } = await db.from('users').select('id');
    if (error) throw error;
    return (data || []).map((u) => Number(u.id));
  }

  // ──────────────────────────────────────────────────────────────────
  // GET /partner/overview — metricas de la cooperativa
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/overview', requireOrg, async (req, res) => {
    try {
      const db = orgClient(supabase, req);
      const hace7dias = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();

      const { data: socios, error: errSocios } = await db
        .from('users')
        .select('id, subscription, created_at');
      if (errSocios) throw errSocios;

      const ids = (socios || []).map((u) => Number(u.id));

      // Mensajes enviados en 7 dias: a clientes propios (organization_id) o a usuarios
      // vinculados (user_id). Se mezclan ids para no duplicar ni exigir usuarios B2C.
      // sinTenant deliberado: los digests B2C de un socio vinculado llevan
      // organization_id null; los ids ya salen de la consulta scoped de arriba.
      const [digByOrg, digByUsers] = await Promise.all([
        db.from('digests').select('id').eq('enviado', true).gte('created_at', hace7dias),
        ids.length
          ? db.sinTenant.from('digests').select('id').in('user_id', ids).eq('enviado', true).gte('created_at', hace7dias)
          : Promise.resolve({ data: [], error: null }),
      ]);
      for (const result of [digByOrg, digByUsers]) {
        if (result.error) throw result.error;
      }
      const digestIds = new Set();
      for (const d of digByOrg.data || []) digestIds.add(Number(d.id));
      for (const d of digByUsers.data || []) digestIds.add(Number(d.id));
      const digestsEnviados7d = digestIds.size;

      const nuevos7d = (socios || []).filter((u) => u.created_at && u.created_at >= hace7dias).length;

      return res.json({
        ok: true,
        metrics: {
          socios_total: (socios || []).length,
          socios_nuevos_7d: nuevos7d,
          digests_enviados_7d: digestsEnviados7d,
        },
      });
    } catch (err) {
      return responderError(req, res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /partner/members — socios de la cooperativa
  // Filtros opcionales: ?q=&status=&subscription=&zone_id=
  // (status: active|inactive|none · zone_id: id numerico o "none"/"null")
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/members', requireOrg, async (req, res) => {
    try {
      const db = orgClient(supabase, req);

      // organization_members: rol/estado y, por separado, la asignacion de zona.
      // La consulta de zona puede fallar si la columna no existe todavia (pre-migracion)
      // sin afectar a rol/estado, que se siguen mostrando.
      const [
        { data: users, error },
        membersResult,
        zoneAssignResult,
        zonesResult,
      ] = await Promise.all([
        db
          .from('users')
          .select('id, name, legal_name, phone, email, subscription, organization_id, created_at')
          .order('created_at', { ascending: false }),
        db.from('organization_members').select('user_id, role, status'),
        db.from('organization_members').select('user_id, zone_id'),
        db.from('organization_zones').select('id, name, color'),
      ]);

      if (error) throw error;
      if (membersResult.error) {
        console.warn('[partner] organization_members no disponible:', membersResult.error.message);
      }

      const byId = new Map(
        (membersResult.error ? [] : membersResult.data || []).map((m) => [Number(m.user_id), m])
      );
      const zoneByUser = new Map(
        (zoneAssignResult.error ? [] : zoneAssignResult.data || [])
          .filter((m) => m.zone_id != null)
          .map((m) => [Number(m.user_id), Number(m.zone_id)])
      );
      const zonesById = new Map(
        (zonesResult.error ? [] : zonesResult.data || []).map((z) => [Number(z.id), z])
      );

      // Filtros (en memoria: el universo es el de socios de una cooperativa).
      const q = String(req.query.q || '').trim().toLowerCase();
      const statusFilter = String(req.query.status || '').trim();
      const subscriptionFilter = String(req.query.subscription || '').trim();
      const zoneFilterRaw = String(req.query.zone_id || '').trim();
      const sinZona = ['none', 'null', '0', 'sin'].includes(zoneFilterRaw.toLowerCase());
      const zoneFilterId = sinZona ? null : Number(zoneFilterRaw);
      const hasZoneFilter = zoneFilterRaw !== '';

      const items = (users || [])
        .map((u) => {
          const uid = Number(u.id);
          const member = byId.get(uid) || null;
          const zoneId = zoneByUser.has(uid) ? zoneByUser.get(uid) : null;
          const zone = zoneId != null ? zonesById.get(zoneId) || null : null;
          const memberWithZone = member || zoneId != null ? { ...(member || {}), zone_id: zoneId } : null;
          return socioPublico(u, memberWithZone, zone);
        })
        .filter((socio) => {
          if (q) {
            const haystack = [socio.name, socio.phone, socio.email].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
          }
          if (subscriptionFilter && (socio.subscription || 'free') !== subscriptionFilter) return false;
          if (statusFilter) {
            const estado = socio.member_status || 'none';
            if (estado !== statusFilter) return false;
          }
          if (hasZoneFilter) {
            if (sinZona) {
              if (socio.zone_id != null) return false;
            } else if (Number.isSafeInteger(zoneFilterId) && socio.zone_id !== zoneFilterId) {
              return false;
            }
          }
          return true;
        });

      return res.json({ ok: true, items });
    } catch (err) {
      return responderError(req, res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /partner/members — alta de socio por telefono (vincula un usuario
  // existente a la cooperativa). El socio debe estar ya registrado en Ruralicos.
  // ──────────────────────────────────────────────────────────────────
  app.post('/partner/members', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite dar de alta socios' });

      const db = orgClient(supabase, req);
      const orgId = db.organizationId;
      const phone = normalizePhone(req.body?.phone || '');
      const role = ROLES_SOCIO.has(req.body?.role) ? req.body.role : 'member';

      if (phone.length !== LONGITUD_TELEFONO) {
        return res.status(400).json({ error: 'Telefono no valido' });
      }

      // sinTenant deliberado: el alta busca un usuario GLOBAL por telefono (aun
      // sin cooperativa) para vincularlo; una consulta scoped nunca lo veria.
      const { data: user, error: findError } = await db.sinTenant
        .from('users')
        .select('id, name, legal_name, phone, email, subscription, organization_id, created_at')
        .eq('phone', phone)
        .maybeSingle();
      if (findError) throw findError;

      if (!user) {
        return res.status(404).json({
          error: 'Ese telefono no esta registrado en Ruralicos todavia. El socio debe darse de alta primero.',
          code: 'socio_no_registrado',
        });
      }
      if (user.organization_id && Number(user.organization_id) !== orgId) {
        return res.status(409).json({ error: 'Ese socio ya pertenece a otra cooperativa.' });
      }

      // sinTenant deliberado: la vinculacion transiciona el usuario de "sin org"
      // a esta org; el guard de arriba garantiza que no pisa otra cooperativa.
      const { data: updated, error: updError } = await db.sinTenant
        .from('users')
        .update({ organization_id: orgId })
        .eq('id', user.id)
        .select('id, name, legal_name, phone, email, subscription, organization_id, created_at')
        .single();
      if (updError) throw updError;

      const memberResult = await db
        .from('organization_members')
        .upsert({
          user_id: user.id,
          role,
          status: 'active',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'organization_id,user_id' })
        .select('user_id, role, status')
        .maybeSingle();

      return res.status(201).json({
        ok: true,
        item: socioPublico(updated, memberResult.data),
      });
    } catch (err) {
      return responderError(req, res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // PATCH /partner/members/:userId — cambia rol y/o zona del socio
  // body: { role?, zone_id? }  (zone_id null = quitar de zona)
  // ──────────────────────────────────────────────────────────────────
  app.patch('/partner/members/:userId', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite editar socios' });

      const db = orgClient(supabase, req);
      const userId = Number(req.params.userId);
      if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'user id invalido' });

      const hasRole = Object.prototype.hasOwnProperty.call(req.body || {}, 'role');
      const hasZone = Object.prototype.hasOwnProperty.call(req.body || {}, 'zone_id');
      if (!hasRole && !hasZone) return res.status(400).json({ error: 'Nada que actualizar' });

      const role = req.body?.role;
      if (hasRole && !ROLES_SOCIO.has(role)) return res.status(400).json({ error: 'role invalido' });

      // Normaliza zone_id: null/''/0 → sin zona; numero → id de zona.
      let zoneId;
      if (hasZone) {
        const raw = req.body.zone_id;
        if (raw === null || raw === '' || raw === 0 || raw === '0') zoneId = null;
        else {
          zoneId = Number(raw);
          if (!Number.isSafeInteger(zoneId) || zoneId <= 0) return res.status(400).json({ error: 'zone_id invalido' });
        }
      }

      // El socio debe pertenecer a esta org.
      const { data: user, error: findError } = await db
        .from('users')
        .select('id')
        .eq('id', userId)
        .maybeSingle();
      if (findError) throw findError;
      if (!user) return res.status(404).json({ error: 'Socio no pertenece a esta cooperativa' });

      // La zona (si se asigna una) debe ser de esta cooperativa.
      if (hasZone && zoneId != null) {
        const { data: zone, error: zoneError } = await db
          .from('organization_zones')
          .select('id')
          .eq('id', zoneId)
          .maybeSingle();
        if (zoneError) throw zoneError;
        if (!zone) return res.status(400).json({ error: 'La zona no pertenece a la cooperativa' });
      }

      // Construye la fila a upsertar. Si solo cambia la zona, conserva el rol actual.
      const upsertRow = {
        user_id: userId,
        status: 'active',
        updated_at: new Date().toISOString(),
      };
      if (hasRole) upsertRow.role = role;
      if (hasZone) upsertRow.zone_id = zoneId;
      if (!hasRole) {
        const { data: current } = await db
          .from('organization_members')
          .select('role')
          .eq('user_id', userId)
          .maybeSingle();
        upsertRow.role = current?.role || 'member';
      }

      const { data, error } = await db
        .from('organization_members')
        .upsert(upsertRow, { onConflict: 'organization_id,user_id' })
        .select('user_id, role, status, zone_id')
        .maybeSingle();
      if (error) throw error;

      return res.json({ ok: true, member: data || { user_id: userId, ...upsertRow } });
    } catch (err) {
      return responderError(req, res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // DELETE /partner/members/:userId — baja del socio en la cooperativa
  // ──────────────────────────────────────────────────────────────────
  app.delete('/partner/members/:userId', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite dar de baja socios' });

      const db = orgClient(supabase, req);
      const userId = Number(req.params.userId);
      if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'user id invalido' });

      const { data: existingUser, error: findError } = await db
        .from('users')
        .select('id')
        .eq('id', userId)
        .maybeSingle();
      if (findError) throw findError;
      if (!existingUser) return res.status(404).json({ error: 'Socio no pertenece a esta cooperativa' });

      const memberResult = await db
        .from('organization_members')
        .update({ status: 'inactive', updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .select('user_id, role, status, zone_id')
        .maybeSingle();
      if (memberResult.error) throw memberResult.error;

      const { data: user, error: updError } = await db
        .from('users')
        .update({ organization_id: null })
        .eq('id', userId)
        .select('id')
        .maybeSingle();
      if (updError) throw updError;
      if (!user) return res.status(404).json({ error: 'Socio no pertenece a esta cooperativa' });

      return res.json({
        ok: true,
        member: memberResult.data || null,
        member_available: !memberResult.error,
      });
    } catch (err) {
      return responderError(req, res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /partner/digests — ultimos mensajes (digests) enviados a los socios
  // Cada item incluye el destinatario resuelto (nombre/telefono) y el texto
  // del mensaje, para que el panel muestre a quien fue y poder abrirlo.
  // Filtros opcionales: ?limit= y rango por fecha ?from=&to= (ISO, sobre created_at).
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/digests', requireOrg, async (req, res) => {
    try {
      const db = orgClient(supabase, req);
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
      const from = String(req.query.from || '').trim();
      const to = String(req.query.to || '').trim();

      const ids = await idsSociosDeOrg(db);

      const baseSelect = 'id, user_id, organization_client_id, fecha, mensaje, enviado, enviado_at, created_at, alerta_ids';
      const applyRange = (q) => {
        let next = q;
        if (from) next = next.gte('created_at', from);
        if (to) next = next.lte('created_at', to);
        return next.order('created_at', { ascending: false }).limit(limit);
      };

      // Los mensajes de la cooperativa pueden ir a clientes propios (organization_id)
      // o a usuarios Ruralicos vinculados (user_id). Se consultan por ambas vias y se
      // mezclan por id para no exigir que el cliente sea ademas usuario B2C.
      // sinTenant deliberado en byUsers: los digests B2C llevan organization_id
      // null; los ids salen de la consulta scoped de socios de la org.
      const [byOrg, byUsers] = await Promise.all([
        applyRange(db.from('digests').select(baseSelect)),
        ids.length
          ? applyRange(db.sinTenant.from('digests').select(baseSelect).in('user_id', ids))
          : Promise.resolve({ data: [], error: null }),
      ]);

      for (const result of [byOrg, byUsers]) {
        if (result.error) throw result.error;
      }

      const byDigestId = new Map();
      for (const d of byOrg.data || []) byDigestId.set(String(d.id), d);
      for (const d of byUsers.data || []) byDigestId.set(String(d.id), d);
      const rows = [...byDigestId.values()]
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, limit);

      // Resolver destinatarios: usuarios Ruralicos (user_id) y clientes propios
      // de la cooperativa (organization_client_id), en lote.
      const userIds = [...new Set(rows.map((d) => Number(d.user_id)).filter(Number.isSafeInteger))];
      const clientIds = [...new Set(rows.map((d) => Number(d.organization_client_id)).filter(Number.isSafeInteger))];

      const [usersResult, clientsResult] = await Promise.all([
        userIds.length
          ? db.from('users').select('id, name, legal_name, phone').in('id', userIds)
          : Promise.resolve({ data: [], error: null }),
        clientIds.length
          ? db.from('organization_clients').select('id, display_name, phone').in('id', clientIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (usersResult.error) throw usersResult.error;
      if (clientsResult.error) throw clientsResult.error;

      const userById = new Map((usersResult.data || []).map((u) => [Number(u.id), u]));
      const clientById = new Map((clientsResult.data || []).map((c) => [Number(c.id), c]));

      function resolveRecipient(d) {
        const clientId = Number(d.organization_client_id);
        if (Number.isSafeInteger(clientId) && clientById.has(clientId)) {
          const c = clientById.get(clientId);
          return { kind: 'cliente', id: c.id, name: c.display_name || `Cliente ${c.id}`, phone: c.phone || null };
        }
        const userId = Number(d.user_id);
        const u = userById.get(userId);
        return {
          kind: 'usuario',
          id: userId || null,
          name: (u && (u.legal_name || u.name)) || (userId ? `Socio ${userId}` : 'Destinatario'),
          phone: (u && u.phone) || null,
        };
      }

      const items = rows.map((d) => ({
        id: d.id,
        user_id: d.user_id,
        organization_client_id: d.organization_client_id || null,
        recipient: resolveRecipient(d),
        fecha: d.fecha,
        mensaje: d.mensaje || null,
        enviado: d.enviado,
        enviado_at: d.enviado_at,
        created_at: d.created_at,
        num_alertas: Array.isArray(d.alerta_ids) ? d.alerta_ids.length : 0,
      }));

      return res.json({ ok: true, items });
    } catch (err) {
      return responderError(req, res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /partner/branding — branding + ajustes editables de la cooperativa
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/branding', requireOrg, async (req, res) => {
    try {
      const db = orgClient(supabase, req);
      const { data, error } = await db
        .from('organizations')
        .select('id, slug, name, kind, status, branding_json, settings_json')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Cooperativa no encontrada' });

      return res.json({
        ok: true,
        can_edit: puedeEscribir(req),
        organization: {
          id: data.id,
          slug: data.slug,
          name: data.name,
          kind: data.kind,
          status: data.status,
          branding_json: data.branding_json && typeof data.branding_json === 'object' ? data.branding_json : {},
          settings_json: data.settings_json && typeof data.settings_json === 'object' ? data.settings_json : {},
        },
      });
    } catch (err) {
      return responderError(req, res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // PATCH /partner/branding — la cooperativa edita su marca (no su plan)
  // body: { branding_json?, settings_json? (solo contacto/notas) }
  // ──────────────────────────────────────────────────────────────────
  app.patch('/partner/branding', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite editar la marca' });

      const db = orgClient(supabase, req);
      const { data: current, error: curError } = await db
        .from('organizations')
        .select('branding_json, settings_json')
        .maybeSingle();
      if (curError) throw curError;
      if (!current) return res.status(404).json({ error: 'Cooperativa no encontrada' });

      const updates = { updated_at: new Date().toISOString() };

      const incomingBranding = req.body?.branding_json;
      if (incomingBranding && typeof incomingBranding === 'object' && !Array.isArray(incomingBranding)) {
        updates.branding_json = {
          ...(current.branding_json && typeof current.branding_json === 'object' ? current.branding_json : {}),
          ...incomingBranding,
        };
      }

      // De settings, la cooperativa solo puede tocar contacto/notas. Lo comercial
      // (plan, digest_enabled, mia_enabled) lo controla Ruralicos.
      const incomingSettings = req.body?.settings_json;
      if (incomingSettings && typeof incomingSettings === 'object' && !Array.isArray(incomingSettings)) {
        const baseSettings = current.settings_json && typeof current.settings_json === 'object' ? current.settings_json : {};
        const merged = { ...baseSettings };
        for (const key of Object.keys(incomingSettings)) {
          if (SETTINGS_EDITABLES.has(key)) merged[key] = incomingSettings[key];
        }
        updates.settings_json = merged;
      }

      if (!updates.branding_json && !updates.settings_json) {
        return res.status(400).json({ error: 'No hay cambios validos para guardar' });
      }

      const { data, error } = await db
        .from('organizations')
        .update(updates)
        .select('id, slug, name, branding_json, settings_json')
        .single();
      if (error) throw error;

      return res.json({ ok: true, organization: data });
    } catch (err) {
      return responderError(req, res, err);
    }
  });
};
