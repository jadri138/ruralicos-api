const DAY_MS = 24 * 60 * 60 * 1000;
const DELIVERED_STATUSES = new Set(['DELIVERED', 'READ']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function dateOnly(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function calendarDays(from, to) {
  const first = new Date(`${from}T00:00:00.000Z`);
  const last = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()) || first > last) return [];
  const days = [];
  for (let value = first.getTime(); value <= last.getTime(); value += DAY_MS) {
    days.push(new Date(value).toISOString().slice(0, 10));
  }
  return days;
}

function memorySummary(memory = {}) {
  return {
    id: memory.id || null,
    source: memory.source || memory.fuente || null,
    polarity: memory.polarity || memory.polaridad || null,
    scope: memory.scope_type || memory.scope || memory.ambito || null,
    key: memory.scope_value || memory.key || memory.topic || null,
    strength: Number.isFinite(Number(memory.strength)) ? Number(memory.strength) : null,
    recorded_at: memory.recorded_at || memory.created_at || null,
  };
}

function normalizeIdentityPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function memorySourceFamily(memory = {}) {
  const source = normalizeIdentityPart(memory.source || memory.fuente || memory.tipo);
  if (/feedback|response|reply|respuesta/.test(source)) return 'feedback';
  if (/click|clic/.test(source)) return 'click';
  if (/strong_action|guardar|solicitar/.test(source)) return 'strong_action';
  return source || 'unknown';
}

function memoryIdentity(memory = {}) {
  return [
    normalizeIdentityPart(memory.scope_type || memory.scope || memory.ambito || 'topic'),
    normalizeIdentityPart(memory.scope_value || memory.key || memory.topic || memory.content),
    normalizeIdentityPart(memory.polarity || memory.polaridad || 'neutral'),
    memorySourceFamily(memory),
  ].join(':');
}

function memoryPredatesDay(memory = {}, date) {
  const recorded = memory.recorded_at || memory.created_at;
  if (!recorded) return false;
  const timestamp = new Date(recorded).getTime();
  const start = new Date(`${date}T00:00:00.000Z`).getTime();
  return Number.isFinite(timestamp) && timestamp < start;
}

function exposureIdentity(exposure = {}) {
  return [
    String(exposure.alert_id ?? exposure.alerta_id ?? exposure.id ?? ''),
    String(exposure.material_version || exposure.content_hash || 'initial'),
  ].join(':');
}

function uniqueBy(values, identity) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = identity(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function refreshMemories(state) {
  state.memories = uniqueBy([
    ...(state.snapshot_memories || []),
    ...(state.replay_memories || []),
  ], memoryIdentity);
}

function refreshExposures(state) {
  state.exposures = uniqueBy([
    ...(state.snapshot_exposures || []),
    ...(state.replay_exposures || []),
  ], exposureIdentity);
}

function refreshTemporalContext(state) {
  state.recent_communications = uniqueBy([
    ...(state.snapshot_communications || []),
    ...(state.replay_communications || []),
  ], (item) => String(item.id || `${item.delivered_at || item.read_at}:${item.status}`));
  state.recent_deliveries = uniqueBy([
    ...(state.snapshot_deliveries || []),
    ...(state.replay_deliveries || []),
  ], exposureIdentity);
  state.used_idempotency_keys = [...new Set([
    ...(state.snapshot_idempotency_keys || []),
    ...(state.replay_idempotency_keys || []),
  ].filter(Boolean))];
}

function profileState(profile = {}) {
  const state = {
    id: profile.id,
    kind: profile.kind || null,
    user: clone(profile.user || {}),
    snapshot_memories: clone(profile.memories || []),
    replay_memories: [],
    snapshot_exposures: clone(profile.exposures || []),
    replay_exposures: [],
    snapshot_communications: clone(profile.recent_communications || []),
    replay_communications: [],
    snapshot_deliveries: clone(profile.recent_deliveries || profile.exposures || []),
    replay_deliveries: [],
    snapshot_idempotency_keys: clone(profile.used_idempotency_keys || []),
    replay_idempotency_keys: [],
    snapshot_date: null,
  };
  refreshMemories(state);
  refreshExposures(state);
  refreshTemporalContext(state);
  return state;
}

function applyProfileSnapshot(state, snapshot = {}) {
  if (snapshot.user) state.user = clone(snapshot.user);
  if (Array.isArray(snapshot.memories)) {
    state.snapshot_memories = snapshot.memories
      .filter((memory) => memoryPredatesDay(memory, snapshot.date))
      .map(clone);
    const snapshotKeys = new Set(state.snapshot_memories.map(memoryIdentity));
    state.replay_memories = state.replay_memories
      .filter((memory) => !snapshotKeys.has(memoryIdentity(memory)));
    refreshMemories(state);
  }
  if (Array.isArray(snapshot.exposures)) {
    state.snapshot_exposures = clone(snapshot.exposures);
    const snapshotKeys = new Set(state.snapshot_exposures.map(exposureIdentity));
    state.replay_exposures = state.replay_exposures
      .filter((exposure) => !snapshotKeys.has(exposureIdentity(exposure)));
    refreshExposures(state);
  }
  if (Array.isArray(snapshot.recent_communications)) {
    state.snapshot_communications = clone(snapshot.recent_communications);
  }
  if (Array.isArray(snapshot.recent_deliveries)) {
    state.snapshot_deliveries = clone(snapshot.recent_deliveries);
  }
  if (Array.isArray(snapshot.used_idempotency_keys)) {
    state.snapshot_idempotency_keys = clone(snapshot.used_idempotency_keys);
  }
  refreshTemporalContext(state);
  if (snapshot.kind) state.kind = snapshot.kind;
  state.snapshot_date = snapshot.date;
}

function replayMemory(effect = {}, replayCase = {}) {
  const scope = effect.scope || 'alert';
  const key = effect.key || (scope === 'alert'
    ? String(replayCase.alert?.id || replayCase.id)
    : String(replayCase.alert?.topic || replayCase.alert?.type || replayCase.id));
  return {
    id: effect.id || `replay-memory:${replayCase.id}:${effect.source}:${scope}:${key}`,
    content: key,
    key,
    scope_type: scope,
    scope_value: key,
    polarity: effect.polarity || 'neutral',
    source: effect.source || 'replay_observation',
    strength: Number.isFinite(Number(effect.strength)) ? Number(effect.strength) : 0.5,
    confidence: Number.isFinite(Number(effect.confidence)) ? Number(effect.confidence) : 0.7,
    status: 'active',
    recorded_at: effect.recorded_at || `${replayCase.date}T23:59:59.000Z`,
    alert_id: replayCase.alert?.id || null,
  };
}

function signalDates(replayCase = {}) {
  const observed = replayCase.observed || {};
  return [
    observed.feedback?.recorded_at,
    observed.clicked_at,
    observed.strong_action_at,
    observed.strong_action?.recorded_at,
  ].map(dateOnly).filter(Boolean);
}

function addMemoryOnce(state, memory) {
  const identity = memoryIdentity(memory);
  if (state.memories.some((item) => memoryIdentity(item) === identity)) return false;
  state.replay_memories.push(memory);
  refreshMemories(state);
  return true;
}

function applyDeliveredResults(state, replayCases, results, date) {
  const byId = new Map(replayCases.map((replayCase) => [replayCase.id, replayCase]));
  const applied = [];
  const terminal = [];
  for (const result of results) {
    if (!DELIVERED_STATUSES.has(String(result.delivery?.status || '').toUpperCase())) continue;
    const replayCase = byId.get(result.case_id);
    if (!replayCase) continue;
    const status = String(result.delivery.status).toUpperCase();
    const deliveredAt = replayCase.observed?.delivered_at || `${date}T18:00:00.000Z`;
    const readAt = status === 'READ'
      ? replayCase.observed?.read_at || `${date}T20:00:00.000Z`
      : null;
    const exposure = {
      id: `replay-exposure:${result.case_id}:${date}`,
      alert_id: replayCase.alert?.id,
      topic: replayCase.alert?.topic || replayCase.alert?.type || null,
      material_version: replayCase.alert?.content_hash || `replay-content:${replayCase.alert?.id}`,
      shown_at: deliveredAt,
      sent_at: deliveredAt,
      delivered_at: deliveredAt,
      read_at: readAt,
      status,
    };
    const identity = exposureIdentity(exposure);
    if (!state.exposures.some((item) => exposureIdentity(item) === identity)) {
      state.replay_exposures.push(exposure);
      refreshExposures(state);
    }
    if (!state.recent_deliveries.some((item) => exposureIdentity(item) === identity)) {
      state.replay_deliveries.push(exposure);
    }
    if (result.proposed?.idempotency_key
      && !state.used_idempotency_keys.includes(result.proposed.idempotency_key)) {
      state.replay_idempotency_keys.push(result.proposed.idempotency_key);
    }
    terminal.push({ result, exposure });
    applied.push({
      case_id: result.case_id,
      alert_id: replayCase.alert?.id || null,
      status,
    });
  }
  if (terminal.length > 0) {
    const read = terminal.some(({ result }) => result.delivery.status === 'READ');
    const communication = {
      id: `replay-communication:${state.id}:${date}`,
      status: read ? 'READ' : 'DELIVERED',
      delivered_at: `${date}T18:00:00.000Z`,
      read_at: read ? `${date}T20:00:00.000Z` : null,
      alert_ids: terminal.map(({ exposure }) => exposure.alert_id),
    };
    if (!state.recent_communications.some((item) => item.id === communication.id)) {
      state.replay_communications.push(communication);
    }
  }
  refreshTemporalContext(state);
  return applied;
}

async function runDailyHistoricalSequence(corpus, {
  evaluateCase,
  evaluateBatch,
  evaluationOptions = {},
} = {}) {
  if (typeof evaluateBatch !== 'function' && typeof evaluateCase !== 'function') {
    throw new TypeError('evaluateBatch o evaluateCase es obligatorio');
  }
  const indexedCases = (corpus.cases || []).map((replayCase, index) => ({ replayCase, index }));
  const allDates = [
    ...indexedCases.map(({ replayCase }) => replayCase.date),
    ...(corpus.profile_snapshots || []).map((snapshot) => snapshot.date),
    ...indexedCases.flatMap(({ replayCase }) => signalDates(replayCase)),
  ].filter(Boolean).sort();
  const dates = calendarDays(allDates[0], allDates[allDates.length - 1]);
  const states = new Map((corpus.profiles || []).map((profile) => [profile.id, profileState(profile)]));
  const snapshotsByDate = new Map();
  for (const snapshot of corpus.profile_snapshots || []) {
    if (!snapshotsByDate.has(snapshot.date)) snapshotsByDate.set(snapshot.date, []);
    snapshotsByDate.get(snapshot.date).push(snapshot);
  }
  const casesByDate = new Map();
  for (const indexed of indexedCases) {
    if (!casesByDate.has(indexed.replayCase.date)) casesByDate.set(indexed.replayCase.date, []);
    casesByDate.get(indexed.replayCase.date).push(indexed);
  }

  const pendingEffects = new Map();
  const orderedResults = new Array(indexedCases.length);
  const timeline = [];
  for (const date of dates) {
    const appliedSnapshots = [];
    for (const snapshot of snapshotsByDate.get(date) || []) {
      const state = states.get(snapshot.profile_id);
      if (!state) continue;
      applyProfileSnapshot(state, snapshot);
      appliedSnapshots.push(snapshot.profile_id);
    }

    const groups = new Map();
    for (const indexed of casesByDate.get(date) || []) {
      if (!groups.has(indexed.replayCase.profile_id)) groups.set(indexed.replayCase.profile_id, []);
      groups.get(indexed.replayCase.profile_id).push(indexed);
    }
    const dayResults = [];
    const batches = [];
    const appliedDeliveries = [];
    for (const [profileId, indexedGroup] of groups) {
      const state = states.get(profileId);
      if (!state) continue;
      const replayCases = indexedGroup.map(({ replayCase }) => replayCase);
      const memoryBefore = state.memories.map(memorySummary);
      const exposureBefore = state.exposures.map((exposure) => ({
        alert_id: exposure.alert_id ?? exposure.alerta_id ?? null,
        status: exposure.status || null,
        delivered_at: exposure.delivered_at || null,
      }));
      const groupResults = typeof evaluateBatch === 'function'
        ? await evaluateBatch(replayCases, clone(state), evaluationOptions)
        : await Promise.all(replayCases.map((replayCase) => (
          evaluateCase(replayCase, clone(state), evaluationOptions)
        )));
      if (!Array.isArray(groupResults) || groupResults.length !== replayCases.length) {
        throw new Error(`El batch de replay ${profileId}:${date} devolvio un numero invalido de casos`);
      }
      batches.push({ profile_id: profileId, cases: replayCases.map((item) => item.id) });
      for (let position = 0; position < groupResults.length; position += 1) {
        const result = groupResults[position];
        const { replayCase, index } = indexedGroup[position];
        result.history = {
          profile_snapshot_date: state.snapshot_date,
          memory_before_count: memoryBefore.length,
          memory_before: clone(memoryBefore),
          exposure_before_count: exposureBefore.length,
          exposures_before: clone(exposureBefore),
          communication_before_count: state.recent_communications.length,
        };
        orderedResults[index] = result;
        dayResults.push(result.case_id);

        for (const effect of result.memory_effects || []) {
          const dueDate = dateOnly(effect.recorded_at) || date;
          const applyDate = dueDate < date ? date : dueDate;
          if (!pendingEffects.has(applyDate)) pendingEffects.set(applyDate, []);
          pendingEffects.get(applyDate).push({
            profile_id: replayCase.profile_id,
            case_id: replayCase.id,
            memory: replayMemory(effect, replayCase),
          });
        }
      }
      appliedDeliveries.push(...applyDeliveredResults(state, replayCases, groupResults, date)
        .map((delivery) => ({ profile_id: profileId, ...delivery })));
    }

    const appliedEffects = [];
    for (const pending of pendingEffects.get(date) || []) {
      const state = states.get(pending.profile_id);
      if (!state || !addMemoryOnce(state, pending.memory)) continue;
      appliedEffects.push({
        profile_id: pending.profile_id,
        case_id: pending.case_id,
        memory: memorySummary(pending.memory),
      });
    }
    timeline.push({
      date,
      profile_snapshots_applied: appliedSnapshots,
      batches,
      cases: dayResults,
      deliveries_applied: appliedDeliveries,
      memory_effects_applied: appliedEffects,
    });
  }

  const results = orderedResults.filter(Boolean);
  return {
    results,
    timeline,
    final_profiles: [...states.values()].map((state) => ({
      profile_id: state.id,
      memory_count: state.memories.length,
      memories: state.memories.map(memorySummary),
      exposure_count: state.exposures.length,
      communication_count: state.recent_communications.length,
    })),
    period: {
      from: dates[0] || null,
      to: dates[dates.length - 1] || null,
      distinct_days: dates.length,
      span_days: dates.length,
    },
  };
}

module.exports = {
  applyDeliveredResults,
  applyProfileSnapshot,
  calendarDays,
  dateOnly,
  memoryIdentity,
  memoryPredatesDay,
  memorySummary,
  replayMemory,
  runDailyHistoricalSequence,
};
