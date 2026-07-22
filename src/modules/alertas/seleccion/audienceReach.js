const { canonicalSector } = require('../../../shared/preferenceCanonical');
const {
  analizarCoherenciaTematica,
  esAlertaSanidadAnimal,
  esAlertaSanidadVegetal,
} = require('../../../shared/sectorTaxonomy');
const { diagnosticarAlertaUsuario } = require('./alertaMatcher');

function lista(value) {
  return Array.isArray(value) ? value : [];
}

function porcentaje(part, total) {
  return total ? Number((Number(part || 0) / total).toFixed(4)) : 0;
}

function sumar(map, key) {
  const safe = key || 'sin_dato';
  map[safe] = (map[safe] || 0) + 1;
}

function clasificarSectorUsuario(user = {}) {
  const sectors = lista(user.preferences?.sectores).map(canonicalSector).filter(Boolean);
  const hasAgriculture = sectors.includes('agricultura');
  const hasLivestock = sectors.includes('ganaderia');
  if (sectors.includes('mixto') || (hasAgriculture && hasLivestock)) return 'mixto';
  if (hasLivestock) return 'ganaderia';
  if (hasAgriculture) return 'agriculture_only';
  return sectors[0] || 'sin_sector';
}

function esSectorIncompatible(alerta = {}, sector = '') {
  if (esAlertaSanidadAnimal(alerta)) return ['agriculture_only', 'sin_sector'].includes(sector);
  if (esAlertaSanidadVegetal(alerta)) return ['ganaderia', 'sin_sector'].includes(sector);
  return false;
}

function diagnosticarTaxonomiaAmplia(alerta = {}) {
  const thematic = analizarCoherenciaTematica(alerta, alerta);
  const validation = alerta.taxonomy_validation || {};
  const tooManySectors = lista(alerta.sectores).length > 2;
  const tooManySubsectors = lista(alerta.subsectores).length > 10;
  const conflicting = ['blocked', 'incoherent'].includes(validation.status) || thematic.ok === false;
  return {
    overbroad: tooManySectors || tooManySubsectors || conflicting,
    conflicting,
    thematic_status: thematic.status,
    sector_count: lista(alerta.sectores).length,
    subsector_count: lista(alerta.subsectores).length,
  };
}

function calcularCuotaDominanciaDigest(alertPlacements = 0, totalPlacements = 0) {
  return porcentaje(Number(alertPlacements || 0), Number(totalPlacements || 0));
}

function construirSnapshotAlcance(reach = {}, { fecha = null } = {}) {
  return {
    version: reach.version || 'audience_reach_v1',
    alert_id: reach.alert_id ?? null,
    fecha,
    eligible_users: Number(reach.eligible_users || 0),
    matched_users: Number(reach.matched_users || 0),
    excluded_users: Number(reach.excluded_users || 0),
    reach_ratio: Number(reach.reach_ratio || 0),
    daily_digest_share: Number(reach.daily_digest_share || 0),
    matched_by_sector: reach.matched_by_sector || {},
    matched_by_province: reach.matched_by_province || {},
    matched_by_reason: reach.matched_by_reason || {},
    excluded_by_reason: reach.excluded_by_reason || {},
    incompatible_matches: Number(reach.incompatible_matches || 0),
    taxonomy: reach.taxonomy || {},
    flags: lista(reach.flags),
    action: reach.action === 'block' ? 'block' : 'observe',
  };
}

async function registrarSnapshotAlcance(supabase, alertaId, reach, options = {}) {
  const updatedAt = options.updatedAt || new Date().toISOString();
  const snapshot = construirSnapshotAlcance(reach, { fecha: options.fecha || null });
  let query = supabase
    .from('alertas')
    .update({ audience_reach: snapshot, audience_reach_updated_at: updatedAt })
    .eq('id', alertaId);
  if (options.organizationId) query = query.eq('organization_id', options.organizationId);
  const { error } = await query;
  if (error) throw error;
  return { snapshot, updated_at: updatedAt };
}

function analizarAlcanceAudiencia(alerta = {}, users = [], options = {}) {
  const matcher = options.matcher || diagnosticarAlertaUsuario;
  const eligible = (users || []).filter((user) => user && user.subscription !== 'free');
  const matches = [];
  const excluded = [];
  const matchedBySector = {};
  const matchedByProvince = {};
  const matchedByReason = {};
  const excludedByReason = {};
  let incompatibleMatches = 0;

  for (const user of eligible) {
    const result = matcher(alerta, user, options.matcherOptions || {});
    const sector = clasificarSectorUsuario(user);
    if (result?.ok) {
      matches.push({ user_id: user.id ?? null, sector, reason: result.motivo || 'coincide' });
      sumar(matchedBySector, sector);
      sumar(matchedByReason, result.motivo || 'coincide');
      const provinces = lista(user.preferences?.provincias);
      if (provinces.length === 0) sumar(matchedByProvince, 'sin_provincia');
      else provinces.forEach((province) => sumar(matchedByProvince, String(province).toLowerCase()));
      if (esSectorIncompatible(alerta, sector)) incompatibleMatches++;
    } else {
      const reason = result?.motivo || result?.reason || 'sin_coincidencia';
      excluded.push({ user_id: user.id ?? null, sector, reason });
      sumar(excludedByReason, reason);
    }
  }

  const reachRatio = porcentaje(matches.length, eligible.length);
  const dailyDigestShare = Number(options.singleAlertDigestShare || 0);
  const taxonomy = diagnosticarTaxonomiaAmplia(alerta);
  const highReach = eligible.length > 0 && reachRatio >= Number(options.highReachRatio ?? 0.7);
  const flags = [];
  if (highReach) flags.push('unexpected_audience_expansion');
  if (incompatibleMatches > 0) flags.push('cross_sector_mass_match');
  if (taxonomy.overbroad) flags.push('taxonomy_overbreadth');
  if (dailyDigestShare >= Number(options.dominanceRatio ?? 0.6)) {
    flags.push('single_alert_dominates_daily_digest');
  }
  const shouldBlock = highReach && incompatibleMatches > 0 && taxonomy.conflicting;

  return {
    version: 'audience_reach_v1',
    alert_id: alerta.id ?? null,
    eligible_users: eligible.length,
    matched_users: matches.length,
    excluded_users: excluded.length,
    reach_ratio: reachRatio,
    daily_digest_share: dailyDigestShare,
    matched_by_sector: matchedBySector,
    matched_by_province: matchedByProvince,
    matched_by_reason: matchedByReason,
    excluded_by_reason: excludedByReason,
    incompatible_matches: incompatibleMatches,
    taxonomy,
    flags,
    action: shouldBlock ? 'block' : 'observe',
    matches,
    excluded,
  };
}

module.exports = {
  analizarAlcanceAudiencia,
  calcularCuotaDominanciaDigest,
  clasificarSectorUsuario,
  construirSnapshotAlcance,
  diagnosticarTaxonomiaAmplia,
  esSectorIncompatible,
  registrarSnapshotAlcance,
};
