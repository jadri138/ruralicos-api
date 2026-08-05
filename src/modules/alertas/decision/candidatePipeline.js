const {
  CANDIDATE_GENERATORS,
  CONTRACT_VERSIONS,
  DECISION_STATES,
  REASON_CODES,
  TRUTH_CARD_STATES,
} = require('./contracts');
const {
  AUTONOMOUS_COMMUNITY_PROVINCES,
  adaptAlertTruthCard,
  evidenceGapReason,
  evidenceIsUsable,
  getCriticalEvidenceGaps,
  normalizeScore,
  normalizeText,
  validateAlertTruthCard,
} = require('./truthCard');

const GENERATOR_ORDER = Object.freeze([
  CANDIDATE_GENERATORS.EXACT,
  CANDIDATE_GENERATORS.SEMANTIC,
  CANDIDATE_GENERATORS.MEMORY,
  CANDIDATE_GENERATORS.COVERAGE,
  CANDIDATE_GENERATORS.EXPLORATION,
]);

const GENERATOR_REASON = Object.freeze({
  exact: REASON_CODES.EXACT_CANDIDATE,
  semantic: REASON_CODES.SEMANTIC_CANDIDATE,
  memory: REASON_CODES.MEMORY_CANDIDATE,
  coverage: REASON_CODES.COVERAGE_CANDIDATE,
  exploration: REASON_CODES.SAFE_EXPLORATION,
});

// Barrera concreta que detuvo a una candidata. El orden es el que aplica
// evaluateCandidateEligibility y permite explicar el silencio por causa en vez
// de con un unico total agregado.
const ELIGIBILITY_STAGES = Object.freeze({
  CONTRACT: 'contract',
  VALIDITY: 'validity',
  EXCLUSION: 'exclusion',
  TERRITORY: 'territory',
  ACTIVITY: 'activity',
  EVIDENCE: 'evidence',
  ELIGIBLE: 'eligible',
});

const STAGE_ORDER = Object.freeze([
  ELIGIBILITY_STAGES.CONTRACT,
  ELIGIBILITY_STAGES.VALIDITY,
  ELIGIBILITY_STAGES.EXCLUSION,
  ELIGIBILITY_STAGES.TERRITORY,
  ELIGIBILITY_STAGES.ACTIVITY,
  ELIGIBILITY_STAGES.EVIDENCE,
]);

const SPANISH_MONTHS = Object.freeze({
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
});

function endOfUtcDay(year, monthIndex, day) {
  const timestamp = Date.UTC(year, monthIndex, day, 23, 59, 59, 999);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== monthIndex
    || date.getUTCDate() !== day
  ) return null;
  return timestamp;
}

function deadlineTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const raw = String(value || '').trim();
  if (!raw) return null;

  const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return endOfUtcDay(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));

  const numericDate = raw.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/);
  if (numericDate) {
    return endOfUtcDay(Number(numericDate[3]), Number(numericDate[2]) - 1, Number(numericDate[1]));
  }

  const normalized = normalizeText(raw);
  const spanishDate = normalized.match(new RegExp(
    `\\b(\\d{1,2})\\s+(?:de\\s+)?(${Object.keys(SPANISH_MONTHS).join('|')})\\s+(?:de\\s+)?(\\d{4})\\b`
  ));
  if (spanishDate) {
    return endOfUtcDay(
      Number(spanishDate[3]),
      SPANISH_MONTHS[spanishDate[2]],
      Number(spanishDate[1])
    );
  }

  // Solo se delegan al parser nativo fechas con hora/zona explícitas. Así se
  // evita reinterpretar textos ambiguos o una fecha sin año.
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const parsed = new Date(raw).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function verifiedDeadlineExpired(card, now = new Date()) {
  if (!evidenceIsUsable(card?.evidence?.deadline)) return false;
  const deadline = deadlineTimestamp(card?.time?.deadline);
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(deadline) && Number.isFinite(current) && current > deadline;
}


function candidateId(item = {}) {
  return item.alert_id
    ?? item.alerta_id
    ?? item.id
    ?? item.truth_card?.identity?.alert_id
    ?? item.truthCard?.identity?.alert_id
    ?? item.fact_sheet?.alerta_id
    ?? null;
}

function normalizeOrigin(type, item = {}) {
  const reasons = [
    GENERATOR_REASON[type],
    ...(Array.isArray(item.reason_codes) ? item.reason_codes : []),
  ].filter(Boolean);
  return {
    generator: type,
    score: normalizeScore(item.generator_score ?? item.score ?? item.similarity ?? item.similitud),
    reason_codes: [...new Set(reasons)].sort(),
    explanation: String(item.generator_reason || item.reason || item.motivo || '').slice(0, 180) || null,
  };
}

const SAFE_METADATA_KEYS = new Set([
  'high_impact',
  'equivalence_key',
  'material_version',
  'coverage_scope',
  'novelty_hint',
  'risk_hint',
  'source_rank',
  'generator_trace',
  'exploration',
  'hold_retry_source_id',
  'hold_retry_attempt',
  'hold_retry_final',
]);

function safeMetadata(metadata = {}) {
  const result = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      result[key] = typeof value === 'string' ? value.slice(0, 240) : value;
    } else if (Array.isArray(value)) {
      result[key] = value
        .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
        .slice(0, 20)
        .map((item) => typeof item === 'string' ? item.slice(0, 240) : item);
    }
  }
  return result;
}

function mergeSafeMetadata(current = {}, incoming = {}) {
  const next = { ...current };
  for (const [key, value] of Object.entries(safeMetadata(incoming))) {
    if (key === 'high_impact') next[key] = Boolean(next[key] || value);
    else if (Array.isArray(value)) next[key] = [...new Set([...(next[key] || []), ...value])].sort();
    else if (typeof value === 'number') next[key] = Math.max(Number(next[key] || 0), value);
    else if (typeof value === 'string') {
      next[key] = next[key] === undefined || next[key] === null
        ? value
        : [String(next[key]), value].sort()[0];
    } else if (next[key] === undefined || next[key] === null) next[key] = value;
  }
  return next;
}

function cardPreference(card) {
  const statusWeight = {
    [TRUTH_CARD_STATES.READY]: 5,
    [TRUTH_CARD_STATES.REVIEW]: 4,
    [TRUTH_CARD_STATES.INCOMPLETE]: 3,
    [TRUTH_CARD_STATES.EXPIRED]: 2,
    [TRUTH_CARD_STATES.BLOCKED]: 1,
  }[card?.status] || 0;
  return statusWeight * 10 + Number(card?.quality?.truth || 0);
}

function cardTieBreak(card = {}) {
  return [
    card.identity?.content_hash,
    card.builder_version,
    card.source_schema_version,
    card.identity?.alert_id,
  ].map((value) => String(value || '')).join(':');
}

function consolidateOrigins(origins = []) {
  const merged = new Map();
  for (const origin of origins) {
    const current = merged.get(origin.generator);
    if (!current) {
      merged.set(origin.generator, { ...origin });
      continue;
    }
    current.score = Math.max(current.score, origin.score);
    current.reason_codes = [...new Set([...current.reason_codes, ...origin.reason_codes])].sort();
    current.explanation = [current.explanation, origin.explanation].filter(Boolean).sort()[0] || null;
  }
  return [...merged.values()].sort((a, b) => (
    GENERATOR_ORDER.indexOf(a.generator) - GENERATOR_ORDER.indexOf(b.generator)
  ));
}

function mergeCandidateSets(candidateSets = {}) {
  const merged = new Map();
  for (const type of GENERATOR_ORDER) {
    const items = Array.isArray(candidateSets[type]) ? candidateSets[type] : [];
    for (const item of items) {
      const alertId = candidateId(item);
      if (alertId === null || alertId === undefined) continue;
      const key = String(alertId);
      const rawCard = item.truth_card || item.truthCard || item.fact_sheet || item.alert || item;
      const card = adaptAlertTruthCard(rawCard, {
        legacyAlert: item.alert || item.alerta || (item.titulo ? item : undefined),
      });
      const current = merged.get(key) || {
        contract_version: CONTRACT_VERSIONS.candidate,
        candidate_key: `alert:${key}`,
        alert_id: alertId,
        truth_card: card,
        origins: [],
        source_versions: [],
        metadata: {},
      };
      if (cardPreference(card) > cardPreference(current.truth_card)
        || (cardPreference(card) === cardPreference(current.truth_card)
          && cardTieBreak(card).localeCompare(cardTieBreak(current.truth_card)) < 0)) {
        current.truth_card = card;
      }
      current.origins.push(normalizeOrigin(type, item));
      current.metadata = mergeSafeMetadata(current.metadata, item.metadata);
      const version = card.identity?.content_hash || card.builder_version || card.source_schema_version;
      if (version) current.source_versions.push(version);
      merged.set(key, current);
    }
  }

  return [...merged.values()].map((candidate) => {
    const origins = consolidateOrigins(candidate.origins);
    const originTypes = new Set(origins.map((origin) => origin.generator));
    return {
      ...candidate,
      origins,
      source_versions: [...new Set(candidate.source_versions)].sort(),
      is_exploration: candidate.metadata.exploration === true
        || (originTypes.size === 1 && originTypes.has(CANDIDATE_GENERATORS.EXPLORATION)),
    };
  }).sort((a, b) => String(a.alert_id).localeCompare(String(b.alert_id), 'es', { numeric: true }));
}

function normalizedSet(values) {
  return new Set((values || []).map(normalizeText).filter(Boolean));
}

function intersection(left, right) {
  const rightSet = normalizedSet(right);
  return [...normalizedSet(left)].filter((item) => rightSet.has(item)).sort();
}

function expandedRegionalProvinces(regions = []) {
  const result = new Set();
  for (const region of regions.map(normalizeText)) {
    for (const province of AUTONOMOUS_COMMUNITY_PROVINCES[region] || []) result.add(province);
  }
  return [...result];
}

function territoryEligibility(card, profile) {
  const userTerritory = profile?.operational?.territory || {};
  const userProvinces = [...normalizedSet(userTerritory.provinces)];
  const userMunicipalities = [...normalizedSet(userTerritory.municipalities)];
  const userRegions = [...normalizedSet(userTerritory.regions)];
  if (userProvinces.length === 0 && userMunicipalities.length === 0 && userRegions.length === 0) {
    return { allowed: false, reason: REASON_CODES.PROFILE_TERRITORY_MISSING, matches: [] };
  }
  if (!evidenceIsUsable(card?.evidence?.territory)) {
    return { allowed: false, hold: true, reason: REASON_CODES.TERRITORY_EVIDENCE_MISSING, matches: [] };
  }
  if (card.territory?.individual_case) {
    const municipalityMatches = intersection(card.territory.municipalities, userMunicipalities);
    if (municipalityMatches.length === 0) {
      return { allowed: false, reason: REASON_CODES.INDIVIDUAL_TERRITORY_MISSING, matches: [] };
    }
    return { allowed: true, reason: REASON_CODES.TERRITORY_EXACT, matches: municipalityMatches };
  }
  if (card.territory?.national) {
    return { allowed: true, reason: REASON_CODES.TERRITORY_NATIONAL, matches: ['nacional'] };
  }
  const municipalityMatches = intersection(card.territory?.municipalities, userMunicipalities);
  const provinceMatches = intersection(card.territory?.provinces, userProvinces);
  if (municipalityMatches.length || provinceMatches.length) {
    return {
      allowed: true,
      reason: REASON_CODES.TERRITORY_EXACT,
      matches: [...municipalityMatches, ...provinceMatches].sort(),
    };
  }
  const expanded = expandedRegionalProvinces(card.territory?.regions || []);
  const autonomicMatches = intersection(expanded, userProvinces);
  const sameRegion = intersection(card.territory?.regions, userRegions);
  if (autonomicMatches.length || sameRegion.length) {
    return {
      allowed: true,
      reason: REASON_CODES.TERRITORY_AUTONOMIC,
      matches: [...autonomicMatches, ...sameRegion].sort(),
    };
  }
  return { allowed: false, reason: REASON_CODES.TERRITORY_MISMATCH, matches: [] };
}

function alertDimensions(card = {}) {
  return {
    sector: card.activity?.sectors || [],
    subsector: card.activity?.subsectors || [],
    crop: card.activity?.crops || [],
    species: card.activity?.species || [],
    alert_type: [card.nature?.type].filter(Boolean),
    topic: [card.nature?.topic].filter(Boolean),
    territory: [
      ...(card.territory?.provinces || []),
      ...(card.territory?.regions || []),
      ...(card.territory?.municipalities || []),
    ],
  };
}

function matchesExplicitExclusion(card, profile) {
  const dimensions = alertDimensions(card);
  for (const memory of profile?.memories?.negative || []) {
    if (memory.effective_strength < 0.35) continue;
    const values = dimensions[memory.scope] || [];
    if (normalizedSet(values).has(normalizeText(memory.key || memory.content))) return memory;
    if (memory.scope === 'alert' && normalizeText(memory.key) === normalizeText(card.identity?.alert_id)) {
      return memory;
    }
  }
  return null;
}

function activityEligibility(card, profile) {
  const userActivity = profile?.operational?.activity || {};
  const configured = [
    ...(userActivity.sectors || []),
    ...(userActivity.subsectors || []),
    ...(userActivity.crops || []),
    ...(userActivity.species || []),
  ];
  const cardActivity = [
    ...(card.activity?.sectors || []),
    ...(card.activity?.subsectors || []),
    ...(card.activity?.crops || []),
    ...(card.activity?.species || []),
  ];
  if (configured.length === 0 || cardActivity.length === 0) return { allowed: true, matches: [] };
  const matches = intersection(configured, cardActivity);
  return {
    allowed: matches.length > 0,
    matches,
    reason: matches.length > 0 ? REASON_CODES.ACTIVITY_MATCH : REASON_CODES.ACTIVITY_MISMATCH,
  };
}

function evaluateCandidateEligibility(candidate, profile, options = {}) {
  const card = candidate?.truth_card;
  const validation = validateAlertTruthCard(card);
  if (!validation.valid) {
    return {
      eligible: false,
      stage: ELIGIBILITY_STAGES.CONTRACT,
      state: DECISION_STATES.BLOCKED,
      reason_codes: [REASON_CODES.TRUTH_CARD_INVALID],
      trace: { validation },
    };
  }
  if (card.status === TRUTH_CARD_STATES.BLOCKED) {
    return {
      eligible: false,
      stage: ELIGIBILITY_STAGES.CONTRACT,
      state: DECISION_STATES.BLOCKED,
      reason_codes: [REASON_CODES.TRUTH_CARD_BLOCKED],
      trace: {},
    };
  }
  if (card.status === TRUTH_CARD_STATES.EXPIRED
    || card.time?.expired
    || verifiedDeadlineExpired(card, options.now)) {
    return {
      eligible: false,
      stage: ELIGIBILITY_STAGES.VALIDITY,
      state: DECISION_STATES.BLOCKED,
      reason_codes: [REASON_CODES.EXPIRED],
      trace: {},
    };
  }
  if (card.risk?.contradiction) {
    return {
      eligible: false,
      stage: ELIGIBILITY_STAGES.VALIDITY,
      state: DECISION_STATES.BLOCKED,
      reason_codes: [REASON_CODES.CONTRADICTORY_EVIDENCE],
      trace: {},
    };
  }
  const exclusion = matchesExplicitExclusion(card, profile);
  if (exclusion) {
    return {
      eligible: false,
      stage: ELIGIBILITY_STAGES.EXCLUSION,
      state: DECISION_STATES.BLOCKED,
      reason_codes: [REASON_CODES.EXPLICIT_EXCLUSION],
      trace: { exclusion: { scope: exclusion.scope, key: exclusion.key, source: exclusion.source } },
    };
  }
  const territory = territoryEligibility(card, profile);
  if (!territory.allowed) {
    return {
      eligible: false,
      stage: ELIGIBILITY_STAGES.TERRITORY,
      state: territory.hold ? DECISION_STATES.HOLD_FOR_EVIDENCE : DECISION_STATES.BLOCKED,
      reason_codes: [territory.reason],
      trace: { territory },
    };
  }
  const activity = activityEligibility(card, profile);
  if (!activity.allowed) {
    return {
      eligible: false,
      stage: ELIGIBILITY_STAGES.ACTIVITY,
      state: DECISION_STATES.BLOCKED,
      reason_codes: [activity.reason],
      trace: { territory, activity },
    };
  }

  const type = normalizeText(card.nature?.type);
  const requiresAction = /ayuda|subvencion|obligacion|plazo|curso|tramite|convocatoria|alegacion|subsan/.test(type);
  const gaps = getCriticalEvidenceGaps(card).filter((field) => field !== 'action' || requiresAction);
  if (card.status === TRUTH_CARD_STATES.INCOMPLETE && gaps.length === 0) gaps.push('evidence');
  if (gaps.length > 0) {
    return {
      eligible: false,
      stage: ELIGIBILITY_STAGES.EVIDENCE,
      state: DECISION_STATES.HOLD_FOR_EVIDENCE,
      reason_codes: [...new Set(gaps.map(evidenceGapReason))],
      trace: { territory, activity, missing_evidence: gaps },
    };
  }

  return {
    eligible: true,
    stage: ELIGIBILITY_STAGES.ELIGIBLE,
    state: null,
    reason_codes: [territory.reason, ...(activity.reason ? [activity.reason] : [])],
    trace: { territory, activity, policy_version: options.policyVersion || CONTRACT_VERSIONS.policy },
  };
}

function recentExposurePenalty(candidate, profile, now = new Date()) {
  const alertRef = String(candidate.alert_id);
  const exposure = (profile?.exposures || []).find((item) => (
    String(item.alert_ref).endsWith(alertRef)
    || item.material_version === candidate.truth_card?.identity?.content_hash
  ));
  if (!exposure) return 0;
  const date = new Date(exposure.delivered_at || exposure.sent_at || exposure.shown_at || 0);
  if (Number.isNaN(date.getTime())) return 0;
  const ageDays = Math.max(0, (new Date(now).getTime() - date.getTime()) / 86400000);
  return ageDays < 7 ? 15 : ageDays < 30 ? 7 : 0;
}

function scoreCandidate(candidate, profile, eligibility, options = {}) {
  if (!eligibility?.eligible) return { score: 0, contributions: [] };
  const card = candidate.truth_card;
  const origins = new Map(candidate.origins.map((origin) => [origin.generator, origin.score]));
  const contributions = [];
  const add = (code, value) => {
    if (!value) return;
    contributions.push({ code, value: Number(value.toFixed(3)) });
  };
  add(REASON_CODES.EXACT_CANDIDATE, origins.has('exact') ? 18 : 0);
  add(REASON_CODES.COVERAGE_CANDIDATE, origins.has('coverage') ? 12 : 0);
  add(REASON_CODES.MEMORY_CANDIDATE, (origins.get('memory') || 0) * 12);
  add(REASON_CODES.SEMANTIC_CANDIDATE, (origins.get('semantic') || 0) * 10);
  add(REASON_CODES.SAFE_EXPLORATION, candidate.is_exploration ? 2 : 0);
  add(eligibility.trace.territory.reason, 18);
  add(REASON_CODES.ACTIVITY_MATCH, eligibility.trace.activity.matches.length ? 12 : 0);
  add(REASON_CODES.BENEFICIARY_MATCH, evidenceIsUsable(card.evidence?.beneficiaries) ? 8 : 0);
  add(REASON_CODES.ACTIONABLE, evidenceIsUsable(card.evidence?.action) ? 8 : 0);
  add(REASON_CODES.URGENCY_VERIFIED, evidenceIsUsable(card.evidence?.deadline) ? 5 : 0);
  add('TRUTH_QUALITY', normalizeScore(card.quality?.truth) * 12);
  add('EVIDENCE_COVERAGE', normalizeScore(card.quality?.coverage) * 8);
  const riskPenalty = normalizeScore(card.quality?.risk) * 12;
  const exposurePenalty = recentExposurePenalty(candidate, profile, options.now);
  if (riskPenalty) contributions.push({ code: 'RISK_PENALTY', value: -Number(riskPenalty.toFixed(3)) });
  if (exposurePenalty) contributions.push({ code: 'RECENT_EXPOSURE_PENALTY', value: -exposurePenalty });
  const score = Math.max(0, Math.min(100, contributions.reduce((sum, item) => sum + item.value, 0)));
  return { score: Number(score.toFixed(3)), contributions };
}

// Embudo del blueprint: explica el silencio por causa. Cada nivel es el
// remanente tras aplicar esa barrera, de modo que una caida a cero senala la
// barrera responsable sin necesidad de revisar alertas una a una.
function buildEligibilityFunnel({ generated = 0, stageStops = new Map(), reasonStops = new Map() } = {}) {
  const stages = {};
  let remaining = generated;
  for (const stage of STAGE_ORDER) {
    remaining -= stageStops.get(stage) || 0;
    stages[stage] = Math.max(0, remaining);
  }
  return {
    generated,
    passed_contract: stages[ELIGIBILITY_STAGES.CONTRACT],
    passed_validity: stages[ELIGIBILITY_STAGES.VALIDITY],
    passed_exclusion: stages[ELIGIBILITY_STAGES.EXCLUSION],
    passed_territory: stages[ELIGIBILITY_STAGES.TERRITORY],
    passed_activity: stages[ELIGIBILITY_STAGES.ACTIVITY],
    passed_evidence: stages[ELIGIBILITY_STAGES.EVIDENCE],
    stopped_by: Object.fromEntries(
      STAGE_ORDER
        .map((stage) => [stage, stageStops.get(stage) || 0])
        .filter(([, count]) => count > 0)
    ),
    reason_codes: Object.fromEntries([...reasonStops.entries()].sort(
      (left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))
    )),
  };
}

function rankCandidateUnion({ candidateSets = {}, profile, topK = 15, now = new Date(), policyVersion } = {}) {
  const merged = mergeCandidateSets(candidateSets);
  const eligible = [];
  const holds = [];
  const blocked = [];
  const stageStops = new Map();
  const reasonStops = new Map();
  for (const candidate of merged) {
    const eligibility = evaluateCandidateEligibility(candidate, profile, { policyVersion, now });
    if (!eligibility.eligible) {
      const result = { ...candidate, eligibility, pre_score: 0, score_contributions: [] };
      stageStops.set(eligibility.stage, (stageStops.get(eligibility.stage) || 0) + 1);
      for (const code of eligibility.reason_codes || []) {
        reasonStops.set(code, (reasonStops.get(code) || 0) + 1);
      }
      if (eligibility.state === DECISION_STATES.HOLD_FOR_EVIDENCE) holds.push(result);
      else blocked.push(result);
      continue;
    }
    const scoring = scoreCandidate(candidate, profile, eligibility, { now });
    eligible.push({
      ...candidate,
      eligibility,
      pre_score: scoring.score,
      score_contributions: scoring.contributions,
    });
  }
  eligible.sort((a, b) => {
    // Un HOLD ya reclamado debe obtener la reevaluación prometida. Sigue
    // pasando todas las barreras duras, pero no puede volver a quedar fuera
    // únicamente por el corte top K del día.
    const retryA = a.metadata?.hold_retry_source_id ? 1 : 0;
    const retryB = b.metadata?.hold_retry_source_id ? 1 : 0;
    return retryB - retryA
      || b.pre_score - a.pre_score
      || String(a.alert_id).localeCompare(String(b.alert_id), 'es', { numeric: true });
  });
  const limit = Math.max(1, Math.min(20, Number(topK) || 15));
  const selected = eligible.slice(0, limit);
  const dropped = eligible.slice(limit).map((candidate) => ({
    ...candidate,
    eligibility: {
      eligible: false,
      state: DECISION_STATES.DROP,
      reason_codes: [REASON_CODES.TOP_K_LIMIT],
      trace: candidate.eligibility.trace,
    },
  }));
  return {
    contract_version: CONTRACT_VERSIONS.candidate,
    policy_version: policyVersion || CONTRACT_VERSIONS.policy,
    candidates: selected,
    holds,
    blocked,
    dropped,
    funnel: {
      ...buildEligibilityFunnel({ generated: merged.length, stageStops, reasonStops }),
      eligible: eligible.length,
      // Las seleccionadas son exactamente las parejas que veran el juez LLM.
      selected: selected.length,
      held: holds.length,
      blocked: blocked.length,
      top_k_dropped: dropped.length,
    },
  };
}

module.exports = {
  GENERATOR_ORDER,
  ELIGIBILITY_STAGES,
  STAGE_ORDER,
  AUTONOMOUS_COMMUNITY_PROVINCES,
  buildEligibilityFunnel,
  safeMetadata,
  mergeCandidateSets,
  territoryEligibility,
  matchesExplicitExclusion,
  deadlineTimestamp,
  verifiedDeadlineExpired,
  evaluateCandidateEligibility,
  scoreCandidate,
  rankCandidateUnion,
};
