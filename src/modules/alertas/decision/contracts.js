const { z } = require('zod');
const {
  DELIVERY_STATUS,
  resolverTransicionEntrega,
} = require('../../delivery/deliveryState');

const CONTRACT_VERSIONS = Object.freeze({
  truthCard: 'alert_truth_card_v1',
  profile: 'user_decision_profile_v1',
  candidate: 'alert_candidate_v1',
  decision: 'alert_user_decision_v1',
  policy: 'alert_decision_policy_v1',
  portfolio: 'alert_portfolio_v1',
  recovery: 'hold_recovery_v1',
  messageFacts: 'message_facts_v1',
  delivery: 'delivery_state_v1',
});

const DECISION_STATES = Object.freeze({
  SEND_NOW: 'SEND_NOW',
  ADD_TO_DIGEST: 'ADD_TO_DIGEST',
  HOLD_FOR_EVIDENCE: 'HOLD_FOR_EVIDENCE',
  DROP: 'DROP',
  BLOCKED: 'BLOCKED',
});

const TRUTH_CARD_STATES = Object.freeze({
  READY: 'READY',
  INCOMPLETE: 'INCOMPLETE',
  REVIEW: 'REVIEW',
  BLOCKED: 'BLOCKED',
  EXPIRED: 'EXPIRED',
});

const EVIDENCE_LEVELS = Object.freeze({
  VERIFIED: 'verified',
  SUPPORTED: 'supported',
  UNCERTAIN: 'uncertain',
  UNSUPPORTED: 'unsupported',
  NOT_APPLICABLE: 'not_applicable',
});

const CANDIDATE_GENERATORS = Object.freeze({
  EXACT: 'exact',
  SEMANTIC: 'semantic',
  MEMORY: 'memory',
  COVERAGE: 'coverage',
  EXPLORATION: 'exploration',
});

// Lista cerrada. Las explicaciones legibles van en user_reason, no creando
// nuevos codigos en tiempo de ejecucion.
const REASON_CODES = Object.freeze({
  APPROVED_DIGEST: 'APPROVED_DIGEST',
  APPROVED_URGENT: 'APPROVED_URGENT',
  TERRITORY_EXACT: 'TERRITORY_EXACT',
  TERRITORY_NATIONAL: 'TERRITORY_NATIONAL',
  TERRITORY_AUTONOMIC: 'TERRITORY_AUTONOMIC',
  PROFILE_TERRITORY_MISSING: 'PROFILE_TERRITORY_MISSING',
  TERRITORY_MISMATCH: 'TERRITORY_MISMATCH',
  TERRITORY_EVIDENCE_MISSING: 'TERRITORY_EVIDENCE_MISSING',
  INDIVIDUAL_TERRITORY_MISSING: 'INDIVIDUAL_TERRITORY_MISSING',
  ACTIVITY_MISMATCH: 'ACTIVITY_MISMATCH',
  BENEFICIARY_MISMATCH: 'BENEFICIARY_MISMATCH',
  EXPLICIT_EXCLUSION: 'EXPLICIT_EXCLUSION',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED',
  TRUTH_CARD_INVALID: 'TRUTH_CARD_INVALID',
  TRUTH_CARD_BLOCKED: 'TRUTH_CARD_BLOCKED',
  CONTRADICTORY_EVIDENCE: 'CONTRADICTORY_EVIDENCE',
  BENEFICIARY_EVIDENCE_MISSING: 'BENEFICIARY_EVIDENCE_MISSING',
  ACTION_EVIDENCE_MISSING: 'ACTION_EVIDENCE_MISSING',
  DEADLINE_EVIDENCE_MISSING: 'DEADLINE_EVIDENCE_MISSING',
  OFFICIAL_URL_MISSING: 'OFFICIAL_URL_MISSING',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  ACTIVITY_MATCH: 'ACTIVITY_MATCH',
  BENEFICIARY_MATCH: 'BENEFICIARY_MATCH',
  ACTIONABLE: 'ACTIONABLE',
  URGENCY_VERIFIED: 'URGENCY_VERIFIED',
  EXACT_CANDIDATE: 'EXACT_CANDIDATE',
  SEMANTIC_CANDIDATE: 'SEMANTIC_CANDIDATE',
  MEMORY_CANDIDATE: 'MEMORY_CANDIDATE',
  COVERAGE_CANDIDATE: 'COVERAGE_CANDIDATE',
  SAFE_EXPLORATION: 'SAFE_EXPLORATION',
  LOW_RELEVANCE: 'LOW_RELEVANCE',
  LOW_UTILITY: 'LOW_UTILITY',
  TOO_GENERIC: 'TOO_GENERIC',
  NOT_NOVEL: 'NOT_NOVEL',
  ALREADY_DELIVERED: 'ALREADY_DELIVERED',
  DUPLICATE_IN_PORTFOLIO: 'DUPLICATE_IN_PORTFOLIO',
  IDEMPOTENCY_REPLAY: 'IDEMPOTENCY_REPLAY',
  FREQUENCY_LIMIT: 'FREQUENCY_LIMIT',
  OUTSIDE_SEND_WINDOW: 'OUTSIDE_SEND_WINDOW',
  PORTFOLIO_LIMIT: 'PORTFOLIO_LIMIT',
  TOP_K_LIMIT: 'TOP_K_LIMIT',
  DIVERSITY_LIMIT: 'DIVERSITY_LIMIT',
  EXPLORATION_LIMIT: 'EXPLORATION_LIMIT',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  LLM_BUDGET_EXHAUSTED: 'LLM_BUDGET_EXHAUSTED',
  LLM_INVALID_OUTPUT: 'LLM_INVALID_OUTPUT',
  LLM_ABSTAINED: 'LLM_ABSTAINED',
  JUDGE_CONTRADICTION: 'JUDGE_CONTRADICTION',
  MESSAGE_FACTS_INVALID: 'MESSAGE_FACTS_INVALID',
  SECOND_OPINION_DISAGREEMENT: 'SECOND_OPINION_DISAGREEMENT',
  HOLD_RETRY_EXHAUSTED: 'HOLD_RETRY_EXHAUSTED',
  SEND_NOW_REQUIRES_VERIFIED_URGENCY: 'SEND_NOW_REQUIRES_VERIFIED_URGENCY',
  SEND_NOW_DOWNGRADED: 'SEND_NOW_DOWNGRADED',
  MATERIAL_UPDATE: 'MATERIAL_UPDATE',
  RECOVERY_SCHEDULED: 'RECOVERY_SCHEDULED',
  RECOVERY_BACKOFF: 'RECOVERY_BACKOFF',
  RECOVERY_STRATEGY_EXHAUSTED: 'RECOVERY_STRATEGY_EXHAUSTED',
  UPSTREAM_MATERIAL_MISSING: 'UPSTREAM_MATERIAL_MISSING',
  RECOVERY_EVIDENCE_FOUND: 'RECOVERY_EVIDENCE_FOUND',
  RECOVERY_EXPIRED: 'RECOVERY_EXPIRED',
});

const TRANSIENT_HOLD_REASON_CODES = Object.freeze([
  REASON_CODES.LLM_UNAVAILABLE,
  REASON_CODES.LLM_BUDGET_EXHAUSTED,
  REASON_CODES.LLM_INVALID_OUTPUT,
  REASON_CODES.LLM_ABSTAINED,
  REASON_CODES.JUDGE_CONTRADICTION,
  REASON_CODES.SECOND_OPINION_DISAGREEMENT,
]);

const DELIVERY_STATES = DELIVERY_STATUS;

const messageFactSchema = z.object({
  field: z.enum([
    'title',
    'summary',
    'beneficiaries',
    'territory',
    'action',
    'deadline',
    'amount',
    'official_url',
  ]),
  evidence_ref: z.string().min(1).max(80),
}).strict();

const judgeDecisionSchema = z.object({
  contract_version: z.literal(CONTRACT_VERSIONS.decision),
  policy_version: z.literal(CONTRACT_VERSIONS.policy),
  decision: z.enum(Object.values(DECISION_STATES)),
  applicability: z.number().min(0).max(1),
  usefulness: z.number().min(0).max(1),
  actionability: z.number().min(0).max(1),
  urgency: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reason_codes: z.array(z.enum(Object.values(REASON_CODES))).min(1).max(12),
  evidence_refs: z.array(z.string().min(1).max(80)).max(20),
  missing_information: z.array(z.string().min(1).max(120)).max(10),
  user_reason: z.string().min(1).max(280),
  message_facts: z.array(messageFactSchema).max(12),
}).strict();

function validateJudgeDecision(value) {
  const result = judgeDecisionSchema.safeParse(value);
  return result.success
    ? { valid: true, value: result.data, errors: [] }
    : {
      valid: false,
      value: null,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
}

function isKnownReasonCode(code) {
  return Object.values(REASON_CODES).includes(code);
}

function canTransitionDelivery(from, to) {
  return resolverTransicionEntrega(from, to).apply;
}

module.exports = {
  CONTRACT_VERSIONS,
  DECISION_STATES,
  TRUTH_CARD_STATES,
  EVIDENCE_LEVELS,
  CANDIDATE_GENERATORS,
  REASON_CODES,
  TRANSIENT_HOLD_REASON_CODES,
  DELIVERY_STATES,
  judgeDecisionSchema,
  validateJudgeDecision,
  isKnownReasonCode,
  canTransitionDelivery,
};
