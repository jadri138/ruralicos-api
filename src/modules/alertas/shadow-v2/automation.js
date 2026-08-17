const crypto = require('crypto');
const { runShadowV2Workflow } = require('./workflow');

const DAILY_RUN_NAMESPACE = 'ruralicos:shadow-v2:daily:v2';

function assertDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error('fecha debe tener formato YYYY-MM-DD');
  }
}

function dailyWorkflowRunKey(workflowDate) {
  assertDate(workflowDate);
  const bytes = Buffer.from(
    crypto.createHash('sha256').update(`${DAILY_RUN_NAMESPACE}:${workflowDate}`).digest('hex').slice(0, 32),
    'hex'
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resolveWorkflowRunKey(workflowDate, workflowRunKey) {
  const value = workflowRunKey || dailyWorkflowRunKey(workflowDate);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value))) {
    throw new Error('run_key debe ser un UUID valido');
  }
  return String(value);
}

function summarizeWorkflowResult(result) {
  const ai1 = result?.ai1 || null;
  const ai2 = result?.ai2 || null;
  const errors = Number(ai1?.errors || 0) + Number(ai2?.errors || 0);
  return {
    success: true,
    done: !result?.stopped,
    workflow_run_key: result?.workflowRunKey,
    workflow_date: result?.workflowDate,
    stopped: result?.stopped || null,
    calls: Number(result?.calls || 0),
    processed: Number(ai1?.processed || 0) + Number(ai2?.processed || 0),
    errors,
    ai1: ai1 ? {
      found: Number(ai1.found || 0),
      processed: Number(ai1.processed || 0),
      resumed: Number(ai1.resumed || 0),
      filtered: Number(ai1.filtered || 0),
      classified: Number(ai1.classified || 0),
      errors: Number(ai1.errors || 0),
      remaining: Number(ai1.remaining || 0),
    } : null,
    ai2: ai2 ? {
      found: Number(ai2.found || 0),
      processed: Number(ai2.processed || 0),
      resumed: Number(ai2.resumed || 0),
      generated: Number(ai2.generated || 0),
      empty: Number(ai2.empty || 0),
      no_candidates: Number(ai2.noCandidates || 0),
      errors: Number(ai2.errors || 0),
      remaining: Number(ai2.remaining || 0),
      send_gate_version: ai2.sendGateVersion || null,
      send_gate_allowed: Number(ai2.sendGateAllowed || 0),
      send_gate_blocked: Number(ai2.sendGateBlocked || 0),
      send_gate_reasons: ai2.sendGateReasons || {},
    } : null,
  };
}

async function runAutomatedShadowV2Batch({
  supabase,
  workflowDate,
  workflowRunKey: requestedWorkflowRunKey,
  limitOverrides = {},
  runWorkflow = runShadowV2Workflow,
  logger = console,
} = {}) {
  assertDate(workflowDate);
  const workflowRunKey = resolveWorkflowRunKey(workflowDate, requestedWorkflowRunKey);
  const result = await runWorkflow({
    supabase,
    workflowDate,
    workflowRunKey,
    limitOverrides,
    logger,
  });
  return summarizeWorkflowResult(result);
}

module.exports = {
  DAILY_RUN_NAMESPACE,
  dailyWorkflowRunKey,
  resolveWorkflowRunKey,
  summarizeWorkflowResult,
  runAutomatedShadowV2Batch,
};
