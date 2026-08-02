const contracts = require('./contracts');
const truthCard = require('./truthCard');
const decisionProfile = require('./decisionProfile');
const candidatePipeline = require('./candidatePipeline');
const judge = require('./judge');
const authority = require('./authority');
const holdRecovery = require('./holdRecovery');
const messageProjection = require('./messageProjection');

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  const concurrency = Math.max(1, Math.min(items.length || 1, Number(limit) || 1));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function decideCandidateBatch({
  candidateSets = {},
  user,
  profile: providedProfile,
  memories,
  exposures,
  context = {},
  policy = {},
  caller,
  secondOpinionCaller,
  loadCachedDecisions,
  budget,
} = {}) {
  const profile = providedProfile || decisionProfile.buildDecisionProfile({
    user,
    memories,
    exposures,
    now: context.now,
    pseudonymSalt: context.pseudonymSalt,
  });
  const ranking = candidatePipeline.rankCandidateUnion({
    candidateSets,
    profile,
    topK: policy.topK,
    now: context.now,
    policyVersion: policy.version,
  });
  const judgeConcurrency = Math.max(1, Math.min(6, Number(policy.judgeConcurrency) || 3));
  const judgePlans = ranking.candidates.map((candidate) => {
    const request = judge.buildJudgeRequest({ candidate, profile, context, policy });
    return { candidate, request, inputHash: judge.hashJudgeRequest(request) };
  });
  let cachedDecisions = new Map();
  if (typeof loadCachedDecisions === 'function' && typeof caller === 'function' && judgePlans.length > 0) {
    try {
      const loaded = await loadCachedDecisions({
        inputHashes: [...new Set(judgePlans.map((item) => item.inputHash))],
        compatibility: judge.getJudgeCompatibility(caller),
      });
      if (loaded instanceof Map) cachedDecisions = loaded;
      else if (loaded && typeof loaded === 'object') cachedDecisions = new Map(Object.entries(loaded));
    } catch {
      // La cache es una optimizacion. Un fallo no cambia la autoridad ni el resultado seguro.
      cachedDecisions = new Map();
    }
  }
  const evaluated = await mapWithConcurrency(judgePlans, judgeConcurrency, async (plan) => {
    const { candidate, request, inputHash } = plan;
    let judged;
    try {
      judged = await judge.judgeCandidate({
        candidate,
        profile,
        context,
        caller,
        secondOpinionCaller,
        policy,
        cachedDecision: cachedDecisions.get(inputHash) || null,
        prebuiltRequest: request,
        budget,
      });
    } catch (error) {
      judged = await judge.judgeCandidate({
        candidate,
        profile,
        context,
        caller: null,
        secondOpinionCaller: null,
        policy: { ...policy, allowDeterministicFallback: false },
        prebuiltRequest: request,
        budget,
      });
      judged.audit.error_type = error?.name || 'Error';
      judged.audit.fallback = 'candidate_isolation';
    }
    judged = judge.aplicarSalidaHoldAgotado({ candidate, judged });
    const authorized = authority.authorizeCandidate({
      candidate,
      profile,
      judgeDecision: judged.decision,
      context,
      policy,
    });
    return { candidate, judged, authorized };
  });
  const portfolio = authority.buildPortfolio({
    authorized: evaluated.map((item) => item.authorized),
    profile,
    policy,
  });
  return {
    contract_version: contracts.CONTRACT_VERSIONS.decision,
    policy_version: policy.version || contracts.CONTRACT_VERSIONS.policy,
    profile,
    ranking,
    evaluated,
    portfolio,
    judge_budget: budget && typeof budget.snapshot === 'function' ? budget.snapshot() : null,
    holds: [
      ...ranking.holds,
      ...evaluated.filter((item) => (
        item.authorized.state === contracts.DECISION_STATES.HOLD_FOR_EVIDENCE
      )),
    ],
  };
}

module.exports = {
  contracts,
  truthCard,
  decisionProfile,
  candidatePipeline,
  judge,
  authority,
  holdRecovery,
  messageProjection,
  mapWithConcurrency,
  decideCandidateBatch,
  ...contracts,
  ...truthCard,
  ...decisionProfile,
  ...candidatePipeline,
  ...judge,
  ...authority,
  ...holdRecovery,
  ...messageProjection,
};
