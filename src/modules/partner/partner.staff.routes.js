// src/modules/partner/partner.staff.routes.js
//
// Gestion de credenciales de cooperativa DESDE el admin de Ruralicos.
// El admin da de alta al responsable de cada cooperativa con su email y una
// contrasena inicial. Endpoints protegidos por requireAdmin.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { validarPassword } = require('../../shared/passwordPolicy');

const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);
const UNIQUE_VIOLATION = '23505';
const ROLES_VALIDOS = new Set(['owner', 'admin', 'agent', 'viewer']);
const STATUS_VALIDOS = new Set(['active', 'disabled']);

function esTablaNoDisponible(error) {
  return MISSING_TABLE_CODES.has(error?.code);
}

function normalizarEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizarOrgId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function publicStaff(staff) {
  if (!staff) return null;
  return {
    id: staff.id,
    organization_id: staff.organization_id,
    email: staff.email,
    name: staff.name || null,
    member_role: staff.member_role || 'viewer',
    status: staff.status || 'active',
    last_login_at: staff.last_login_at || null,
    created_at: staff.created_at || null,
  };
}

const SELECT_COLS = 'id, organization_id, email, name, member_role, status, last_login_at, created_at';

module.exports = (app, supabase) => {
  // ──────────────────────────────────────────────────────────────────
  // GET /admin/organizations/:id/staff
  // ──────────────────────────────────────────────────────────────────
  app.get('/admin/organizations/:id/staff', requireAdmin, async (req, res) => {
    try {
      const organizationId = normalizarOrgId(req.params.id);
      if (!organizationId) return res.status(400).json({ error: 'organization_id invalido' });

      const { data, error } = await supabase
        .from('organization_staff')
        .select(SELECT_COLS)
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: true });

      if (error) {
        if (esTablaNoDisponible(error)) {
          return res.json({ ok: true, available: false, reason: 'organization_staff_no_disponible', items: [] });
        }
        throw error;
      }

      return res.json({ ok: true, available: true, items: (data || []).map(publicStaff) });
    } catch (err) {
      console.error('Error en GET /admin/organizations/:id/staff:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /admin/organizations/:id/staff
  // body: { email, name?, password, member_role? }
  // ──────────────────────────────────────────────────────────────────
  app.post('/admin/organizations/:id/staff', requireAdmin, async (req, res) => {
    try {
      const organizationId = normalizarOrgId(req.params.id);
      if (!organizationId) return res.status(400).json({ error: 'organization_id invalido' });

      const email = normalizarEmail(req.body?.email);
      const password = String(req.body?.password || '');
      const name = req.body?.name ? String(req.body.name).trim().slice(0, 160) : null;
      const memberRole = ROLES_VALIDOS.has(req.body?.member_role) ? req.body.member_role : 'admin';

      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Email invalido' });
      }

      const passwordValidation = validarPassword(password);
      if (!passwordValidation.ok) {
        return res.status(400).json({
          error: passwordValidation.error,
          code: 'password_policy',
          requirements: passwordValidation.requirements,
        });
      }

      // La organizacion debe existir.
      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .select('id')
        .eq('id', organizationId)
        .maybeSingle();
      if (orgError) {
        if (esTablaNoDisponible(orgError)) {
          return res.json({ ok: true, available: false, reason: 'organizations_no_disponible' });
        }
        throw orgError;
      }
      if (!org) return res.status(404).json({ error: 'Cooperativa no encontrada' });

      const password_hash = await bcrypt.hash(password, 10);

      const { data, error } = await supabase
        .from('organization_staff')
        .insert({ organization_id: organizationId, email, name, password_hash, member_role: memberRole })
        .select(SELECT_COLS)
        .maybeSingle();

      if (error) {
        if (esTablaNoDisponible(error)) {
          return res.json({ ok: true, available: false, reason: 'organization_staff_no_disponible' });
        }
        if (error.code === UNIQUE_VIOLATION) {
          return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });
        }
        throw error;
      }

      return res.status(201).json({ ok: true, item: publicStaff(data) });
    } catch (err) {
      console.error('Error en POST /admin/organizations/:id/staff:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // PATCH /admin/organizations/:id/staff/:staffId
  // body: { name?, member_role?, status?, password? }
  // ──────────────────────────────────────────────────────────────────
  app.patch('/admin/organizations/:id/staff/:staffId', requireAdmin, async (req, res) => {
    try {
      const organizationId = normalizarOrgId(req.params.id);
      const staffId = normalizarOrgId(req.params.staffId);
      if (!organizationId || !staffId) return res.status(400).json({ error: 'Parametros invalidos' });

      const updates = { updated_at: new Date().toISOString() };

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
        updates.name = req.body.name ? String(req.body.name).trim().slice(0, 160) : null;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'member_role')) {
        if (!ROLES_VALIDOS.has(req.body.member_role)) {
          return res.status(400).json({ error: 'member_role invalido' });
        }
        updates.member_role = req.body.member_role;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
        if (!STATUS_VALIDOS.has(req.body.status)) {
          return res.status(400).json({ error: 'status invalido' });
        }
        updates.status = req.body.status;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'password')) {
        const password = String(req.body.password || '');
        const passwordValidation = validarPassword(password);
        if (!passwordValidation.ok) {
          return res.status(400).json({
            error: passwordValidation.error,
            code: 'password_policy',
            requirements: passwordValidation.requirements,
          });
        }
        updates.password_hash = await bcrypt.hash(password, 10);
      }

      const { data, error } = await supabase
        .from('organization_staff')
        .update(updates)
        .eq('id', staffId)
        .eq('organization_id', organizationId)
        .select(SELECT_COLS)
        .maybeSingle();

      if (error) {
        if (esTablaNoDisponible(error)) {
          return res.json({ ok: true, available: false, reason: 'organization_staff_no_disponible' });
        }
        throw error;
      }
      if (!data) return res.status(404).json({ error: 'Cuenta no encontrada' });

      return res.json({ ok: true, item: publicStaff(data) });
    } catch (err) {
      console.error('Error en PATCH /admin/organizations/:id/staff/:staffId:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /admin/organizations/:id/impersonate
  // El admin de Ruralicos genera un token de cooperativa para dar soporte
  // ("entrar como"). Token corto y marcado con impersonated_by + auditado.
  // ──────────────────────────────────────────────────────────────────
  app.post('/admin/organizations/:id/impersonate', requireAdmin, async (req, res) => {
    try {
      const organizationId = normalizarOrgId(req.params.id);
      if (!organizationId) return res.status(400).json({ error: 'organization_id invalido' });

      const { data: org, error } = await supabase
        .from('organizations')
        .select('id, slug, name, kind, status, branding_json')
        .eq('id', organizationId)
        .maybeSingle();
      if (error) {
        if (esTablaNoDisponible(error)) {
          return res.json({ ok: true, available: false, reason: 'organizations_no_disponible' });
        }
        throw error;
      }
      if (!org) return res.status(404).json({ error: 'Cooperativa no encontrada' });

      const adminId = req.admin?.sub || null;
      const token = jwt.sign(
        {
          sub: `admin:${adminId}`,
          role: 'org',
          organization_id: organizationId,
          member_role: 'admin',
          name: 'Soporte Ruralicos',
          impersonated_by: adminId,
        },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );

      // Auditoria best-effort (no bloquea la respuesta).
      supabase
        .from('admin_audit_log')
        .insert({
          admin_user_id: adminId,
          actor_username: req.admin?.username || null,
          organization_id: organizationId,
          action: 'organization.impersonate',
          resource_type: 'organization',
          resource_id: organizationId,
          metadata_json: { slug: org.slug },
        })
        .then(({ error: auditErr }) => {
          if (auditErr) console.warn('[partner] no se pudo auditar impersonate:', auditErr.message);
        });

      return res.json({
        ok: true,
        token,
        organization: {
          id: org.id,
          slug: org.slug || null,
          name: org.name || null,
          kind: org.kind || 'cooperativa',
          status: org.status || 'active',
          branding_json: org.branding_json && typeof org.branding_json === 'object' ? org.branding_json : {},
        },
      });
    } catch (err) {
      console.error('Error en POST /admin/organizations/:id/impersonate:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // DELETE /admin/organizations/:id/staff/:staffId
  // ──────────────────────────────────────────────────────────────────
  app.delete('/admin/organizations/:id/staff/:staffId', requireAdmin, async (req, res) => {
    try {
      const organizationId = normalizarOrgId(req.params.id);
      const staffId = normalizarOrgId(req.params.staffId);
      if (!organizationId || !staffId) return res.status(400).json({ error: 'Parametros invalidos' });

      const { error } = await supabase
        .from('organization_staff')
        .delete()
        .eq('id', staffId)
        .eq('organization_id', organizationId);

      if (error) {
        if (esTablaNoDisponible(error)) {
          return res.json({ ok: true, available: false, reason: 'organization_staff_no_disponible' });
        }
        throw error;
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error en DELETE /admin/organizations/:id/staff/:staffId:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
