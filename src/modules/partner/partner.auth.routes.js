// src/modules/partner/partner.auth.routes.js
//
// Autenticacion del panel PARTNER (personal de cooperativa).
// Distinto del admin de Ruralicos (admin_users) y de los socios (users).
// El token lleva organization_id y role 'org'; requireOrg filtra todo por esa org.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { requireOrg } = require('../../middleware/requireAdmin');

const TOKEN_TTL = '12h';

function normalizarEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function publicOrganization(org) {
  if (!org) return null;
  return {
    id: org.id,
    slug: org.slug || null,
    name: org.name || null,
    kind: org.kind || 'cooperativa',
    status: org.status || 'active',
    branding_json: org.branding_json && typeof org.branding_json === 'object' ? org.branding_json : {},
  };
}

function publicStaff(staff) {
  if (!staff) return null;
  return {
    id: staff.id,
    email: staff.email,
    name: staff.name || null,
    organization_id: staff.organization_id,
    member_role: staff.member_role || 'viewer',
  };
}

function firmarTokenOrg(staff) {
  return jwt.sign(
    {
      sub: staff.id,
      role: 'org',
      organization_id: staff.organization_id,
      member_role: staff.member_role || 'viewer',
      name: staff.name || null,
    },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

module.exports = (app, supabase) => {
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Prueba de nuevo en unos minutos.' },
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /partner/branding/:slug  (publico)
  // Permite pintar el login con el logo/colores de la cooperativa antes de
  // autenticar. Solo expone datos de marca, nada sensible.
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/branding/:slug', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim().toLowerCase().slice(0, 80);
      if (!slug) return res.status(400).json({ error: 'Slug requerido' });

      const { data, error } = await supabase
        .from('organizations')
        .select('id, slug, name, kind, status, branding_json')
        .eq('slug', slug)
        .maybeSingle();

      if (error) throw error;

      if (!data) return res.status(404).json({ error: 'Cooperativa no encontrada' });
      return res.json({ ok: true, available: true, organization: publicOrganization(data) });
    } catch (err) {
      console.error('Error en /partner/branding/:slug:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /partner/login   body: { email, password }
  // ──────────────────────────────────────────────────────────────────
  app.post('/partner/login', loginLimiter, async (req, res) => {
    try {
      const email = normalizarEmail(req.body?.email);
      const password = String(req.body?.password || '');

      if (!email || !password) {
        return res.status(400).json({ error: 'Faltan credenciales' });
      }

      const { data: staff, error } = await supabase
        .from('organization_staff')
        .select('id, organization_id, email, name, password_hash, member_role, status')
        .eq('email', email)
        .maybeSingle();

      if (error) {
        console.error('Error consultando organization_staff:', error.message);
        return res.status(500).json({ error: 'Error interno' });
      }

      if (!staff || !staff.password_hash) {
        return res.status(401).json({ error: 'Credenciales invalidas' });
      }

      const ok = await bcrypt.compare(password, staff.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Credenciales invalidas' });
      }

      if (staff.status === 'disabled') {
        return res.status(403).json({ error: 'Cuenta desactivada. Contacta con Ruralicos.' });
      }

      // La cooperativa debe estar operativa.
      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .select('id, slug, name, kind, status, branding_json')
        .eq('id', staff.organization_id)
        .maybeSingle();

      if (orgError) {
        console.error('Error cargando organization en login:', orgError.message);
        return res.status(500).json({ error: 'Error interno' });
      }

      if (!org || org.status === 'disabled') {
        return res.status(403).json({ error: 'Cooperativa no activa. Contacta con Ruralicos.' });
      }

      // Sello de ultimo acceso (no bloqueante).
      supabase
        .from('organization_staff')
        .update({ last_login_at: new Date().toISOString() })
        .eq('id', staff.id)
        .then(({ error: updErr }) => {
          if (updErr) console.warn('[partner] no se pudo sellar last_login_at:', updErr.message);
        });

      const token = firmarTokenOrg(staff);

      return res.json({
        token,
        staff: publicStaff(staff),
        organization: publicOrganization(org),
      });
    } catch (err) {
      console.error('Error en /partner/login:', err);
      return res.status(500).json({ error: 'Error interno en login' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /partner/me   (requireOrg) — restaura sesion + branding actual
  // ──────────────────────────────────────────────────────────────────
  app.get('/partner/me', requireOrg, async (req, res) => {
    try {
      const { staffId, organizationId, memberRole, impersonatedBy } = req.org;

      const [{ data: staff }, { data: org, error: orgError }] = await Promise.all([
        supabase
          .from('organization_staff')
          .select('id, organization_id, email, name, member_role, status')
          .eq('id', staffId)
          .maybeSingle(),
        supabase
          .from('organizations')
          .select('id, slug, name, kind, status, branding_json')
          .eq('id', organizationId)
          .maybeSingle(),
      ]);

      if (orgError) throw orgError;
      if (!org) return res.status(404).json({ error: 'Cooperativa no encontrada' });

      return res.json({
        ok: true,
        staff: staff
          ? publicStaff(staff)
          // En impersonacion no hay fila de staff: reconstruimos desde el token.
          : { id: staffId, organization_id: organizationId, member_role: memberRole, name: 'Soporte Ruralicos', email: null },
        organization: publicOrganization(org),
        impersonated: Boolean(impersonatedBy),
      });
    } catch (err) {
      console.error('Error en /partner/me:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
  });
};
