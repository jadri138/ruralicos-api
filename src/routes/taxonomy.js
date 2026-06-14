const {
  VALIDACION_TAXONOMIA,
  buscarSugerenciasTaxonomia,
  construirPreferenciasDesdeTexto,
  normalizarTextoTaxonomia,
} = require('../modules/aprendizaje/taxonomiaRuralicos');

const TIPOS_TAXONOMIA_PERMITIDOS = new Set(['sector', 'subsector', 'concepto', 'accion', 'entidad', 'tramite']);
const MAX_SUGGEST_QUERY_LENGTH = 80;
const MAX_PARSE_TEXT_LENGTH = 1200;

function limpiarTexto(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function limitarTexto(value, maxLength) {
  return limpiarTexto(value).slice(0, maxLength).trim();
}

function leerLimite(value, fallback = 8) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

function leerTipoTaxonomia(value) {
  const type = normalizarTextoTaxonomia(value);
  return TIPOS_TAXONOMIA_PERMITIDOS.has(type) ? type : null;
}

module.exports = (app) => {
  app.get('/taxonomy/suggest', (req, res) => {
    try {
      const q = limitarTexto(req.query?.q || req.query?.query, MAX_SUGGEST_QUERY_LENGTH);
      const type = leerTipoTaxonomia(req.query?.type || req.query?.tipo);
      const limit = leerLimite(req.query?.limit, 8);

      return res.json({
        ok: true,
        q,
        type,
        suggestions: buscarSugerenciasTaxonomia(q, {
          limit,
          type,
          includeAliases: true,
        }),
        taxonomy: {
          ok: VALIDACION_TAXONOMIA.ok,
          total: VALIDACION_TAXONOMIA.total,
          feedback_topics: VALIDACION_TAXONOMIA.feedback_topics,
        },
      });
    } catch (err) {
      console.error('Error en GET /taxonomy/suggest:', err);
      return res.status(500).json({ error: 'Error generando sugerencias de taxonomia' });
    }
  });

  app.post('/taxonomy/parse', (req, res) => {
    try {
      const texto = limpiarTexto(
        req.body?.texto ||
        req.body?.text ||
        req.body?.q ||
        req.body?.preferencias_extra
      );

      if (texto.length < 2) {
        return res.status(400).json({ error: 'Texto requerido' });
      }

      if (texto.length > MAX_PARSE_TEXT_LENGTH) {
        return res.status(413).json({ error: 'Texto demasiado largo' });
      }

      const result = construirPreferenciasDesdeTexto(texto);

      return res.json({
        ok: true,
        parsed: result.ok,
        saved: false,
        requires_confirmation: result.ok,
        message: result.ok
          ? 'Confirma estas sugerencias antes de guardar preferencias.'
          : 'No se han detectado preferencias estructuradas.',
        result,
      });
    } catch (err) {
      console.error('Error en POST /taxonomy/parse:', err);
      return res.status(500).json({ error: 'Error interpretando preferencias' });
    }
  });
};
