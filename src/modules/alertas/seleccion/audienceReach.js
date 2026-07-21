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
  const taxonomy = diagnosticarTaxonomiaAmplia(alerta);
  const highReach = eligible.length > 0 && reachRatio >= Number(options.highReachRatio ?? 0.7);
  const flags = [];
  if (highReach) flags.push('unexpected_audience_expansion');
  if (incompatibleMatches > 0) flags.push('cross_sector_mass_match');
  if (taxonomy.overbroad) flags.push('taxonomy_overbreadth');
  if (Number(options.singleAlertDigestShare || 0) >= Number(options.dominanceRatio ?? 0.6)) {
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
  clasificarSectorUsuario,
  diagnosticarTaxonomiaAmplia,
  esSectorIncompatible,
};
