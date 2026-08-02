// Adaptador temporal de la API histórica. Las escrituras nuevas van únicamente
// a `user_memory`, que es la memoria atómica canónica. La tabla
// `mia_structured_memory` se conserva solo para lectura y borrado de privacidad.
const crypto = require('crypto');
const {
  construirMemoriasDesdeDecision,
  guardarMemoriasAtomicas,
  inferirTopic,
  inferirPolarity,
  normalizarTexto,
} = require('../aprendizaje/atomicMemory');

function construirMemoriasEstructuradas(options = {}) {
  return construirMemoriasDesdeDecision(options);
}

async function registrarMemoriaEstructuradaMIA(supabase, options = {}) {
  const rows = construirMemoriasEstructuradas(options);

  try {
    const result = await guardarMemoriasAtomicas(supabase, rows);
    return {
      ...result,
      available: true,
      canonical_table: 'user_memory',
    };
  } catch (error) {
    console.warn('[mia:atomic_memory] No se pudo registrar memoria:', error.message);
    return {
      ok: false,
      available: false,
      inserted: 0,
      merged: 0,
      canonical_table: 'user_memory',
      error: error.message,
    };
  }
}

module.exports = {
  construirMemoriasEstructuradas,
  registrarMemoriaEstructuradaMIA,
  inferirTopic,
  inferirPolarity,
  hashDetalle: (texto) => crypto
    .createHash('sha256')
    .update(normalizarTexto(texto).slice(0, 500))
    .digest('hex'),
};
