const { normalizeText } = require('./prefilter');
const { REGION_PROVINCES } = require('./config');

function strings(value) {
  return Array.isArray(value) ? value.map(normalizeText).filter(Boolean) : [];
}

function mergedStrings(...values) {
  return [...new Set(values.flatMap((value) => strings(value)))];
}

function exactIntersect(left, right) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function canonicalSignal(value) {
  return normalizeText(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b(agricultor|agricultora|agricultores|agricultoras|agrario|agraria|agrarios|agrarias)\b/g, 'agricultura')
    .replace(/\b(vacuno|reses|bovina|bovinos|bovinas)\b/g, 'bovino')
    .replace(/\b(oveja|ovejas|ovina|ovinos|ovinas)\b/g, 'ovino')
    .replace(/\b(cabra|cabras|caprina|caprinos|caprinas)\b/g, 'caprino')
    .replace(/\b(cerdo|cerdos|porcina|porcinos|porcinas)\b/g, 'porcino')
    .replace(/\b(aves|ave|avicultura)\b/g, 'avicola')
    .replace(/\bcereales\b/g, 'cereal')
    .replace(/\bhortalizas\b/g, 'hortaliza')
    .replace(/\bfrutales\b/g, 'frutal')
    .replace(/\bcitricos\b/g, 'citrico')
    .replace(/\bleguminosas\b/g, 'leguminosa')
    .replace(/\bforrajes\b/g, 'forraje')
    .replace(/\btrufas\b/g, 'trufa')
    .replace(/\bsemillas\b/g, 'semilla')
    .replace(/\bviveros\b/g, 'vivero')
    .replace(/\bfrutos secos\b/g, 'fruto seco')
    .replace(/\bcultivos industriales\b/g, 'cultivo industrial')
    .replace(/\bcultivos herbaceos\b/g, 'cultivo herbaceo');
}

const ACTIVITY_FAMILIES = Object.freeze({
  agricultura: [
    'trigo', 'cebada', 'cereal', 'maiz', 'arroz', 'hortaliza', 'patata',
    'leguminosa', 'forraje', 'frutal', 'olivar', 'trufa', 'vinedo',
    'almendro', 'citrico', 'fruto seco', 'cultivo industrial', 'cultivo herbaceo',
    'hortofruticola', 'semilla', 'vivero', 'floricultura',
  ],
  ganaderia: [
    'bovino', 'ovino', 'caprino', 'porcino', 'avicola', 'cunicultura',
    'equinocultura', 'apicultura',
  ],
});

function containsSignal(value, signal) {
  return new RegExp(`(?:^|[^a-z0-9])${signal}(?:$|[^a-z0-9])`).test(value);
}

function isSpecificFamilyMember(value, members) {
  return members.some((member) => containsSignal(value, member));
}

function compatibleByActivityFamily(left, right) {
  return Object.entries(ACTIVITY_FAMILIES).some(([parent, members]) => {
    const leftParent = containsSignal(left, parent);
    const rightParent = containsSignal(right, parent);
    const leftSpecific = isSpecificFamilyMember(left, members);
    const rightSpecific = isSpecificFamilyMember(right, members);
    const leftGeneric = leftParent && !leftSpecific;
    const rightGeneric = rightParent && !rightSpecific;
    return (leftGeneric && rightSpecific) || (rightGeneric && leftSpecific);
  });
}

const GENERIC_SIGNAL_WORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'y', 'titular', 'titulares',
  'explotacion', 'explotaciones', 'persona', 'personas', 'entidad', 'entidades',
  'sector', 'actividad',
]);

function signalStems(value) {
  return canonicalSignal(value).split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5 && !GENERIC_SIGNAL_WORDS.has(word))
    .map((word) => word.slice(0, 5));
}

function signalsCompatible(left, right) {
  return left.some((leftValue) => right.some((rightValue) => {
    const a = canonicalSignal(leftValue);
    const b = canonicalSignal(rightValue);
    if (a === b || a.includes(b) || b.includes(a)) return true;
    if (compatibleByActivityFamily(a, b)) return true;
    return exactIntersect(signalStems(a), signalStems(b));
  }));
}

function profileSignals(user = {}) {
  const preferences = user.preferences && typeof user.preferences === 'object'
    && !Array.isArray(user.preferences) ? user.preferences : {};
  return {
    regions: mergedStrings(preferences.regiones, preferences.regions, preferences.comunidades),
    provinces: mergedStrings(preferences.provincias, preferences.provinces),
    municipalities: mergedStrings(preferences.municipios, preferences.municipalities),
    activities: mergedStrings(
      preferences.actividades, preferences.activities, preferences.subsectores, preferences.sectores
    ),
    beneficiaryTypes: mergedStrings(
      preferences.tipos_beneficiario, preferences.beneficiary_types, preferences.tipo_beneficiario
    ),
    excludedContentTypes: mergedStrings(
      preferences.excluded_content_types, preferences.tipos_contenido_excluidos
    ),
    excludedAlertIds: [...new Set([
      ...(Array.isArray(preferences.excluded_alert_ids) ? preferences.excluded_alert_ids : []),
      ...(Array.isArray(preferences.alertas_excluidas) ? preferences.alertas_excluidas : []),
    ].map(Number).filter(Number.isSafeInteger))],
    contentPreferences: preferences.tipos_alerta && typeof preferences.tipos_alerta === 'object'
      ? preferences.tipos_alerta : {},
    freeText: String(user.preferencias_extra || '').trim(),
  };
}

function territoryCompatible(territories = {}, profile = {}) {
  if (territories.national === true) return true;
  const limited = [territories.regions, territories.provinces, territories.municipalities]
    .some((items) => Array.isArray(items) && items.length > 0);
  if (!limited) return true;
  const cardRegions = strings(territories.regions);
  const cardProvinces = strings(territories.provinces);
  const profileRegions = profile.regions;
  const profileProvinces = profile.provinces;
  const cardRegionProvinces = cardRegions.flatMap((region) => REGION_PROVINCES[region] || []);
  const profileRegionProvinces = profileRegions.flatMap((region) => REGION_PROVINCES[region] || []);
  return exactIntersect(cardRegions, profileRegions)
    || exactIntersect(cardProvinces, profileProvinces)
    || exactIntersect(cardRegionProvinces, profileProvinces)
    || exactIntersect(cardProvinces, profileRegionProvinces)
    || exactIntersect(strings(territories.municipalities), profile.municipalities);
}

function contentAllowed(classification, profile) {
  const contentType = normalizeText(classification.content_type);
  if (profile.excludedContentTypes.includes(contentType)) return false;
  const aliases = {
    aid: ['aid', 'ayuda', 'ayudas', 'ayudas_subvenciones'],
    obligation: ['obligation', 'obligacion', 'obligaciones'],
    opportunity: ['opportunity', 'oportunidad', 'oportunidades'],
    procedure: ['procedure', 'procedimiento', 'tramites'],
    warning: ['warning', 'aviso', 'avisos'],
    information: ['information', 'informacion'],
  };
  return !(aliases[contentType] || [contentType])
    .some((key) => profile.contentPreferences[key] === false);
}

function matchClassificationToProfile({ classification, user, sentAlertIds = [] } = {}) {
  const alertId = Number(classification?.alert_id);
  const card = classification?.card || classification;
  const profile = profileSignals(user);
  const reasons = [];

  if (!card?.relevant) reasons.push('not_relevant');
  if (!card?.actionable) reasons.push('not_actionable');
  if (card?.status === 'closed') reasons.push('closed');
  if (sentAlertIds.map(Number).includes(alertId)) reasons.push('already_sent');
  if (profile.excludedAlertIds.includes(alertId)) reasons.push('user_explicit_exclusion');
  if (!territoryCompatible(card?.territories, profile)) reasons.push('territory_mismatch');
  if (Array.isArray(card?.activities) && card.activities.length > 0
      && profile.activities.length > 0
      && !signalsCompatible(strings(card.activities), profile.activities)) {
    reasons.push('activity_mismatch');
  }
  if (Array.isArray(card?.beneficiary_types) && card.beneficiary_types.length > 0
      && profile.beneficiaryTypes.length > 0
      && !signalsCompatible(strings(card.beneficiary_types), profile.beneficiaryTypes)) {
    reasons.push('beneficiary_mismatch');
  }
  if (!contentAllowed(card || {}, profile)) reasons.push('content_preference_excluded');

  return {
    candidate: reasons.length === 0,
    reasons,
    profile_signals: profile,
  };
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function orderCandidates(candidates = [], now = new Date()) {
  const nowMs = now.getTime();
  return [...candidates].sort((left, right) => {
    const a = left.card || left;
    const b = right.card || right;
    const activeA = a.status === 'active' ? 0 : 1;
    const activeB = b.status === 'active' ? 0 : 1;
    if (activeA !== activeB) return activeA - activeB;
    const deadlineA = timestamp(a.deadline);
    const deadlineB = timestamp(b.deadline);
    const futureA = deadlineA >= nowMs ? deadlineA : Number.MAX_SAFE_INTEGER;
    const futureB = deadlineB >= nowMs ? deadlineB : Number.MAX_SAFE_INTEGER;
    if (futureA !== futureB) return futureA - futureB;
    const dateDiff = timestamp(right.official_snapshot?.date || right.date)
      - timestamp(left.official_snapshot?.date || left.date);
    if (dateDiff !== 0) return dateDiff;
    return Number(left.alert_id) - Number(right.alert_id);
  });
}

module.exports = {
  profileSignals,
  signalsCompatible,
  territoryCompatible,
  matchClassificationToProfile,
  orderCandidates,
};
