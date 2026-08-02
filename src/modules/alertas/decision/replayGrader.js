const AUXILIARY_GRADER_VERSION = 'alert_decision_auxiliary_grader_v1';
const MAX_GRADER_CASES = 250;

const AUXILIARY_GRADER_SCHEMA = Object.freeze({
  type: 'json_schema',
  name: 'alert_decision_replay_auxiliary_grade',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['score', 'severity', 'summary', 'anomalies'],
    properties: {
      score: { type: 'number', minimum: 0, maximum: 1 },
      severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
      summary: { type: 'string', minLength: 1, maxLength: 600 },
      anomalies: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['case_id', 'reason'],
          properties: {
            case_id: { type: 'string', minLength: 1, maxLength: 120 },
            reason: { type: 'string', minLength: 1, maxLength: 300 },
          },
        },
      },
    },
  },
});

function compactGraderInput(report = {}) {
  const allCases = (report.results || []).map((result) => ({
    case_id: result.case_id,
    date: result.date,
    current_state: result.current?.state || null,
    proposed_state: result.proposed?.state || null,
    reason_codes: result.proposed?.reason_codes || [],
    message_comparison: result.message_comparison || null,
    memory_before_count: result.history?.memory_before_count || 0,
    expected_matches: result.expected?.matches ?? null,
  }));
  const prioritized = [...allCases].sort((left, right) => {
    const priority = (item) => Number(item.expected_matches === false) * 4
      + Number(item.current_state !== item.proposed_state) * 2
      + Number(['changed', 'current_only'].includes(item.message_comparison?.state));
    return priority(right) - priority(left)
      || String(left.date).localeCompare(String(right.date))
      || String(left.case_id).localeCompare(String(right.case_id));
  });
  const input = {
    replay_version: report.replay_version || null,
    corpus_version: report.corpus_version || null,
    period: report.period || null,
    totals: report.totals || null,
    metrics: report.metrics || null,
    metamorphic: report.metamorphic || null,
    case_count: allCases.length,
    cases_truncated: allCases.length > MAX_GRADER_CASES,
    cases: prioritized.slice(0, MAX_GRADER_CASES),
  };
  return JSON.parse(JSON.stringify(input));
}

function normalizeCallerResult(value) {
  const candidate = value?.parsed ?? value?.output ?? value?.result ?? value;
  if (typeof candidate === 'string') return JSON.parse(candidate);
  return candidate;
}

function validateAuxiliaryGrade(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['grade_not_object'] };
  }
  if (!Number.isFinite(value.score) || value.score < 0 || value.score > 1) errors.push('score_invalid');
  if (!['none', 'low', 'medium', 'high'].includes(value.severity)) errors.push('severity_invalid');
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 600) {
    errors.push('summary_invalid');
  }
  if (!Array.isArray(value.anomalies) || value.anomalies.length > 20) {
    errors.push('anomalies_invalid');
  } else {
    for (const [index, anomaly] of value.anomalies.entries()) {
      const fields = anomaly && typeof anomaly === 'object' ? Object.keys(anomaly) : [];
      if (!anomaly
        || typeof anomaly.case_id !== 'string'
        || !anomaly.case_id.trim()
        || anomaly.case_id.length > 120
        || typeof anomaly.reason !== 'string'
        || !anomaly.reason.trim()
        || anomaly.reason.length > 300
        || fields.some((field) => !['case_id', 'reason'].includes(field))) {
        errors.push(`anomaly_invalid:${index}`);
      }
    }
  }
  const allowed = new Set(['score', 'severity', 'summary', 'anomalies']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`unexpected_field:${key}`);
  }
  return { valid: errors.length === 0, errors };
}

async function gradeReplayReport(report, options = {}) {
  const base = {
    enabled: options.enabled === true,
    auxiliary: true,
    affects_acceptance: false,
    grader_version: AUXILIARY_GRADER_VERSION,
  };
  if (!base.enabled) return { ...base, status: 'disabled', grade: null, metadata: null };
  if (typeof options.caller !== 'function') {
    throw new TypeError('El grader auxiliar requiere un caller inyectado');
  }
  const response = await options.caller({
    input: compactGraderInput(report),
    schema: AUXILIARY_GRADER_SCHEMA,
    grader_version: AUXILIARY_GRADER_VERSION,
  });
  const grade = normalizeCallerResult(response);
  const validation = validateAuxiliaryGrade(grade);
  if (!validation.valid) {
    const error = new Error(`Salida invalida del grader auxiliar: ${validation.errors.join(', ')}`);
    error.code = 'INVALID_AUXILIARY_GRADE';
    error.validation = validation;
    throw error;
  }
  return {
    ...base,
    status: 'completed',
    grade,
    metadata: response?.metadata || null,
  };
}

module.exports = {
  AUXILIARY_GRADER_SCHEMA,
  AUXILIARY_GRADER_VERSION,
  MAX_GRADER_CASES,
  compactGraderInput,
  gradeReplayReport,
  validateAuxiliaryGrade,
};
