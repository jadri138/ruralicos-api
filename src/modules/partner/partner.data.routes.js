// src/modules/partner/partner.data.routes.js
//
// Datos del panel PARTNER (cooperativa). TODO se filtra por req.org.organizationId
// gracias a requireOrg: una cooperativa solo ve y toca lo suyo.
//
// Escritura (alta/baja de socios, edicion de branding) limitada a roles owner/admin.
// agent/viewer son de solo lectura.

const { requireOrg } = require('../../middleware/requireAdmin');
const { normalizePhone, LONGITUD_TELEFONO } = require('../../shared/phoneNormalizer');

const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);
const ROLES_SOCIO = new Set(['admin', 'agent', 'viewer', 'member']);
const ROLES_ESCRITURA = new Set(['owner', 'admin']);
const SETTINGS_EDITABLES = new Set(['contact_name', 'contact_phone', 'contact_email', 'notes']);

function esTablaNoDisponible(error) {
  return MISSING_TABLE_CODES.has(error?.code);
}

function puedeEscribir(req) {
  return ROLES_ESCRITURA.has(req.org?.memberRole);
}

function socioPublico(user, member) {
  return {
    id: user.id,
    name: user.legal_name || user.name || `Socio ${user.id}`,
    phone: user.phone || null,
    email: user.email || null,
    subscription: user.subscription || 'free',
    member_role: member?.role || null,
    member_status: member?.status || null,
    created_at: user.created_at || null,
  };
}

module.exports = (app, supabase) => {
  // Carga los ids de socios de la organizacion (helper reutilizado).
  async function idsSociosDeOrg(organizationId) {
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', organizationId);
    if (error) throw error;
    return (data || []).map((u) => Number(u.id));
  }

  // ──────────────────────────────────────────────────────────────────
  // GET /partner/overview — metricas de la cooperativa
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/overview', requireOrg, async (req, res) => {
    try {
      const orgId = req.org.organizationId;
      const hace7dias = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();

      const { data: socios, error: errSocios } = await supabase
        .from('users')
        .select('id, subscription, created_at')
        .eq('organization_id', orgId);
      if (errSocios) throw errSocios;

      const ids = (socios || []).map((u) => Number(u.id));
      let digestsEnviados7d = 0;
      if (ids.length) {
        const { count, error: errDig } = await supabase
          .from('digests')
          .select('id', { count: 'exact', head: true })
          .in('user_id', ids)
          .eq('enviado', true)
          .gte('created_at', hace7dias);
        if (errDig && !esTablaNoDisponible(errDig)) throw errDig;
        digestsEnviados7d = count || 0;
      }

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
      console.error('Error en GET /partner/overview:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /partner/members — socios de la cooperativa
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/members', requireOrg, async (req, res) => {
    try {
      const orgId = req.org.organizationId;

      const [{ data: users, error }, membersResult] = await Promise.all([
        supabase
          .from('users')
          .select('id, name, legal_name, phone, email, subscription, organization_id, created_at')
          .eq('organization_id', orgId)
          .order('created_at', { ascending: false }),
        supabase
          .from('organization_members')
          .select('user_id, role, status')
          .eq('organization_id', orgId),
      ]);

      if (error) throw error;
      if (membersResult.error && !esTablaNoDisponible(membersResult.error)) {
        console.warn('[partner] organization_members no disponible:', membersResult.error.message);
      }

      const byId = new Map(
        (membersResult.error ? [] : membersResult.data || []).map((m) => [Number(m.user_id), m])
      );

      return res.json({
        ok: true,
        items: (users || []).map((u) => socioPublico(u, byId.get(Number(u.id)))),
      });
    } catch (err) {
      console.error('Error en GET /partner/members:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /partner/members — alta de socio por telefono (vincula un usuario
  // existente a la cooperativa). El socio debe estar ya registrado en Ruralicos.
  // ──────────────────────────────────────────────────────────────────
  app.post('/partner/members', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite dar de alta socios' });

      const orgId = req.org.organizationId;
      const phone = normalizePhone(req.body?.phone || '');
      const role = ROLES_SOCIO.has(req.body?.role) ? req.body.role : 'member';

      if (phone.length !== LONGITUD_TELEFONO) {
        return res.status(400).json({ error: 'Telefono no valido' });
      }

      const { data: user, error: findError } = await supabase
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

      const { data: updated, error: updError } = await supabase
        .from('users')
        .update({ organization_id: orgId })
        .eq('id', user.id)
        .select('id, name, legal_name, phone, email, subscription, organization_id, created_at')
        .single();
      if (updError) throw updError;

      const memberResult = await supabase
        .from('organization_members')
        .upsert({
          organization_id: orgId,
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
      console.error('Error en POST /partner/members:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // PATCH /partner/members/:userId — cambia el rol del socio
  // ──────────────────────────────────────────────────────────────────
  app.patch('/partner/members/:userId', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite editar socios' });

      const orgId = req.org.organizationId;
      const userId = Number(req.params.userId);
      const role = req.body?.role;
      if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'user id invalido' });
      if (!ROLES_SOCIO.has(role)) return res.status(400).json({ error: 'role invalido' });

      // El socio debe pertenecer a esta org.
      const { data: user, error: findError } = await supabase
        .from('users')
        .select('id')
        .eq('id', userId)
        .eq('organization_id', orgId)
        .maybeSingle();
      if (findError) throw findError;
      if (!user) return res.status(404).json({ error: 'Socio no pertenece a esta cooperativa' });

      const { data, error } = await supabase
        .from('organization_members')
        .upsert({
          organization_id: orgId,
          user_id: userId,
          role,
          status: 'active',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'organization_id,user_id' })
        .select('user_id, role, status')
        .maybeSingle();
      if (error && !esTablaNoDisponible(error)) throw error;

      return res.json({ ok: true, member: data || { user_id: userId, role, status: 'active' } });
    } catch (err) {
      console.error('Error en PATCH /partner/members/:userId:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // DELETE /partner/members/:userId — baja del socio en la cooperativa
  // ──────────────────────────────────────────────────────────────────
  app.delete('/partner/members/:userId', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite dar de baja socios' });

      const orgId = req.org.organizationId;
      const userId = Number(req.params.userId);
      if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'user id invalido' });

      const { data: user, error: updError } = await supabase
        .from('users')
        .update({ organization_id: null })
        .eq('id', userId)
        .eq('organization_id', orgId)
        .select('id')
        .maybeSingle();
      if (updError) throw updError;
      if (!user) return res.status(404).json({ error: 'Socio no pertenece a esta cooperativa' });

      await supabase
        .from('organization_members')
        .update({ status: 'inactive', updated_at: new Date().toISOString() })
        .eq('organization_id', orgId)
        .eq('user_id', userId);

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error en DELETE /partner/members/:userId:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /partner/digests — ultimos digests enviados a los socios
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/digests', requireOrg, async (req, res) => {
    try {
      const orgId = req.org.organizationId;
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

      const ids = await idsSociosDeOrg(orgId);
      if (!ids.length) return res.json({ ok: true, items: [] });

      const { data, error } = await supabase
        .from('digests')
        .select('id, user_id, fecha, enviado, enviado_at, created_at, alerta_ids')
        .in('user_id', ids)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        if (esTablaNoDisponible(error)) return res.json({ ok: true, items: [] });
        throw error;
      }

      const items = (data || []).map((d) => ({
        id: d.id,
        user_id: d.user_id,
        fecha: d.fecha,
        enviado: d.enviado,
        enviado_at: d.enviado_at,
        created_at: d.created_at,
        num_alertas: Array.isArray(d.alerta_ids) ? d.alerta_ids.length : 0,
      }));

      return res.json({ ok: true, items });
    } catch (err) {
      console.error('Error en GET /partner/digests:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /partner/branding — branding + ajustes editables de la cooperativa
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/branding', requireOrg, async (req, res) => {
    try {
      const orgId = req.org.organizationId;
      const { data, error } = await supabase
        .from('organizations')
        .select('id, slug, name, kind, status, branding_json, settings_json')
        .eq('id', orgId)
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
      console.error('Error en GET /partner/branding:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // PATCH /partner/branding — la cooperativa edita su marca (no su plan)
  // body: { branding_json?, settings_json? (solo contacto/notas) }
  // ──────────────────────────────────────────────────────────────────
  app.patch('/partner/branding', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) return res.status(403).json({ error: 'Tu rol no permite editar la marca' });

      const orgId = req.org.organizationId;
      const { data: current, error: curError } = await supabase
        .from('organizations')
        .select('branding_json, settings_json')
        .eq('id', orgId)
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

      const { data, error } = await supabase
        .from('organizations')
        .update(updates)
        .eq('id', orgId)
        .select('id, slug, name, branding_json, settings_json')
        .single();
      if (error) throw error;

      return res.json({ ok: true, organization: data });
    } catch (err) {
      console.error('Error en PATCH /partner/branding:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
