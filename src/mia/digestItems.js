const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);
const { conOrganizationId } = require('./organizationContext');

function esTablaNoDisponible(error) {
  return MISSING_TABLE_CODES.has(error?.code);
}

function resumenUsado(alerta = {}) {
  return String(alerta.resumen_final || alerta.resumen || alerta.titulo || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function tagsAlerta(alerta = {}) {
  return {
    provincias: Array.isArray(alerta.provincias) ? alerta.provincias : [],
    sectores: Array.isArray(alerta.sectores) ? alerta.sectores : [],
    subsectores: Array.isArray(alerta.subsectores) ? alerta.subsectores : [],
    tipos_alerta: Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : [],
    fuente: alerta.fuente || null,
  };
}

function construirDigestItems({
  digestId,
  userId,
  fecha,
  alertas = [],
  origen = 'desconocido',
  organizationId = null,
}) {
  return (alertas || [])
    .map((alerta, index) => conOrganizationId({
      digest_id: digestId,
      user_id: userId,
      fecha,
      item_numero: index + 1,
      alerta_id: alerta.id,
      score: Number.isFinite(Number(alerta.similitud)) ? Number(alerta.similitud) : null,
      motivo_seleccion: origen,
      resumen_usado: resumenUsado(alerta),
      tags_json: tagsAlerta(alerta),
    }, organizationId))
    .filter((row) => row.digest_id && row.user_id && row.alerta_id && row.item_numero > 0);
}

async function registrarDigestItemsMIA(supabase, options = {}) {
  const rows = construirDigestItems(options);
  if (rows.length === 0) return { ok: true, available: true, inserted: 0 };

  try {
    const { error } = await supabase
      .from('digest_items')
      .upsert(rows, { onConflict: 'digest_id,item_numero' });

    if (error) throw error;
    return { ok: true, available: true, inserted: rows.length };
  } catch (error) {
    if (esTablaNoDisponible(error)) {
      return {
        ok: true,
        available: false,
        inserted: 0,
        reason: 'digest_items_no_disponible',
      };
    }

    console.warn('[mia:digest_items] No se pudieron registrar digest_items:', error.message);
    return {
      ok: false,
      available: false,
      inserted: 0,
      error: error.message,
    };
  }
}

async function cargarDigestItemsMIA(supabase, digestId) {
  if (!digestId) return null;

  try {
    const { data, error } = await supabase
      .from('digest_items')
      .select('item_numero, alerta_id, score, motivo_seleccion, resumen_usado, tags_json')
      .eq('digest_id', digestId)
      .order('item_numero', { ascending: true });

    if (error) throw error;
    return data || [];
  } catch (error) {
    if (esTablaNoDisponible(error)) return null;
    console.warn('[mia:digest_items] No se pudieron cargar digest_items:', error.message);
    return null;
  }
}

module.exports = {
  construirDigestItems,
  registrarDigestItemsMIA,
  cargarDigestItemsMIA,
};
