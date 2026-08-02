const crypto = require('crypto');
const {
  CONTRACT_VERSIONS,
  DECISION_STATES,
  REASON_CODES,
} = require('./contracts');
const { evaluateCandidateEligibility } = require('./candidatePipeline');
const { evidenceIsUsable, normalizeScore, normalizeText } = require('./truthCard');
const { projectApprovedMessageFacts } = require('./messageProjection');

function idempotencyKey(profile, candidate, decision) {
  const materialVersion = candidate?.truth_card?.identity?.content_hash
    || candidate?.truth_card?.builder_version
    || candidate?.truth_card?.source_schema_version
    || 'initial';
  const source = [
    CONTRACT_VERSIONS.policy,
    profile?.subject_id,
    candidate?.alert_id,
    materialVersion,
    decision?.decision,
  ].join(':');
  return `decision_${crypto.createHash('sha256').update(source).digest('hex').slice(0, 32)}`;
}

function localHour(now, timezone) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone || 'Europe/Madrid',
    }).format(new Date(now)));
  } catch (_error) {
    return new Date(now).getUTCHours();
  }
}

function isQuietHour(profile, now = new Date()) {
  const quiet = profile?.preferences?.quiet_hours || { start: 22, end: 8 };
  const start = Number(quiet.start);
  const end = Number(quiet.end);
  const hour = localHour(now, profile?.preferences?.timezone);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function deliveredCommunications(context = {}) {
  return (context.recentCommunications || []).filter((item) => (
    ['DELIVERED', 'READ'].includes(String(item.status || '').toUpperCase())
    || item.delivered_at
    || item.read_at
  ));
}

function frequencyAllows(profile, context = {}, now = new Date()) {
  const frequency = normalizeText(profile?.preferences?.frequency || 'daily');
  if (['off', 'none', 'paused', 'pausada', 'nunca'].includes(frequency)) return false;
  const delivered = deliveredCommunications(context);
  const current = new Date(now);
  if (frequency.includes('week') || frequency.includes('seman')) {
    return !delivered.some((item) => {
      const date = new Date(item.delivered_at || item.read_at || 0);
      return !Number.isNaN(date.getTime()) && current.getTime() - date.getTime() < 7 * 86400000;
    });
  }
  if (frequency.includes('daily') || frequency.includes('diari')) {
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: profile?.preferences?.timezone || 'Europe/Madrid',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch (_error) {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    }
    const today = formatter.format(current);
    return !delivered.some((item) => {
      const date = new Date(item.delivered_at || item.read_at || 0);
      return !Number.isNaN(date.getTime()) && formatter.format(date) === today;
    });
  }
  return true;
}

function sameAlertDelivery(candidate, context = {}) {
  const alertId = String(candidate?.alert_id);
  return (context.recentDeliveries || []).find((item) => (
    String(item.alert_id ?? item.alerta_id) === alertId
    && (
      item.delivered_at
      || item.legacy_consumed === true
      || ['DELIVERED', 'READ'].includes(String(item.status || '').toUpperCase())
    )
  ));
}

function hasMaterialUpdate(candidate, priorDelivery) {
  if (!priorDelivery) return false;
  const current = candidate?.truth_card?.identity?.content_hash;
  const previous = priorDelivery.material_version || priorDelivery.content_hash;
  return Boolean(current && previous && current !== previous);
}

function buildSafePersonalReason(candidate) {
  const territory = candidate?.eligibility?.trace?.territory?.matches?.[0];
  const activity = candidate?.eligibility?.trace?.activity?.matches?.[0];
  if (activity && territory) return `Coincide con tus preferencias sobre ${activity} en ${territory}.`;
  if (activity) return `Coincide con tus preferencias sobre ${activity}.`;
  if (territory) return `Coincide con el ámbito territorial ${territory} de tu perfil.`;
  return 'Coincide con las preferencias actuales de tu perfil.';
}

function authorizeCandidate({ candidate, profile, judgeDecision, context = {}, policy = {} } = {}) {
  const eligibility = evaluateCandidateEligibility(candidate, profile, {
    policyVersion: policy.version || CONTRACT_VERSIONS.policy,
    now: context.now,
  });
  if (!eligibility.eligible) {
    return {
      approved: false,
      state: eligibility.state,
      reason_codes: eligibility.reason_codes,
      candidate,
      decision: judgeDecision,
      idempotency_key: null,
      message_projection: null,
    };
  }
  if (![DECISION_STATES.SEND_NOW, DECISION_STATES.ADD_TO_DIGEST].includes(judgeDecision?.decision)) {
    return {
      approved: false,
      state: judgeDecision?.decision || DECISION_STATES.HOLD_FOR_EVIDENCE,
      reason_codes: judgeDecision?.reason_codes || [REASON_CODES.LLM_INVALID_OUTPUT],
      candidate,
      decision: judgeDecision,
      idempotency_key: null,
      message_projection: null,
    };
  }

  let effectiveDecision = judgeDecision;
  if (judgeDecision.decision === DECISION_STATES.SEND_NOW) {
    const verifiedUrgency = evidenceIsUsable(candidate.truth_card?.evidence?.deadline)
      && evidenceIsUsable(candidate.truth_card?.evidence?.action)
      && judgeDecision.urgency >= (policy.minSendNowUrgency ?? 0.85)
      && judgeDecision.applicability >= (policy.minSendNowApplicability ?? 0.8)
      && normalizeScore(candidate.truth_card?.quality?.truth) >= (policy.minSendNowTruth ?? 0.8);
    if (!verifiedUrgency) {
      effectiveDecision = {
        ...judgeDecision,
        decision: DECISION_STATES.ADD_TO_DIGEST,
        reason_codes: [...new Set([
          ...judgeDecision.reason_codes,
          REASON_CODES.SEND_NOW_REQUIRES_VERIFIED_URGENCY,
          REASON_CODES.SEND_NOW_DOWNGRADED,
        ])],
      };
    }
  }

  const priorDelivery = sameAlertDelivery(candidate, context);
  const materialUpdate = hasMaterialUpdate(candidate, priorDelivery);
  if (priorDelivery && !materialUpdate) {
    return {
      approved: false,
      state: DECISION_STATES.DROP,
      reason_codes: [REASON_CODES.ALREADY_DELIVERED],
      candidate,
      decision: effectiveDecision,
      idempotency_key: null,
      message_projection: null,
    };
  }

  const key = idempotencyKey(profile, candidate, effectiveDecision);
  if (new Set(context.usedIdempotencyKeys || []).has(key)) {
    return {
      approved: false,
      state: DECISION_STATES.DROP,
      reason_codes: [REASON_CODES.IDEMPOTENCY_REPLAY],
      candidate,
      decision: effectiveDecision,
      idempotency_key: key,
      message_projection: null,
    };
  }

  const now = new Date(context.now || Date.now());
  const severe = context.severity === 'critical' && effectiveDecision.urgency >= 0.95;
  if (isQuietHour(profile, now) && !severe) {
    return {
      approved: false,
      state: effectiveDecision.decision === DECISION_STATES.SEND_NOW
        ? DECISION_STATES.ADD_TO_DIGEST
        : effectiveDecision.decision,
      reason_codes: [REASON_CODES.OUTSIDE_SEND_WINDOW],
      candidate,
      decision: effectiveDecision,
      idempotency_key: key,
      message_projection: null,
      deferred: true,
    };
  }
  if (effectiveDecision.decision === DECISION_STATES.ADD_TO_DIGEST
    && !frequencyAllows(profile, context, now)) {
    return {
      approved: false,
      state: DECISION_STATES.DROP,
      reason_codes: [REASON_CODES.FREQUENCY_LIMIT],
      candidate,
      decision: effectiveDecision,
      idempotency_key: key,
      message_projection: null,
    };
  }

  const messageProjection = projectApprovedMessageFacts({
    truthCard: candidate.truth_card,
    decision: effectiveDecision,
    userReason: buildSafePersonalReason(candidate),
  });
  const hasOfficialUrl = messageProjection.facts.some((fact) => fact.field === 'official_url');
  if (!messageProjection.allowed || !hasOfficialUrl) {
    return {
      approved: false,
      state: DECISION_STATES.HOLD_FOR_EVIDENCE,
      reason_codes: [REASON_CODES.MESSAGE_FACTS_INVALID],
      candidate,
      decision: effectiveDecision,
      idempotency_key: key,
      message_projection: messageProjection,
    };
  }

  return {
    approved: true,
    state: effectiveDecision.decision,
    reason_codes: [...new Set([
      ...effectiveDecision.reason_codes,
      effectiveDecision.decision === DECISION_STATES.SEND_NOW
        ? REASON_CODES.APPROVED_URGENT
        : REASON_CODES.APPROVED_DIGEST,
      ...(materialUpdate ? [REASON_CODES.MATERIAL_UPDATE] : []),
    ])],
    candidate,
    decision: effectiveDecision,
    idempotency_key: key,
    message_projection: messageProjection,
  };
}

function topicKey(item) {
  return normalizeText(
    item.candidate?.truth_card?.nature?.topic
    || item.candidate?.truth_card?.nature?.type
    || 'sin tema'
  );
}

function actionKey(item) {
  return normalizeText(item.candidate?.truth_card?.action?.code || item.candidate?.truth_card?.action?.label || 'informacion');
}

function deadlineTime(item) {
  const value = item.candidate?.truth_card?.time?.deadline;
  const date = new Date(value || 8640000000000000);
  return Number.isNaN(date.getTime()) ? 8640000000000000 : date.getTime();
}

function portfolioPriority(left, right) {
  const immediate = Number(right.state === DECISION_STATES.SEND_NOW) - Number(left.state === DECISION_STATES.SEND_NOW);
  if (immediate) return immediate;
  const exploration = Number(left.candidate?.is_exploration) - Number(right.candidate?.is_exploration);
  if (exploration) return exploration;
  const actionability = Number(right.decision?.actionability || 0) - Number(left.decision?.actionability || 0);
  if (actionability) return actionability;
  const deadline = deadlineTime(left) - deadlineTime(right);
  if (deadline) return deadline;
  const score = Number(right.candidate?.pre_score || 0) - Number(left.candidate?.pre_score || 0);
  if (score) return score;
  return String(left.candidate?.alert_id).localeCompare(String(right.candidate?.alert_id), 'es', { numeric: true });
}

function buildPortfolio({ authorized = [], profile, policy = {} } = {}) {
  const maxItems = Math.max(1, Math.min(5, Number(policy.maxItems || profile?.preferences?.max_digest_items || 5)));
  const maxPerTopic = Math.max(1, Number(policy.maxPerTopic || 2));
  const maxPerAction = Math.max(1, Number(policy.maxPerAction || 2));
  const sorted = authorized.filter((item) => item.approved).sort(portfolioPriority);
  const selected = [];
  const rejected = authorized.filter((item) => !item.approved);
  const seenAlerts = new Set();
  const seenKeys = new Set();
  const topicCounts = new Map();
  const actionCounts = new Map();
  const seenEquivalences = new Set();
  let explorationCount = 0;
  let sendNowCount = 0;
  const maxSendNow = Math.max(0, Math.min(2, Number(policy.maxSendNow ?? 1)));

  for (const item of sorted) {
    const alertKey = String(item.candidate?.alert_id);
    if (seenAlerts.has(alertKey) || seenKeys.has(item.idempotency_key)) {
      rejected.push({ ...item, approved: false, state: DECISION_STATES.DROP, reason_codes: [REASON_CODES.DUPLICATE_IN_PORTFOLIO] });
      continue;
    }
    const equivalenceKey = normalizeText(item.candidate?.metadata?.equivalence_key);
    if (equivalenceKey && seenEquivalences.has(equivalenceKey)) {
      rejected.push({ ...item, approved: false, state: DECISION_STATES.DROP, reason_codes: [REASON_CODES.DUPLICATE_IN_PORTFOLIO] });
      continue;
    }
    if (selected.length >= maxItems) {
      rejected.push({ ...item, approved: false, state: DECISION_STATES.DROP, reason_codes: [REASON_CODES.PORTFOLIO_LIMIT] });
      continue;
    }
    if (item.candidate?.is_exploration && explorationCount >= 1) {
      rejected.push({ ...item, approved: false, state: DECISION_STATES.DROP, reason_codes: [REASON_CODES.EXPLORATION_LIMIT] });
      continue;
    }
    if (item.state === DECISION_STATES.SEND_NOW && sendNowCount >= maxSendNow) {
      rejected.push({ ...item, approved: false, state: DECISION_STATES.DROP, reason_codes: [REASON_CODES.FREQUENCY_LIMIT] });
      continue;
    }
    const topic = topicKey(item);
    const action = actionKey(item);
    if ((topicCounts.get(topic) || 0) >= maxPerTopic || (actionCounts.get(action) || 0) >= maxPerAction) {
      rejected.push({ ...item, approved: false, state: DECISION_STATES.DROP, reason_codes: [REASON_CODES.DIVERSITY_LIMIT] });
      continue;
    }
    selected.push(item);
    seenAlerts.add(alertKey);
    seenKeys.add(item.idempotency_key);
    if (equivalenceKey) seenEquivalences.add(equivalenceKey);
    topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    actionCounts.set(action, (actionCounts.get(action) || 0) + 1);
    if (item.candidate?.is_exploration) explorationCount += 1;
    if (item.state === DECISION_STATES.SEND_NOW) sendNowCount += 1;
  }

  return {
    contract_version: CONTRACT_VERSIONS.portfolio,
    items: selected,
    send_now: selected.filter((item) => item.state === DECISION_STATES.SEND_NOW),
    digest: selected.filter((item) => item.state === DECISION_STATES.ADD_TO_DIGEST),
    rejected,
    silence: selected.length === 0,
    counts: {
      approved_input: sorted.length,
      included: selected.length,
      rejected: rejected.length,
      exploration: explorationCount,
    },
  };
}

module.exports = {
  idempotencyKey,
  isQuietHour,
  frequencyAllows,
  authorizeCandidate,
  buildPortfolio,
};
