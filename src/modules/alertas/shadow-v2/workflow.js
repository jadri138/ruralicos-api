const crypto = require('crypto');
const { prefilterAlert } = require('./prefilter');
const { classifyAlertWithAi1 } = require('./ai1');
const { matchClassificationToProfile, orderCandidates } = require('./profileMatch');
const { buildAi2Prompt, decideDigestWithAi2 } = require('./ai2');
const { projectDigest } = require('./render');
const {
  AI1_MODEL,
  AI2_MODEL,
  VERSIONS,
  normalizeLimits,
} = require('./config');
const repository = require('./repository');

function assertRunKey(runKey) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(runKey || ''))) {
    throw new Error('run_key debe ser un UUID valido');
  }
}

function assertWorkflowDate(workflowDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(workflowDate || ''))) {
    throw new Error('fecha debe tener formato YYYY-MM-DD');
  }
}

function hasExpiredDeadline(classification, workflowDate) {
  const deadline = classification?.card?.deadline;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(deadline || '')) && deadline < workflowDate;
}

function createCallBudget(maxTotalCalls) {
  let used = 0;
  return {
    get used() { return used; },
    get remaining() { return Math.max(0, maxTotalCalls - used); },
    claim() {
      if (used >= maxTotalCalls) return false;
      used += 1;
      return true;
    },
  };
}

function classificationRow({ workflowRunKey, workflowDate, snapshot, prefilter, ai1 }) {
  const ai1Called = Boolean(ai1) && ai1.called !== false;
  return {
    workflow_run_key: workflowRunKey,
    workflow_date: workflowDate,
    alert_id: snapshot.alert_id,
    official_snapshot: snapshot,
    prefilter_result: prefilter,
    ai1_called: ai1Called,
    classification: ai1?.normalizedResponse || null,
    model: ai1 ? AI1_MODEL : null,
    engine_version: VERSIONS.engine,
    contract_version: VERSIONS.ai1Contract,
    prompt_version: VERSIONS.ai1Prompt,
    prompt_text: ai1?.prompt || null,
    raw_response: ai1?.rawResponse || null,
    normalized_response: ai1?.normalizedResponse || null,
    usage_json: {
      ...(ai1?.usage || {}),
      calls: ai1Called ? 1 : 0,
      prompt_chars: ai1?.prompt?.length || 0,
      official_content_chars: snapshot.official_content?.length || 0,
      official_content_original_chars: snapshot.official_content_original_chars || 0,
    },
    duration_ms: ai1?.durationMs || 0,
    status: ai1 ? ai1.status : 'FILTERED',
    error_code: ai1?.error?.code || null,
    error_message: ai1?.error?.message || null,
  };
}

async function runAi1Phase({
  supabase,
  workflowRunKey,
  workflowDate,
  limits,
  budget,
  callAi1,
  repo,
  logger,
} = {}) {
  const existingIds = await repo.loadExistingClassificationIds(supabase, workflowRunKey, workflowDate);
  const allAlerts = await repo.loadAlerts(supabase, { workflowDate });
  const pendingAlerts = allAlerts.filter((alert) => !existingIds.has(Number(alert.id)));
  const alerts = pendingAlerts.slice(0, limits.maxAlerts);
  const documents = await repo.loadOfficialDocuments(supabase, alerts.map((alert) => alert.id));
  const summary = {
    found: allAlerts.length,
    pendingAtStart: pendingAlerts.length,
    processed: 0,
    resumed: existingIds.size,
    filtered: 0,
    classified: 0,
    errors: 0,
  };

  for (const [index, alert] of alerts.entries()) {
    const snapshot = repo.officialSnapshot(alert, documents.get(Number(alert.id)), limits.maxOfficialCharsPerAlert);
    const prefilter = prefilterAlert(snapshot);
    let ai1 = null;
    if (prefilter.passed) {
      if (!budget.claim()) {
        return { ...summary, limitReached: 'max_total_calls', stoppedBeforeAlertId: alert.id };
      }
      ai1 = await callAi1({ officialSnapshot: snapshot, maxOfficialChars: limits.maxOfficialCharsPerAlert });
      if (ai1.status === 'SUCCESS') summary.classified += 1;
      else summary.errors += 1;
    } else {
      summary.filtered += 1;
    }
    await repo.insertClassification(supabase, classificationRow({
      workflowRunKey, workflowDate, snapshot, prefilter, ai1,
    }));
    summary.processed += 1;
    logger.info(`[shadow-v2] IA 1 ${index + 1}/${alerts.length}: alerta ${alert.id} -> ${ai1?.status || 'FILTERED'}`);
  }
  if (pendingAlerts.length > alerts.length) {
    return { ...summary, limitReached: 'max_alerts', remaining: pendingAlerts.length - alerts.length };
  }
  return summary;
}

function digestRunRow({
  workflowRunKey,
  workflowDate,
  user,
  candidates,
  deliveredCandidates,
  overflowCount,
  sentAlertIds,
  limits,
  ai2,
  projected,
} = {}) {
  const ai2Called = Boolean(ai2) && ai2.called !== false;
  return {
    workflow_run_key: workflowRunKey,
    workflow_date: workflowDate,
    user_id: user.id,
    profile_snapshot: user,
    candidate_alert_ids: candidates.map((candidate) => candidate.alert_id),
    candidate_cards: deliveredCandidates,
    limits_snapshot: limits,
    candidate_overflow_count: overflowCount,
    already_sent_alert_ids: sentAlertIds,
    model: ai2 ? AI2_MODEL : null,
    engine_version: VERSIONS.engine,
    contract_version: VERSIONS.ai2Contract,
    prompt_version: VERSIONS.ai2Prompt,
    prompt_text: ai2?.prompt || null,
    raw_response: ai2?.rawResponse || null,
    normalized_response: ai2?.normalizedResponse || null,
    usage_json: {
      ...(ai2?.usage || {}),
      calls: ai2Called ? 1 : 0,
      prompt_chars: ai2?.prompt?.length || 0,
      candidate_count: deliveredCandidates.length,
      candidate_cards_chars: JSON.stringify(deliveredCandidates).length,
    },
    duration_ms: ai2?.durationMs || 0,
    digest_preview: projected?.message || '',
    status: ai2?.status || 'NO_CANDIDATES',
    error_code: ai2?.error?.code || null,
    error_message: ai2?.error?.message || null,
  };
}

async function runAi2Phase({
  supabase,
  workflowRunKey,
  workflowDate,
  limits,
  budget,
  callAi2,
  repo,
  logger,
} = {}) {
  const classifications = await repo.loadSuccessfulClassifications(supabase, workflowRunKey);
  const existingUserIds = await repo.loadExistingDigestUserIds(supabase, workflowRunKey, workflowDate);
  const allUsers = await repo.loadUsers(supabase);
  const pendingUsers = allUsers.filter((user) => !existingUserIds.has(Number(user.id)));
  const users = pendingUsers.slice(0, limits.maxUsers);
  const sentByUser = await repo.loadSentHistory(supabase, users.map((user) => user.id));
  const summary = {
    found: allUsers.length,
    pendingAtStart: pendingUsers.length,
    processed: 0,
    resumed: existingUserIds.size,
    generated: 0,
    empty: 0,
    noCandidates: 0,
    errors: 0,
  };

  for (const [index, user] of users.entries()) {
    const sentAlertIds = [...(sentByUser.get(Number(user.id)) || new Set())];
    const candidates = classifications.filter((classification) => (
      !hasExpiredDeadline(classification, workflowDate)
      && matchClassificationToProfile({ classification, user, sentAlertIds }).candidate
    ));
    const ordered = orderCandidates(candidates, new Date(`${workflowDate}T12:00:00Z`));
    const deliveredCandidates = ordered.slice(0, limits.maxCandidatesPerUser);
    const overflowCount = Math.max(0, ordered.length - deliveredCandidates.length);
    let ai2 = null;
    let projected = { message: '', items: [] };

    if (deliveredCandidates.length > 0) {
      const personalPrompt = buildAi2Prompt({
        user, candidates: deliveredCandidates, sentAlertIds, maxSelected: limits.maxSelected,
      });
      if (personalPrompt.length > limits.maxPersonalPromptChars) {
        ai2 = {
          status: 'ERROR',
          called: false,
          model: AI2_MODEL,
          prompt: personalPrompt,
          rawResponse: null,
          normalizedResponse: null,
          usage: null,
          durationMs: 0,
          error: {
            code: 'personal_prompt_too_large',
            message: `Prompt IA 2: ${personalPrompt.length} caracteres`,
          },
        };
      } else {
        if (!budget.claim()) {
          return { ...summary, limitReached: 'max_total_calls', stoppedBeforeUserId: user.id };
        }
        ai2 = await callAi2({
          user,
          candidates: deliveredCandidates,
          sentAlertIds,
          maxSelected: limits.maxSelected,
          maxPromptChars: limits.maxPersonalPromptChars,
        });
      }
      if (ai2.status === 'GENERATED' || ai2.status === 'EMPTY') {
        projected = projectDigest(ai2.normalizedResponse);
      }
    }

    const runRow = digestRunRow({
      workflowRunKey,
      workflowDate,
      user,
      candidates: ordered,
      deliveredCandidates,
      overflowCount,
      sentAlertIds,
      limits,
      ai2,
      projected,
    });
    const cardById = new Map(deliveredCandidates.map((candidate) => [Number(candidate.alert_id), candidate.card]));
    const itemRows = projected.items.map((item) => ({
      workflow_run_key: workflowRunKey,
      workflow_date: workflowDate,
      user_id: user.id,
      alert_id: item.alert_id,
      final_position: item.position,
      classification_snapshot: cardById.get(Number(item.alert_id)) || {},
      personal_reason: item.reason,
      title_used: item.title,
      summary_used: item.summary,
      action_used: item.action,
      deadline_used: item.deadline,
      rendered_block: item.rendered_block,
    }));
    await repo.insertDigestRun(supabase, runRow, itemRows);
    summary.processed += 1;
    if (!ai2) summary.noCandidates += 1;
    else if (ai2.status === 'GENERATED') summary.generated += 1;
    else if (ai2.status === 'EMPTY') summary.empty += 1;
    else summary.errors += 1;
    logger.info(`[shadow-v2] IA 2 ${index + 1}/${users.length}: usuario ${user.id} -> ${runRow.status}`);
  }
  if (pendingUsers.length > users.length) {
    return { ...summary, limitReached: 'max_users', remaining: pendingUsers.length - users.length };
  }
  return summary;
}

async function runShadowV2Workflow({
  supabase,
  workflowRunKey = crypto.randomUUID(),
  workflowDate,
  limitOverrides = {},
  callAi1 = classifyAlertWithAi1,
  callAi2 = decideDigestWithAi2,
  repo = repository,
  logger = console,
} = {}) {
  assertRunKey(workflowRunKey);
  assertWorkflowDate(workflowDate);
  const limits = normalizeLimits(limitOverrides);
  const budget = createCallBudget(limits.maxTotalCalls);
  logger.info(`[shadow-v2] run=${workflowRunKey} fecha=${workflowDate} fase=IA1`);
  const ai1 = await runAi1Phase({
    supabase, workflowRunKey, workflowDate, limits, budget, callAi1, repo, logger,
  });
  if (ai1.limitReached) {
    await repo.recordLimitEvent?.(supabase, {
      workflowRunKey,
      phase: 'ai1',
      reason: ai1.limitReached,
      details: ai1,
    });
    return { workflowRunKey, workflowDate, limits, calls: budget.used, stopped: ai1.limitReached, ai1, ai2: null };
  }
  logger.info(`[shadow-v2] run=${workflowRunKey} fecha=${workflowDate} fase=IA2`);
  const ai2 = await runAi2Phase({
    supabase, workflowRunKey, workflowDate, limits, budget, callAi2, repo, logger,
  });
  if (ai2.limitReached) {
    await repo.recordLimitEvent?.(supabase, {
      workflowRunKey,
      phase: 'ai2',
      reason: ai2.limitReached,
      details: ai2,
    });
  }
  return {
    workflowRunKey,
    workflowDate,
    limits,
    calls: budget.used,
    stopped: ai2.limitReached || null,
    ai1,
    ai2,
  };
}

module.exports = {
  assertRunKey,
  assertWorkflowDate,
  hasExpiredDeadline,
  createCallBudget,
  classificationRow,
  digestRunRow,
  runAi1Phase,
  runAi2Phase,
  runShadowV2Workflow,
};
