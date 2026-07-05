// src/modules/partner/partner.plan.routes.js
//
// Plan de facturacion B2B de la cooperativa (auto-servicio). La coop ve su plan
// y consumo de socios y puede cambiarlo ella misma (owner/admin). El plan vive
// en organizations.settings_json.billing_band; NO confundir con el plan B2C del
// socio (config/planes.js). El catalogo de bandas es la fuente de verdad y se
// devuelve al frontend para que no haya precios duplicados/desfasados.

const { requireOrg } = require('../../middleware/requireAdmin');

const ROLES_ESCRITURA = new Set(['owner', 'admin']);

// Bandas de facturacion: capacidad incluida, precio base/mes y €/socio adicional.
const BANDS = [
  { key: 'micro', label: 'Micro', limite: 25, base: 79, extra: 3.2 },
  { key: 'pequena', label: 'Pequeña', limite: 50, base: 119, extra: 2.4 },
  { key: 'basica', label: 'Básica', limite: 100, base: 199, extra: 2.0 },
  { key: 'media', label: 'Media', limite: 250, base: 449, extra: 1.8 },
  { key: 'pro', label: 'Pro', limite: 500, base: 749, extra: 1.5 },
  { key: 'avanzada', label: 'Avanzada', limite: 1000, base: 1199, extra: 1.2 },
  { key: 'grande', label: 'Grande', limite: 2000, base: 1999, extra: 1.0 },
  { key: 'xl', label: 'XL', limite: 5000, base: 3499, extra: 0.7 },
];

const BAND_KEYS = new Set(BANDS.map((b) => b.key));

function puedeEscribir(req) {
  return ROLES_ESCRITURA.has(req.org?.memberRole);
}

function bandByKey(key) {
  return BANDS.find((b) => b.key === key) || null;
}

// Banda mas pequeña cuyo limite cubre a los socios actuales (para recomendar).
function bandaRecomendada(socios) {
  return (BANDS.find((b) => b.limite >= socios) || BANDS[BANDS.length - 1]).key;
}

function calcularPrecio(band, socios) {
  if (!band) return null;
  const extras = Math.max(0, socios - band.limite);
  const extrasCoste = extras * band.extra;
  const next = BANDS[BANDS.findIndex((b) => b.key === band.key) + 1] || null;
  const total = band.base + extrasCoste;
  return {
    base: band.base,
    extra_unit: band.extra,
    extras,
    extras_coste: Math.round(extrasCoste),
    total: Math.round(total),
    limite: band.limite,
    conviene_subir: Boolean(next && extras > 0 && total >= next.base),
    next_band: next ? next.key : null,
  };
}

module.exports = (app, supabase) => {
  async function contarSocios(orgId) {
    const { count, error } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId);
    if (error) throw error;
    return count || 0;
  }

  async function construirRespuestaPlan(req, orgId) {
    const { data: org, error } = await supabase
      .from('organizations')
      .select('id, name, settings_json')
      .eq('id', orgId)
      .maybeSingle();
    if (error) throw error;
    if (!org) return null;

    const settings = org.settings_json && typeof org.settings_json === 'object' ? org.settings_json : {};
    const socios = await contarSocios(orgId);
    const currentBand = bandByKey(settings.billing_band);

    return {
      ok: true,
      can_edit: puedeEscribir(req),
      bands: BANDS,
      current_band: currentBand ? currentBand.key : null,
      socios,
      billing_status: settings.billing_status || 'gratis',
      next_charge: settings.billing_next_charge || null,
      recommended_band: bandaRecomendada(socios),
      price: calcularPrecio(currentBand, socios),
    };
  }

  // GET /partner/plan — plan actual + consumo + catalogo de bandas.
  app.get('/partner/plan', requireOrg, async (req, res) => {
    try {
      const plan = await construirRespuestaPlan(req, req.org.organizationId);
      if (!plan) return res.status(404).json({ error: 'Cooperativa no encontrada' });
      return res.json(plan);
    } catch (err) {
      console.error('Error en GET /partner/plan:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /partner/plan { band } — la cooperativa cambia su plan (auto-servicio).
  app.post('/partner/plan', requireOrg, async (req, res) => {
    try {
      if (!puedeEscribir(req)) {
        return res.status(403).json({ error: 'Tu rol no permite cambiar el plan' });
      }

      const band = String(req.body?.band || '').trim();
      if (!BAND_KEYS.has(band)) {
        return res.status(400).json({ error: 'Plan no valido' });
      }

      const orgId = req.org.organizationId;
      const { data: current, error: curError } = await supabase
        .from('organizations')
        .select('settings_json')
        .eq('id', orgId)
        .maybeSingle();
      if (curError) throw curError;
      if (!current) return res.status(404).json({ error: 'Cooperativa no encontrada' });

      const baseSettings = current.settings_json && typeof current.settings_json === 'object' ? current.settings_json : {};
      const settings = { ...baseSettings, billing_band: band };

      const { error: updError } = await supabase
        .from('organizations')
        .update({ settings_json: settings, updated_at: new Date().toISOString() })
        .eq('id', orgId);
      if (updError) throw updError;

      const plan = await construirRespuestaPlan(req, orgId);
      return res.json(plan);
    } catch (err) {
      console.error('Error en POST /partner/plan:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
