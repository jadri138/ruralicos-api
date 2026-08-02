const {
  CONTRACT_VERSIONS,
  DECISION_STATES,
  EVIDENCE_LEVELS,
  REASON_CODES,
  adaptFactSheetV3,
  decideCandidateBatch,
  projectProfileForJudge,
  renderSafeMessageBlock,
} = require('./index');
const {
  DELIVERY_STATUS,
  resolverTransicionEntrega,
} = require('../../delivery/deliveryState');
const { runDailyHistoricalSequence } = require('./historicalSequence');
const { gradeReplayReport } = require('./replayGrader');

const GOLDEN_CORPUS_VERSION = 'alert_decision_golden_v2';
const REPLAY_VERSION = 'alert_decision_replay_v2';
const APPROVED_STATES = new Set([
  DECISION_STATES.SEND_NOW,
  DECISION_STATES.ADD_TO_DIGEST,
]);
const REQUIRED_GOLDEN_CATEGORIES = Object.freeze([
  'clearly_relevant',
  'clearly_irrelevant',
  'doubtful',
  'other_province',
  'autonomous_scope',
  'national_scope',
  'individual_case',
  'aid_without_deadline',
  'obligation',
  'course',
  'incomplete_document',
  'historical_false_positive',
  'historical_false_negative',
  'profile_new',
  'profile_open',
  'profile_specialized',
  'profile_contradictory',
]);
const REQUIRED_PROFILE_KINDS = Object.freeze([
  'new',
  'open',
  'specialized',
  'contradictory',
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function validReplayDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function verified(value, evidence, source = 'golden_fixture.official_document') {
  if (value === null || value === undefined || value === '') return {};
  return {
    valor: value,
    evidencia: evidence || `El documento oficial acredita: ${Array.isArray(value) ? value.join(', ') : value}.`,
    source,
    confidence: 0.95,
    evidence_level: 'official',
    status: 'verified',
  };
}

function territoryFields(territory = {}) {
  const level = territory.level || 'provincial';
  if (level === 'missing') return { field: {}, structured: {} };
  if (level === 'national') {
    return {
      field: [verified('nacional', 'La disposición se aplica en todo el territorio nacional.')],
      structured: {},
    };
  }
  const provinces = territory.provinces || [];
  const regions = territory.regions || [];
  const municipalities = territory.municipalities || [];
  const visibleTerritories = level === 'regional' ? regions : provinces;
  return {
    field: visibleTerritories.map((value) => verified(
      value,
      `El documento oficial fija el ámbito territorial en ${value}.`
    )),
    structured: {
      comunidades: regions,
      municipios: municipalities,
      expediente_individual: Boolean(territory.individual_case),
    },
  };
}

function buildFactSheetFixture(replayCase = {}) {
  if (replayCase.fact_sheet_snapshot) return clone(replayCase.fact_sheet_snapshot);
  const alert = replayCase.alert || {};
  const territory = territoryFields(alert.territory);
  const flags = [...(alert.flags || [])];
  if (alert.territory?.individual_case) flags.push('expediente_individual');
  if (alert.contradiction) flags.push('contradiction_unresolved');
  if (alert.incomplete_text) flags.push('incomplete_text');
  const summary = alert.summary == null
    ? {}
    : verified(alert.summary);
  const action = alert.action == null
    ? {}
    : verified(alert.action);
  const actionCode = alert.action == null
    ? {}
    : verified(alert.action_code || 'revisar');
  const deadline = alert.deadline == null
    ? { status: 'not_applicable' }
    : verified(alert.deadline, `El documento oficial fija el plazo en ${alert.deadline}.`);

  return {
    schema_version: 'fact_sheet_v3',
    builder_version: 'golden_fixture_builder_v1',
    generated_at: `${replayCase.date}T08:00:00.000Z`,
    alerta_id: alert.id,
    raw_document_id: `golden-document-${alert.id}`,
    content_hash: alert.content_hash || `golden-content-${alert.id}-v1`,
    tipo_documento: verified(alert.type || 'información'),
    tema_principal: verified(alert.topic || alert.title),
    resumen_neutro: summary,
    territorio: territory.field,
    sectores: (alert.sectors || []).map((value) => verified(value)),
    subsectores: (alert.subsectors || []).map((value) => verified(value)),
    accion_requerida: action,
    accion_codigo: actionCode,
    application_deadline: deadline,
    beneficiarios: alert.beneficiaries == null
      ? {}
      : verified(alert.beneficiaries),
    importe: alert.amount == null ? {} : verified(alert.amount),
    requisitos: (alert.requirements || []).map((value) => verified(value)),
    url_oficial: alert.official_url == null
      ? {}
      : verified(alert.official_url),
    truth_score: alert.truth_score ?? 94,
    risk_score: alert.risk_score ?? 8,
    evidence_coverage: alert.evidence_coverage ?? 92,
    status: alert.status || 'ready_for_digest',
    flags: unique(flags),
    reasons: alert.reasons || [],
    resumen_estructurado: {
      ...territory.structured,
      cultivos: alert.crops || [],
      especies: alert.species || [],
      beneficiarios_incluidos: alert.included_beneficiaries || [],
      beneficiarios_excluidos: alert.excluded_beneficiaries || [],
    },
  };
}

function buildTruthCardFixture(replayCase) {
  const alert = replayCase.alert || {};
  return adaptFactSheetV3(buildFactSheetFixture(replayCase), {
    legacyAlert: {
      id: alert.id,
      titulo: alert.title,
      fuente: alert.source || 'CORPUS_DORADO',
      fecha: replayCase.date,
      provincias: alert.territory?.provinces || [],
      comunidades: alert.territory?.regions || [],
      municipios: alert.territory?.municipalities || [],
      sectores: alert.sectors || [],
      subsectores: alert.subsectors || [],
      cultivos: alert.crops || [],
      especies: alert.species || [],
      tipos_alerta: [alert.type || 'información'],
      url: alert.official_url,
    },
  });
}

function usableMessageFacts(truthCard) {
  return Object.entries(truthCard.evidence || {})
    .filter(([field, evidence]) => (
      ['title', 'summary', 'beneficiaries', 'territory', 'action', 'deadline', 'amount', 'official_url'].includes(field)
      && [EVIDENCE_LEVELS.VERIFIED, EVIDENCE_LEVELS.SUPPORTED].includes(evidence?.level)
    ))
    .map(([field, evidence]) => ({ field, evidence_ref: evidence.ref }));
}

function buildFixtureJudgeDecision(replayCase, truthCard) {
  const expected = replayCase.judge || {};
  const decision = expected.decision || DECISION_STATES.HOLD_FOR_EVIDENCE;
  const approved = APPROVED_STATES.has(decision);
  const messageFacts = approved ? usableMessageFacts(truthCard) : [];
  const reasonCodes = expected.reason_codes || [
    approved ? REASON_CODES.APPROVED_DIGEST : REASON_CODES.LLM_ABSTAINED,
  ];
  return {
    contract_version: CONTRACT_VERSIONS.decision,
    policy_version: CONTRACT_VERSIONS.policy,
    decision,
    applicability: expected.applicability ?? (approved ? 0.9 : 0.3),
    usefulness: expected.usefulness ?? (approved ? 0.86 : 0.25),
    actionability: expected.actionability ?? (approved ? 0.82 : 0.2),
    urgency: expected.urgency ?? (decision === DECISION_STATES.SEND_NOW ? 0.95 : 0.25),
    novelty: expected.novelty ?? 0.75,
    confidence: expected.confidence ?? 0.9,
    reason_codes: reasonCodes,
    evidence_refs: messageFacts.map((fact) => fact.evidence_ref),
    missing_information: expected.missing_information || [],
    user_reason: expected.user_reason || (
      approved
        ? 'La alerta encaja con el perfil y contiene una acción útil respaldada.'
        : 'La utilidad personal no queda suficientemente acreditada.'
    ),
    message_facts: messageFacts,
  };
}

function sanitizeProfileSnapshot(profileSnapshot = {}) {
  const user = profileSnapshot.user || {};
  return {
    user: {
      id: profileSnapshot.id || user.id,
      subscription: user.subscription || 'replay',
      preferences: clone(user.preferences || {}),
    },
    memories: clone(profileSnapshot.memories || []),
    exposures: clone(profileSnapshot.exposures || []),
  };
}

function buildCandidateSets(replayCase, truthCard) {
  const result = {};
  const generators = replayCase.generators?.length ? replayCase.generators : ['exact'];
  for (const generator of generators) {
    if (!result[generator]) result[generator] = [];
    result[generator].push({
      alert_id: replayCase.alert.id,
      truth_card: truthCard,
      score: replayCase.generator_scores?.[generator] ?? (generator === 'exact' ? 1 : 0.8),
      metadata: clone(replayCase.metadata || {}),
    });
  }
  return result;
}

function buildBatchCandidateSets(replayCases, truthCards) {
  const result = {};
  for (let index = 0; index < replayCases.length; index += 1) {
    const sets = buildCandidateSets(replayCases[index], truthCards[index]);
    for (const [generator, candidates] of Object.entries(sets)) {
      if (!result[generator]) result[generator] = [];
      result[generator].push(...candidates);
    }
  }
  return result;
}

function findPairOutcome(batch, alertId) {
  const sameAlert = (item) => String(item?.candidate?.alert_id ?? item?.alert_id) === String(alertId);
  const selected = batch.portfolio.items.find(sameAlert);
  if (selected) {
    return {
      state: selected.state,
      reason_codes: selected.reason_codes || [],
      approved: true,
      selected,
      source: 'portfolio',
    };
  }
  const rejected = batch.portfolio.rejected.find(sameAlert);
  if (rejected) {
    return {
      state: rejected.state,
      reason_codes: rejected.reason_codes || [],
      approved: false,
      selected: rejected,
      source: 'authority',
    };
  }
  for (const [collection, source] of [
    [batch.ranking.holds, 'deterministic_hold'],
    [batch.ranking.blocked, 'deterministic_block'],
    [batch.ranking.dropped, 'top_k'],
  ]) {
    const item = collection.find(sameAlert);
    if (item) {
      return {
        state: item.eligibility?.state || DECISION_STATES.DROP,
        reason_codes: item.eligibility?.reason_codes || [],
        approved: false,
        selected: item,
        source,
      };
    }
  }
  return {
    state: DECISION_STATES.DROP,
    reason_codes: [REASON_CODES.LOW_RELEVANCE],
    approved: false,
    selected: null,
    source: 'no_candidate',
  };
}

function simulateDelivery(outcome, steps = []) {
  if (!outcome.approved) {
    return { attempted: false, status: null, events: [] };
  }
  let status = DELIVERY_STATUS.APPROVED;
  const events = [];
  for (const requested of steps) {
    const transition = resolverTransicionEntrega(status, requested);
    if (transition.apply) status = transition.status;
    events.push({
      requested,
      applied: transition.apply,
      status,
      reason: transition.reason,
    });
  }
  return {
    attempted: steps.length > 0,
    status,
    events,
  };
}

function deriveMemoryEffects(observed = {}, replayCase = {}) {
  const transportFailed = (observed.delivery_steps || []).some((status) => (
    [DELIVERY_STATUS.FAILED, DELIVERY_STATUS.UNDELIVERED].includes(status)
  ));
  if (transportFailed) return [];

  const effects = [];
  const alertKey = String(replayCase.alert?.id || replayCase.id || 'unknown-alert');
  const effectKey = (signal = {}, scope = 'alert') => (
    signal.scope_value
    || signal.key
    || (scope === 'alert' ? alertKey : replayCase.alert?.topic || replayCase.alert?.type || alertKey)
  );
  if (observed.feedback?.polarity) {
    const scope = observed.feedback.scope || 'alert';
    effects.push({
      source: 'feedback',
      polarity: observed.feedback.polarity,
      scope,
      key: String(effectKey(observed.feedback, scope)),
      strength: observed.feedback.strength ?? 0.9,
      confidence: observed.feedback.confidence ?? 0.95,
      recorded_at: observed.feedback.recorded_at || null,
    });
  }
  if (observed.clicked === true) {
    effects.push({
      source: 'click',
      polarity: 'positive',
      scope: 'alert',
      key: alertKey,
      strength: 0.45,
      confidence: 0.7,
      recorded_at: observed.clicked_at || null,
    });
  }
  if (observed.strong_action) {
    effects.push({
      source: 'strong_action',
      polarity: 'positive',
      scope: observed.strong_action.scope || 'alert',
      key: String(effectKey(observed.strong_action, observed.strong_action.scope || 'alert')),
      strength: observed.strong_action.strength ?? 0.8,
      confidence: observed.strong_action.confidence ?? 0.9,
      recorded_at: observed.strong_action.recorded_at || observed.strong_action_at || null,
    });
  }
  return effects;
}

function compareReplayMessages(currentMessage, proposedMessage) {
  const currentAvailable = typeof currentMessage === 'string' && currentMessage.length > 0;
  const proposedAvailable = typeof proposedMessage === 'string' && proposedMessage.length > 0;
  const currentRedacted = currentAvailable && /^\[mensaje_historico:/i.test(currentMessage);
  let state = 'both_absent';
  if (currentRedacted && proposedAvailable) state = 'current_redacted_proposed_available';
  else if (currentAvailable && proposedAvailable) state = currentMessage === proposedMessage ? 'equal' : 'changed';
  else if (currentAvailable) state = 'current_only';
  else if (proposedAvailable) state = 'proposed_only';
  return {
    state,
    current_available: currentAvailable,
    current_redacted: currentRedacted,
    proposed_available: proposedAvailable,
    exact_match: currentAvailable && proposedAvailable && !currentRedacted
      ? currentMessage === proposedMessage
      : null,
    length_delta: currentAvailable && proposedAvailable && !currentRedacted
      ? proposedMessage.length - currentMessage.length
      : null,
  };
}

function replayTruthCardForGrader(truthCard = {}) {
  return {
    contract_version: truthCard.contract_version,
    source_schema_version: truthCard.source_schema_version,
    alert_ref: truthCard.identity?.content_hash || null,
    nature: clone(truthCard.nature || {}),
    beneficiaries: clone(truthCard.beneficiaries || {}),
    activity: clone(truthCard.activity || {}),
    territory: clone(truthCard.territory || {}),
    action: clone(truthCard.action || {}),
    time: clone(truthCard.time || {}),
    value: clone(truthCard.value || {}),
    quality: clone(truthCard.quality || {}),
    status: truthCard.status || null,
    evidence: Object.fromEntries(Object.entries(truthCard.evidence || {}).map(([field, evidence]) => [
      field,
      {
        ref: evidence.ref,
        level: evidence.level,
        confidence: evidence.confidence,
      },
    ])),
  };
}

function batchContextValues(replayCases, profileSnapshot, field, snapshotField) {
  return [
    ...(profileSnapshot?.[snapshotField] || []),
    ...replayCases.flatMap((replayCase) => replayCase[field] || []),
  ];
}

async function evaluateReplayCaseBatch(replayCases, profileSnapshot, options = {}) {
  if (!Array.isArray(replayCases) || replayCases.length === 0) return [];
  const truthCards = replayCases.map(buildTruthCardFixture);
  const entriesByRef = new Map();
  const primaryByCase = new Map();
  const secondaryByCase = new Map();
  const judgeCalls = new Map(replayCases.map((replayCase) => [replayCase.id, 0]));
  for (let index = 0; index < replayCases.length; index += 1) {
    const replayCase = replayCases[index];
    const truthCard = truthCards[index];
    const primary = buildFixtureJudgeDecision(replayCase, truthCard);
    const secondary = replayCase.second_judge
      ? buildFixtureJudgeDecision({ ...replayCase, judge: replayCase.second_judge }, truthCard)
      : primary;
    primaryByCase.set(replayCase.id, primary);
    secondaryByCase.set(replayCase.id, secondary);
    const reference = String(truthCard.identity?.content_hash || truthCard.identity?.alert_id).slice(0, 100);
    entriesByRef.set(reference, replayCase);
  }
  const responseFor = (request, decisions, model) => {
    const reference = String(request?.input?.untrusted_alert_data?.alert_ref || '');
    const replayCase = entriesByRef.get(reference);
    if (!replayCase) throw new Error(`Caso offline no encontrado para ${reference}`);
    judgeCalls.set(replayCase.id, (judgeCalls.get(replayCase.id) || 0) + 1);
    return {
      parsed: clone(decisions.get(replayCase.id)),
      metadata: { model, usage: null, cost: null },
    };
  };
  const caller = async (request) => responseFor(
    request,
    primaryByCase,
    'offline-fixture-judge'
  );
  const secondOpinionCaller = async (request) => responseFor(
    request,
    secondaryByCase,
    'offline-fixture-second-opinion'
  );
  const sanitizedProfile = sanitizeProfileSnapshot(profileSnapshot);
  const batch = await decideCandidateBatch({
    candidateSets: buildBatchCandidateSets(replayCases, truthCards),
    user: sanitizedProfile.user,
    memories: sanitizedProfile.memories,
    exposures: sanitizedProfile.exposures,
    context: {
      now: `${replayCases[0].date}T10:00:00.000Z`,
      pseudonymSalt: 'offline-replay-fixed-salt',
      recentCommunications: clone(batchContextValues(
        replayCases,
        profileSnapshot,
        'recent_communications',
        'recent_communications'
      )),
      recentDeliveries: clone(batchContextValues(
        replayCases,
        profileSnapshot,
        'recent_deliveries',
        'recent_deliveries'
      )),
      usedIdempotencyKeys: clone(batchContextValues(
        replayCases,
        profileSnapshot,
        'used_idempotency_keys',
        'used_idempotency_keys'
      )),
    },
    policy: {
      topK: 10,
      maxItems: 5,
      judgeConcurrency: 1,
      maxPerTopic: 2,
      maxPerAction: 2,
      maxSendNow: 1,
      ...(options.policy || {}),
    },
    caller,
    secondOpinionCaller,
  });
  const graderProfile = clone(projectProfileForJudge(batch.profile));
  return replayCases.map((replayCase, index) => {
    const truthCard = truthCards[index];
    const primaryDecision = primaryByCase.get(replayCase.id);
    const outcome = findPairOutcome(batch, replayCase.alert.id);
    const message = outcome.approved && outcome.selected?.message_projection
      ? renderSafeMessageBlock(outcome.selected.message_projection)
      : null;
    const delivery = simulateDelivery(outcome, replayCase.observed?.delivery_steps || []);
    const expectedState = replayCase.expected?.proposed_decision || null;
    const expectedReason = replayCase.expected?.reason_code || null;
    const matchesExpected = (!expectedState || outcome.state === expectedState)
      && (!expectedReason || outcome.reason_codes.includes(expectedReason));
    const currentMessage = replayCase.current?.message || null;

    return {
      case_id: replayCase.id,
      date: replayCase.date,
      profile_id: replayCase.profile_id,
      categories: clone(replayCase.categories || []),
      alert_id: replayCase.alert.id,
      territory: clone(replayCase.alert.territory || {}),
      current: {
        state: replayCase.current?.decision || DECISION_STATES.DROP,
        message: currentMessage,
        message_available: replayCase.current?.message_available ?? Boolean(currentMessage),
      },
      proposed: {
        state: outcome.state,
        approved: outcome.approved,
        reason_codes: outcome.reason_codes,
        source: outcome.source,
        idempotency_key: outcome.selected?.idempotency_key || null,
        message,
      },
      expected: {
        state: expectedState,
        reason_code: expectedReason,
        matches: matchesExpected,
      },
      judge: {
        requested_state: primaryDecision.decision,
        calls: judgeCalls.get(replayCase.id) || 0,
        offline: true,
      },
      delivery,
      message_comparison: compareReplayMessages(currentMessage, message),
      subsequent_signals: clone(replayCase.observed || {}),
      memory_effects: deriveMemoryEffects(replayCase.observed, replayCase),
      snapshots: {
        alert: clone(replayCase.alert),
        profile: {
          snapshot_date: profileSnapshot?.snapshot_date || null,
          kind: profileSnapshot?.kind || null,
        },
      },
      grader_context: {
        truth_card: replayTruthCardForGrader(truthCard),
        pseudonymized_profile: graderProfile,
        proposed_safe_message: message,
      },
      batch: {
        candidate_count: replayCases.length,
        portfolio_included: batch.portfolio.items.length,
      },
      funnel: batch.ranking.funnel,
    };
  });
}

async function evaluateReplayCase(replayCase, profileSnapshot, options = {}) {
  const [result] = await evaluateReplayCaseBatch([replayCase], profileSnapshot, options);
  return result;
}

function validateReplayCorpus(corpus, options = {}) {
  const errors = [];
  if (!corpus || typeof corpus !== 'object') return { valid: false, errors: ['corpus_not_object'] };
  if (!Array.isArray(corpus.profiles) || corpus.profiles.length === 0) errors.push('profiles_missing');
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) errors.push('cases_missing');
  const profileIds = new Set((corpus.profiles || []).map((profile) => profile.id));
  const caseIds = new Set();
  const strictGolden = options.strictGolden ?? corpus.version === GOLDEN_CORPUS_VERSION;
  for (const replayCase of corpus.cases || []) {
    if (!replayCase.id || caseIds.has(replayCase.id)) errors.push(`case_id_invalid:${replayCase.id || 'missing'}`);
    caseIds.add(replayCase.id);
    if (!profileIds.has(replayCase.profile_id)) errors.push(`profile_not_found:${replayCase.id}`);
    if (!replayCase.alert?.id) errors.push(`alert_id_missing:${replayCase.id}`);
    if (!validReplayDay(replayCase.date)) errors.push(`date_invalid:${replayCase.id}`);
    if (replayCase.current?.decision != null
      && !Object.values(DECISION_STATES).includes(replayCase.current.decision)) {
      errors.push(`current_decision_invalid:${replayCase.id}`);
    }
    if (replayCase.expected?.proposed_decision != null
      && !Object.values(DECISION_STATES).includes(replayCase.expected.proposed_decision)) {
      errors.push(`expected_decision_invalid:${replayCase.id}`);
    }
    if (strictGolden && !Object.values(DECISION_STATES).includes(replayCase.current?.decision)) {
      errors.push(`golden_current_decision_missing:${replayCase.id}`);
    }
    if (strictGolden && !Object.values(DECISION_STATES).includes(replayCase.expected?.proposed_decision)) {
      errors.push(`golden_expected_decision_missing:${replayCase.id}`);
    }
    if (strictGolden) {
      for (const field of [
        'title',
        'type',
        'topic',
        'summary',
        'territory',
        'sectors',
        'beneficiaries',
        'action',
        'official_url',
      ]) {
        if (!Object.prototype.hasOwnProperty.call(replayCase.alert || {}, field)) {
          errors.push(`golden_alert_field_missing:${replayCase.id}:${field}`);
        }
      }
    }
  }
  if (corpus.profile_snapshots != null && !Array.isArray(corpus.profile_snapshots)) {
    errors.push('profile_snapshots_invalid');
  }
  for (const [index, snapshot] of (corpus.profile_snapshots || []).entries()) {
    if (!profileIds.has(snapshot.profile_id)) errors.push(`snapshot_profile_not_found:${index}`);
    if (!validReplayDay(snapshot.date)) errors.push(`snapshot_date_invalid:${index}`);
  }
  const serializedProfiles = JSON.stringify([
    ...(corpus.profiles || []),
    ...(corpus.profile_snapshots || []),
  ]);
  if (/"(?:phone|telefono|email|name|nombre)"\s*:/i.test(serializedProfiles)) {
    errors.push('profile_contains_direct_identifier');
  }

  if (strictGolden) {
    if (corpus.version !== GOLDEN_CORPUS_VERSION) errors.push('golden_version_invalid');
    const categories = new Set((corpus.cases || []).flatMap((item) => item.categories || []));
    for (const category of REQUIRED_GOLDEN_CATEGORIES) {
      if (!categories.has(category)) errors.push(`golden_category_missing:${category}`);
    }
    const kinds = new Set((corpus.profiles || []).map((profile) => profile.kind));
    for (const kind of REQUIRED_PROFILE_KINDS) {
      if (!kinds.has(kind)) errors.push(`profile_kind_missing:${kind}`);
    }
    const dates = unique((corpus.cases || []).map((item) => item.date)).sort();
    const first = new Date(`${dates[0]}T00:00:00.000Z`);
    const last = new Date(`${dates[dates.length - 1]}T00:00:00.000Z`);
    const spanDays = (last.getTime() - first.getTime()) / 86400000;
    if (dates.length < 4 || !Number.isFinite(spanDays) || spanDays < 21) {
      errors.push('golden_period_shorter_than_four_weeks');
    }
    if (!Array.isArray(corpus.profile_snapshots) || corpus.profile_snapshots.length === 0) {
      errors.push('golden_profile_snapshots_missing');
    }
  }
  return { valid: errors.length === 0, errors };
}

function approved(state) {
  return APPROVED_STATES.has(state);
}

function stableCaseProjection(result) {
  return {
    case_id: result.case_id,
    proposed_state: result.proposed.state,
    reason_codes: [...result.proposed.reason_codes].sort(),
    message: result.proposed.message,
    delivery_status: result.delivery.status,
    memory_effects: result.memory_effects,
    memory_before: result.history?.memory_before || [],
  };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, nested]) => [key, reverseObjectKeys(nested)])
  );
}

async function runMetamorphicChecks(corpus, profilesById, options = {}) {
  const anchor = corpus.cases.find((item) => item.metamorphic_anchor)
    || corpus.cases.find((item) => item.expected?.proposed_decision === DECISION_STATES.ADD_TO_DIGEST);
  if (!anchor) return { passed: false, checks: [], violations: ['metamorphic_anchor_missing'] };
  const profile = profilesById.get(anchor.profile_id);
  const baseline = await evaluateReplayCase(anchor, profile, options);

  const reordered = reverseObjectKeys(clone(anchor));
  const reorderedResult = await evaluateReplayCase(reordered, profile, options);
  const reorderPassed = JSON.stringify(stableCaseProjection(baseline))
    === JSON.stringify(stableCaseProjection(reorderedResult));

  const withoutBeneficiaries = clone(anchor);
  withoutBeneficiaries.id = `${anchor.id}__without_beneficiaries`;
  withoutBeneficiaries.alert.beneficiaries = null;
  withoutBeneficiaries.alert.status = 'insufficient_evidence';
  const missingEvidenceResult = await evaluateReplayCase(withoutBeneficiaries, profile, options);
  const evidencePassed = missingEvidenceResult.proposed.state === DECISION_STATES.HOLD_FOR_EVIDENCE;

  const otherProvince = clone(anchor);
  otherProvince.id = `${anchor.id}__other_province`;
  otherProvince.alert.territory = {
    level: 'provincial',
    provinces: ['Huesca'],
    regions: [],
    municipalities: [],
  };
  const territoryResult = await evaluateReplayCase(otherProvince, profile, options);
  const territoryPassed = territoryResult.proposed.state === DECISION_STATES.BLOCKED;

  const checks = [
    {
      name: 'field_order_does_not_change_decision',
      passed: reorderPassed,
      baseline: baseline.proposed.state,
      mutated: reorderedResult.proposed.state,
    },
    {
      name: 'removing_essential_evidence_never_approves',
      passed: evidencePassed,
      baseline: baseline.proposed.state,
      mutated: missingEvidenceResult.proposed.state,
    },
    {
      name: 'changing_to_other_province_blocks',
      passed: territoryPassed,
      baseline: baseline.proposed.state,
      mutated: territoryResult.proposed.state,
    },
  ];
  return {
    passed: checks.every((check) => check.passed),
    checks,
    violations: checks.filter((check) => !check.passed).map((check) => check.name),
  };
}

function summarizeMetrics(corpus, results, repeatedResults, timeline = []) {
  const gained = results.filter((item) => !approved(item.current.state) && approved(item.proposed.state));
  const lost = results.filter((item) => approved(item.current.state) && !approved(item.proposed.state));
  const territoryChanges = results.filter((item) => {
    const territoryCategory = item.categories.some((category) => [
      'other_province',
      'autonomous_scope',
      'national_scope',
      'individual_case',
      'profile_new',
    ].includes(category));
    const territoryReason = item.proposed.reason_codes.some((code) => [
      REASON_CODES.TERRITORY_MISMATCH,
      REASON_CODES.INDIVIDUAL_TERRITORY_MISSING,
      REASON_CODES.PROFILE_TERRITORY_MISSING,
      REASON_CODES.TERRITORY_EXACT,
      REASON_CODES.TERRITORY_AUTONOMIC,
      REASON_CODES.TERRITORY_NATIONAL,
    ].includes(code));
    return item.current.state !== item.proposed.state && (territoryCategory || territoryReason);
  }).map((item) => ({
    case_id: item.case_id,
    from: item.current.state,
    to: item.proposed.state,
    reason_codes: item.proposed.reason_codes,
  }));
  const silenceCauses = {};
  for (const item of results.filter((entry) => !entry.proposed.approved)) {
    const reason = item.proposed.reason_codes[0] || 'UNKNOWN';
    silenceCauses[reason] = (silenceCauses[reason] || 0) + 1;
  }
  const daily = {};
  for (const item of results) {
    if (!daily[item.date]) daily[item.date] = { current: 0, proposed: 0, delta: 0 };
    if (approved(item.current.state)) daily[item.date].current += 1;
    if (approved(item.proposed.state)) daily[item.date].proposed += 1;
    daily[item.date].delta = daily[item.date].proposed - daily[item.date].current;
  }
  const judgeCalls = results.reduce((sum, item) => sum + item.judge.calls, 0);
  const currentModelCalls = corpus.cases.reduce((sum, item) => sum + Number(item.current?.model_calls || 0), 0);
  const currentMessages = results.filter((item) => approved(item.current.state)).length;
  const proposedMessages = results.filter((item) => item.proposed.approved).length;
  const costs = corpus.cost_assumptions_eur || {};
  const judgeCallCost = Number(costs.judge_call || 0);
  const messageCost = Number(costs.message_attempt || 0);
  const currentCost = currentModelCalls * judgeCallCost + currentMessages * messageCost;
  const proposedCost = judgeCalls * judgeCallCost + proposedMessages * messageCost;
  const llmOnlyChanges = results.filter((item) => (
    item.current.state !== item.proposed.state
    && item.judge.calls > 0
    && item.proposed.source !== 'deterministic_block'
    && item.proposed.source !== 'deterministic_hold'
  )).map((item) => item.case_id);
  const evidenceContradictions = results.filter((item) => (
    approved(item.judge.requested_state)
    && !item.proposed.approved
    && ['deterministic_block', 'deterministic_hold'].includes(item.proposed.source)
  )).map((item) => ({
    case_id: item.case_id,
    judge_requested: item.judge.requested_state,
    authority_result: item.proposed.state,
    reason_codes: item.proposed.reason_codes,
  }));
  const stabilityMismatches = results.filter((item, index) => (
    JSON.stringify(stableCaseProjection(item))
    !== JSON.stringify(stableCaseProjection(repeatedResults[index]))
  )).map((item) => item.case_id);
  const feedbackAgreement = results.filter((item) => item.subsequent_signals.feedback?.polarity).map((item) => ({
    case_id: item.case_id,
    proposed_state: item.proposed.state,
    polarity: item.subsequent_signals.feedback.polarity,
    agrees: item.subsequent_signals.feedback.polarity === 'positive'
      ? item.proposed.approved
      : !item.proposed.approved,
  }));
  const messageStates = {};
  for (const item of results) {
    const state = item.message_comparison?.state || 'unknown';
    messageStates[state] = (messageStates[state] || 0) + 1;
  }
  const effectsApplied = timeline.reduce(
    (sum, day) => sum + (day.memory_effects_applied || []).length,
    0
  );

  return {
    alerts_gained: gained.map((item) => item.case_id),
    alerts_lost: lost.map((item) => item.case_id),
    territory_changes: territoryChanges,
    volume: {
      current: currentMessages,
      proposed: proposedMessages,
      delta: proposedMessages - currentMessages,
      by_day: daily,
    },
    silence_causes: silenceCauses,
    estimated_cost_eur: {
      current: Number(currentCost.toFixed(4)),
      proposed: Number(proposedCost.toFixed(4)),
      delta: Number((proposedCost - currentCost).toFixed(4)),
      assumptions: { judge_call: judgeCallCost, message_attempt: messageCost },
    },
    llm_only_changes: llmOnlyChanges,
    evidence_contradictions: evidenceContradictions,
    stability: {
      repeated_cases: results.length,
      stable_cases: results.length - stabilityMismatches.length,
      mismatches: stabilityMismatches,
      passed: stabilityMismatches.length === 0,
    },
    feedback_agreement: feedbackAgreement,
    messages: {
      by_state: messageStates,
      current_available: results.filter((item) => item.message_comparison?.current_available).length,
      proposed_available: results.filter((item) => item.message_comparison?.proposed_available).length,
      comparable_exactly: results.filter((item) => item.message_comparison?.exact_match !== null).length,
    },
    memory: {
      effects_generated: results.reduce((sum, item) => sum + item.memory_effects.length, 0),
      effects_applied: effectsApplied,
      cases_with_prior_memory: results.filter((item) => item.history?.memory_before_count > 0).length,
    },
    delivery: {
      attempted: results.filter((item) => item.delivery.attempted).length,
      failed: results.filter((item) => [DELIVERY_STATUS.FAILED, DELIVERY_STATUS.UNDELIVERED].includes(item.delivery.status)).length,
      delivered_or_read: results.filter((item) => [DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(item.delivery.status)).length,
    },
  };
}

function inspectOfflineReplaySource(source) {
  const imports = [...String(source || '').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1]);
  const forbiddenImports = imports.filter((target) => (
    target.includes('supabase')
    || target.includes('whatsapp')
    || target === 'axios'
    || target === 'openai'
    || target.startsWith('node:http')
    || target.startsWith('node:https')
  ));
  const mutationCalls = [...String(source || '').matchAll(/\.\s*(insert|upsert|update|delete|rpc)\s*\(/g)]
    .map((match) => match[1]);
  const networkCalls = [...String(source || '').matchAll(/\b(fetch|axios\s*\.[a-z]+)\s*\(/gi)]
    .map((match) => match[1]);
  const fileWriteCalls = [...String(source || '').matchAll(/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(/g)]
    .map((match) => match[1]);
  return {
    safe: forbiddenImports.length === 0
      && mutationCalls.length === 0
      && networkCalls.length === 0
      && fileWriteCalls.length === 0,
    imports,
    forbidden_imports: forbiddenImports,
    mutation_calls: mutationCalls,
    network_calls: networkCalls,
    file_write_calls: fileWriteCalls,
  };
}

async function runOfflineReplay(corpus, options = {}) {
  const validation = validateReplayCorpus(corpus, options);
  if (!validation.valid) {
    const error = new Error(`Corpus de replay inválido: ${validation.errors.join(', ')}`);
    error.code = 'INVALID_REPLAY_CORPUS';
    error.validation = validation;
    throw error;
  }
  const profilesById = new Map(corpus.profiles.map((profile) => [profile.id, profile]));
  const runSequence = () => runDailyHistoricalSequence(corpus, {
    evaluateCase: evaluateReplayCase,
    evaluationOptions: options,
  });
  const sequence = await runSequence();
  const repeatedSequence = await runSequence();
  const results = sequence.results;
  const repeatedResults = repeatedSequence.results;
  const metamorphic = options.metamorphic === false
    ? { passed: true, skipped: true, checks: [], violations: [] }
    : await runMetamorphicChecks(corpus, profilesById, options);
  const metrics = summarizeMetrics(corpus, results, repeatedResults, sequence.timeline);
  const expectationFailures = results
    .filter((item) => !item.expected.matches)
    .map((item) => ({
      case_id: item.case_id,
      expected: item.expected,
      actual: {
        state: item.proposed.state,
        reason_codes: item.proposed.reason_codes,
      },
    }));
  const report = {
    replay_version: REPLAY_VERSION,
    corpus_version: corpus.version,
    mode: 'offline_read_only',
    generated_at: options.generatedAt || null,
    period: sequence.period,
    totals: {
      cases: results.length,
      profiles: corpus.profiles.length,
      expected_passed: results.length - expectationFailures.length,
      expected_failed: expectationFailures.length,
    },
    acceptance: {
      passed: expectationFailures.length === 0 && metrics.stability.passed && metamorphic.passed,
      expectation_failures: expectationFailures,
    },
    metrics,
    metamorphic,
    timeline: sequence.timeline,
    final_profiles: sequence.final_profiles,
    results,
  };
  try {
    report.auxiliary_grader = await gradeReplayReport(report, options.auxiliaryGrader || {});
  } catch (error) {
    report.auxiliary_grader = {
      enabled: options.auxiliaryGrader?.enabled === true,
      auxiliary: true,
      affects_acceptance: false,
      status: 'failed',
      grade: null,
      error_code: error.code || 'AUXILIARY_GRADER_FAILED',
    };
  }
  return report;
}

function formatReplayReport(report) {
  const lines = [
    `Replay offline ${report.corpus_version}`,
    `Periodo: ${report.period.from} a ${report.period.to} (${report.period.span_days} días)`,
    `Casos: ${report.totals.cases}; expectativas: ${report.totals.expected_passed} OK / ${report.totals.expected_failed} fallos`,
    `Volumen actual/propuesto: ${report.metrics.volume.current}/${report.metrics.volume.proposed} (${report.metrics.volume.delta >= 0 ? '+' : ''}${report.metrics.volume.delta})`,
    `Ganadas: ${report.metrics.alerts_gained.length}; perdidas: ${report.metrics.alerts_lost.length}`,
    `Estabilidad: ${report.metrics.stability.stable_cases}/${report.metrics.stability.repeated_cases}`,
    `Memoria: ${report.metrics.memory.effects_applied} señales aplicadas; ${report.metrics.memory.cases_with_prior_memory} casos con historial`,
    `Grader auxiliar: ${report.auxiliary_grader.status}`,
    `Metamórficas: ${report.metamorphic.passed ? 'OK' : 'FALLO'}`,
    `Resultado: ${report.acceptance.passed ? 'OK' : 'FALLO'}`,
  ];
  return lines.join('\n');
}

module.exports = {
  APPROVED_STATES,
  GOLDEN_CORPUS_VERSION,
  REPLAY_VERSION,
  REQUIRED_GOLDEN_CATEGORIES,
  REQUIRED_PROFILE_KINDS,
  buildFactSheetFixture,
  buildFixtureJudgeDecision,
  buildTruthCardFixture,
  compareReplayMessages,
  deriveMemoryEffects,
  evaluateReplayCase,
  formatReplayReport,
  inspectOfflineReplaySource,
  reverseObjectKeys,
  runMetamorphicChecks,
  runOfflineReplay,
  sanitizeProfileSnapshot,
  simulateDelivery,
  stableCaseProjection,
  summarizeMetrics,
  validateReplayCorpus,
};
