const {
  CONTRACT_VERSIONS,
  DECISION_STATES,
  adaptAlertTruthCard,
  buildDecisionProfile,
  createDailyJudgeBudget,
  createOpenAIJudgeCaller,
  decideCandidateBatch,
} = require('../alertas/decision');
const { llamarIA } = require('../../platform/ia/llamarIA');
const { getFechaMadridISO, getRangoDiaMadridUTC } = require('../../shared/fechaMadrid');
const { cargarCacheDecisionesJuez } = require('../mia/digestCandidateDecisions');
const { retryMetadataFromCandidate } = require('./decisionHoldRetry');

const DEFAULT_TOP_K = 10;

function parseJudgePricing(value = process.env.ALERT_DECISION_JUDGE_PRICING_JSON) {
  if (!value) return null;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function configuredDailyCallLimit(value = process.env.ALERT_DECISION_LLM_DAILY_CALL_LIMIT) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.max(1, Math.min(100000, Math.floor(number)));
}

async function cargarUsoDiarioJuez(supabase, fecha) {
  if (!supabase?.from) throw new Error('supabase_no_disponible');
  const { inicio, fin } = getRangoDiaMadridUTC(fecha);
  const [runsResult, decisionsResult] = await Promise.all([
    supabase
      .from('ia_runs')
      .select('id', { count: 'exact', head: true })
      .in('task', ['alert_personal_relevance_judge', 'alert_personal_relevance_second_opinion'])
      .gte('created_at', inicio)
      .lt('created_at', fin),
    supabase
      .from('digest_candidate_decisions')
      .select('llm_calls')
      .eq('stage', 'personal_relevance_judge')
      .gte('created_at', inicio)
      .lt('created_at', fin),
  ]);
  if (runsResult.error) throw runsResult.error;
  if (decisionsResult.error) throw decisionsResult.error;
  const auditedRuns = Math.max(0, Number(runsResult.count) || 0);
  const persistedCalls = (decisionsResult.data || []).reduce(
    (total, row) => total + Math.max(0, Number(row?.llm_calls) || 0),
    0
  );
  // Ambas fuentes describen las mismas llamadas. Se usa la mayor para cubrir
  // tanto la escritura asíncrona de ia_runs como una decisión aún no enlazada,
  // sin contar dos veces el mismo consumo.
  return Math.max(auditedRuns, persistedCalls);
}

function crearPresupuestoJuezAtomico({ supabase, fecha, limit, usedCalls }) {
  const local = createDailyJudgeBudget({
    maxCalls: limit,
    usedCalls,
    source: 'atomic_rpc',
  });
  let unavailable = false;
  let remoteUsedCalls = usedCalls;
  let remoteRemainingCalls = Math.max(0, limit - usedCalls);

  return {
    async tryConsumeCall() {
      if (typeof supabase?.rpc !== 'function') {
        unavailable = true;
        return false;
      }
      try {
        const { data, error } = await supabase.rpc('reserve_alert_decision_llm_call', {
          p_fecha: fecha,
          p_limit: limit,
          p_observed_calls: usedCalls,
        });
        if (error) throw error;
        const reservation = Array.isArray(data) ? data[0] : data;
        if (!reservation || typeof reservation.allowed !== 'boolean') {
          throw new Error('invalid_budget_reservation');
        }
        remoteUsedCalls = Math.max(remoteUsedCalls, Number(reservation.used_calls) || 0);
        remoteRemainingCalls = Math.max(0, Number(reservation.remaining_calls) || 0);
        if (!reservation.allowed) return false;
        return local.tryConsumeCall();
      } catch {
        // Un fallo de la reserva nunca abre una llamada sin contabilizar.
        unavailable = true;
        return false;
      }
    },
    recordCallAudit(callAudit) {
      local.recordCallAudit(callAudit);
    },
    recordCacheHit() {
      local.recordCacheHit();
    },
    snapshot() {
      const snapshot = local.snapshot();
      return {
        ...snapshot,
        source: 'atomic_rpc',
        unavailable,
        used_calls: Math.max(snapshot.used_calls, remoteUsedCalls),
        remaining_calls: remoteRemainingCalls,
      };
    },
  };
}

async function crearPresupuestoJuezDiario({
  supabase,
  fecha = getFechaMadridISO(),
  maxCalls,
} = {}) {
  const limit = configuredDailyCallLimit(maxCalls);
  if (limit === null) {
    return createDailyJudgeBudget({ source: 'unlimited' });
  }
  try {
    const usedCalls = await cargarUsoDiarioJuez(supabase, fecha);
    return crearPresupuestoJuezAtomico({ supabase, fecha, limit, usedCalls });
  } catch {
    // Si no se puede comprobar el gasto, no se abren llamadas fuera de control.
    return createDailyJudgeBudget({
      maxCalls: limit,
      usedCalls: limit,
      source: 'usage_unavailable',
      unavailable: true,
    });
  }
}

function alertId(alerta = {}) {
  return alerta.id ?? alerta.alerta_id ?? null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function candidateEnvelope(alerta, options = {}) {
  const holdRetry = alerta?._hold_retry || null;
  return {
    ...alerta,
    alert_id: alertId(alerta),
    alert: alerta,
    fact_sheet: alerta.fact_sheet || null,
    generator_score: options.score ?? alerta.decision_digest?.score ?? 0,
    generator_reason: options.reason || alerta.decision_digest?.motivo || null,
    reason_codes: options.reasonCodes || [],
    metadata: {
      high_impact: Boolean(
        alerta.decision_digest?.diagnostico?.policy?.signals?.es_urgente
        || alerta.calidad_mia?.critical
      ),
      ...(options.isExploration ? { exploration: true } : {}),
      ...(holdRetry ? {
        hold_retry_source_id: holdRetry.source_id,
        hold_retry_attempt: holdRetry.attempt,
        hold_retry_final: holdRetry.final === true,
        generator_trace: ['hold_retry'],
      } : {}),
    },
  };
}

function construirFuentesCandidatas(alertas = [], { exploracion = null } = {}) {
  const list = (Array.isArray(alertas) ? alertas : []).filter((alerta) => alertId(alerta));
  const explorationId = alertId(exploracion || {});
  const exact = list.map((alerta) => candidateEnvelope(alerta, {
    score: finiteNumber(alerta.decision_digest?.score) ?? 0,
    reason: 'supera coincidencias deterministas existentes',
  }));
  const semantic = list
    .filter((alerta) => finiteNumber(alerta.similitud) !== null)
    .map((alerta) => candidateEnvelope(alerta, {
      score: finiteNumber(alerta.similitud),
      reason: 'recuperada por similitud semantica',
    }));
  const memory = list
    .filter((alerta) => (
      finiteNumber(alerta.mia_profile_score) !== null
      || (alerta.mia_profile_reasons || []).length > 0
    ))
    .map((alerta) => candidateEnvelope(alerta, {
      score: finiteNumber(alerta.mia_profile_score) ?? 0,
      reason: 'recuperada por memoria estructurada',
    }));
  const coverage = list.filter((alerta) => {
    const card = adaptAlertTruthCard(alerta.fact_sheet || alerta, { legacyAlert: alerta });
    return card.status === 'READY'
      && Number(card.quality?.truth || 0) >= 0.75
      && (card.territory?.national || (card.territory?.regions || []).length > 0);
  }).map((alerta) => candidateEnvelope(alerta, {
    score: finiteNumber(alerta.truth_score ?? alerta.fact_sheet?.truth_score) ?? 0,
    reason: 'cobertura territorial amplia y verificada',
  }));
  const exploration = explorationId == null
    ? []
    : list
      .filter((alerta) => String(alertId(alerta)) === String(explorationId))
      .map((alerta) => candidateEnvelope(alerta, {
        score: finiteNumber(alerta.similitud) ?? 0,
        reason: 'exploracion segura unica',
        isExploration: true,
      }));

  return { exact, semantic, memory, coverage, exploration };
}

function normalizarEstadoEntrega(value) {
  return String(value || '').trim().toUpperCase();
}

function consumeIdempotenciaEntrega(digest = {}) {
  if (digest.enviado === true) return true;
  return [
    'QUEUED',
    'PROVIDER_ACCEPTED',
    'SENT_TO_WHATSAPP',
    'DELIVERED',
    'READ',
  ].includes(normalizarEstadoEntrega(digest.delivery_status));
}

async function cargarContextoDecisionUsuario(supabase, userId, { limit = 60 } = {}) {
  const { data: digests, error: digestError } = await supabase
    .from('digests')
    .select('id, enviado, delivery_status, idempotency_key, message_version, accepted_at, sent_to_whatsapp_at, delivered_at, read_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.max(10, Math.min(200, Number(limit) || 60)));
  if (digestError) throw digestError;

  const digestRows = digests || [];
  const digestIds = digestRows.map((digest) => digest.id).filter(Boolean);
  let items = [];
  if (digestIds.length > 0) {
    const { data, error } = await supabase
      .from('digest_items')
      .select('digest_id, alerta_id, selection_decision, tags_json')
      .in('digest_id', digestIds);
    if (error) throw error;
    items = data || [];
  }

  const digestById = new Map(digestRows.map((digest) => [String(digest.id), digest]));
  const recentCommunications = digestRows.map((digest) => ({
    status: normalizarEstadoEntrega(digest.delivery_status),
    delivered_at: digest.delivered_at,
    read_at: digest.read_at,
    sent_at: digest.sent_to_whatsapp_at || digest.accepted_at,
  }));
  const recentDeliveries = items.map((item) => {
    const digest = digestById.get(String(item.digest_id)) || {};
    const normalizedStatus = normalizarEstadoEntrega(digest.delivery_status);
    const delivered = ['DELIVERED', 'READ'].includes(normalizedStatus) || Boolean(digest.delivered_at);
    const canonical = item.selection_decision?.canonical
      || item.tags_json?.personal_decision
      || {};
    return {
      alert_id: item.alerta_id,
      status: normalizedStatus,
      delivered_at: digest.delivered_at,
      read_at: digest.read_at,
      // Antes del contrato de ACK, `enviado=true` solo prueba que el transporte
      // se intentó. Se usa para evitar duplicados históricos, nunca para inflar
      // métricas de entrega o aprender desinterés.
      legacy_consumed: digest.enviado === true && !delivered,
      material_version: canonical.material_version || null,
      idempotency_key: canonical.idempotency_key || null,
    };
  }).filter((item) => (
    item.delivered_at
    || item.legacy_consumed
    || ['DELIVERED', 'READ'].includes(item.status)
  ));
  const usedIdempotencyKeys = [
    ...digestRows
      .filter(consumeIdempotenciaEntrega)
      .map((digest) => digest.idempotency_key),
    ...items.filter((item) => (
      consumeIdempotenciaEntrega(digestById.get(String(item.digest_id)) || {})
    )).map((item) => (
      item.selection_decision?.canonical?.idempotency_key
        || item.tags_json?.personal_decision?.idempotency_key
    )),
  ].filter(Boolean);

  return {
    recentCommunications,
    recentDeliveries,
    usedIdempotencyKeys: [...new Set(usedIdempotencyKeys)],
  };
}

function crearCallersJuez(options = {}) {
  if (typeof options.caller === 'function') {
    return {
      caller: options.caller,
      secondOpinionCaller: options.secondOpinionCaller,
    };
  }
  if (typeof createOpenAIJudgeCaller !== 'function') {
    return { caller: undefined, secondOpinionCaller: undefined };
  }
  const model = process.env.ALERT_DECISION_JUDGE_MODEL || 'gpt-5-nano';
  const secondModel = process.env.ALERT_DECISION_SECOND_OPINION_MODEL || model;
  const pricing = parseJudgePricing();
  return {
    caller: createOpenAIJudgeCaller({
      callIA: llamarIA,
      model,
      task: 'alert_personal_relevance_judge',
      pricing,
    }),
    secondOpinionCaller: createOpenAIJudgeCaller({
      callIA: llamarIA,
      model: secondModel,
      task: 'alert_personal_relevance_second_opinion',
      pricing,
    }),
  };
}

function decisionesAuditoria(result = {}) {
  const rows = [];
  const portfolioSelected = new Map((result.portfolio?.items || []).map((item) => [
    String(item.candidate?.alert_id),
    item,
  ]));
  const portfolioRejected = new Map((result.portfolio?.rejected || []).map((item) => [
    String(item.candidate?.alert_id),
    item,
  ]));
  const pushRanked = (candidate, state, reasonCodes) => rows.push({
    id: candidate.alert_id,
    decision: state,
    action: state === DECISION_STATES.BLOCKED
      ? 'blocked'
      : state === DECISION_STATES.HOLD_FOR_EVIDENCE
        ? 'hold'
        : 'exclude',
    motivo: (reasonCodes || [])[0] || 'decision_sin_motivo',
    reason_codes: reasonCodes || [],
    contract_version: CONTRACT_VERSIONS.decision,
    policy_version: result.policy_version,
    score: candidate.pre_score ?? 0,
    origins: candidate.origins || [],
    ...retryMetadataFromCandidate(candidate),
  });

  for (const candidate of result.ranking?.blocked || []) {
    pushRanked(candidate, DECISION_STATES.BLOCKED, candidate.eligibility?.reason_codes);
  }
  for (const candidate of result.ranking?.holds || []) {
    pushRanked(candidate, DECISION_STATES.HOLD_FOR_EVIDENCE, candidate.eligibility?.reason_codes);
  }
  for (const candidate of result.ranking?.dropped || []) {
    pushRanked(candidate, DECISION_STATES.DROP, candidate.eligibility?.reason_codes);
  }
  for (const item of result.evaluated || []) {
    const audit = item.judged?.audit || {};
    const selected = portfolioSelected.get(String(item.candidate.alert_id));
    const rejected = portfolioRejected.get(String(item.candidate.alert_id));
    const finalState = selected?.state || rejected?.state || item.authorized.state;
    const finalReasons = selected?.reason_codes
      || rejected?.reason_codes
      || item.authorized.reason_codes
      || [];
    const included = Boolean(selected);
    rows.push({
      id: item.candidate.alert_id,
      decision: finalState,
      action: included ? 'include'
        : finalState === DECISION_STATES.BLOCKED ? 'blocked'
          : finalState === DECISION_STATES.HOLD_FOR_EVIDENCE ? 'hold' : 'exclude',
      motivo: finalReasons[0] || 'decision_sin_motivo',
      reason_codes: finalReasons,
      contract_version: item.judged.decision?.contract_version || CONTRACT_VERSIONS.decision,
      policy_version: item.judged.decision?.policy_version || result.policy_version,
      judge_version: audit.judge_version || null,
      prompt_version: audit.prompt_version || null,
      input_hash: audit.input_hash || null,
      llm_model: audit.model || audit.cached_from?.model || null,
      llm_usage: audit.usage || null,
      llm_cost: audit.cost || null,
      llm_calls: Number(audit.llm_calls || 0),
      cache_hit: audit.cache_hit === true,
      fallback_reason: audit.fallback || null,
      score: item.candidate.pre_score,
      judge: item.judged.decision,
      judge_audit: audit,
      authority: {
        approved: included,
        state: finalState,
        reason_codes: finalReasons,
        idempotency_key: selected?.idempotency_key || item.authorized.idempotency_key,
      },
      origins: item.candidate.origins,
      decided_at: new Date().toISOString(),
      ...retryMetadataFromCandidate(item.candidate),
    });
  }
  return rows;
}

function aplicarPortfolioAAlertas(alertas = [], result = {}) {
  const byId = new Map((alertas || []).map((alerta) => [String(alertId(alerta)), alerta]));
  return (result.portfolio?.items || []).map((item) => {
    const alerta = byId.get(String(item.candidate.alert_id));
    if (!alerta) return null;
    const canonical = {
      contract_version: result.contract_version,
      policy_version: result.policy_version,
      state: item.state,
      reason_codes: item.reason_codes,
      idempotency_key: item.idempotency_key,
      material_version: item.candidate.truth_card?.identity?.content_hash
        || item.candidate.truth_card?.builder_version
        || item.candidate.truth_card?.source_schema_version,
      candidate_origins: item.candidate.origins,
      pre_score: item.candidate.pre_score,
      judge: item.decision,
      message_projection: item.message_projection,
    };
    return {
      ...alerta,
      decision_digest: {
        ...(alerta.decision_digest || {}),
        action: 'include',
        incluir: true,
        motivo: canonical.reason_codes[0] || 'approved_by_final_authority',
        score: canonical.pre_score,
        canonical,
      },
      personal_decision: canonical,
      motivo_seleccion_mia: `decision_authority:${item.state}`,
    };
  }).filter(Boolean);
}

async function decidirAlertasDigest({
  supabase,
  alertas = [],
  user,
  perfilOperativo = {},
  exploracion = null,
  fecha,
  context: suppliedContext,
  caller,
  secondOpinionCaller,
  budget,
  policy = {},
} = {}) {
  const deliveryContext = suppliedContext || await cargarContextoDecisionUsuario(supabase, user.id);
  const decisionNow = suppliedContext?.now ? new Date(suppliedContext.now) : new Date();
  const judgeNow = suppliedContext?.judgeNow
    || (fecha ? `${fecha}T12:00:00.000Z` : decisionNow.toISOString());
  const profile = buildDecisionProfile({
    user,
    memories: perfilOperativo.atomic_memories || [],
    exposures: deliveryContext.recentDeliveries,
    now: judgeNow,
    pseudonymSalt: process.env.ALERT_DECISION_PSEUDONYM_SALT,
  });
  const callers = crearCallersJuez({ caller, secondOpinionCaller });
  const dailyBudget = budget || await crearPresupuestoJuezDiario({ supabase });
  const result = await decideCandidateBatch({
    candidateSets: construirFuentesCandidatas(alertas, { exploracion }),
    profile,
    memories: perfilOperativo.atomic_memories || [],
    exposures: deliveryContext.recentDeliveries,
    context: {
      ...deliveryContext,
      now: decisionNow,
      judgeNow,
      decisionDate: fecha || null,
    },
    policy: {
      version: CONTRACT_VERSIONS.policy,
      topK: Math.max(1, Math.min(20, Number(policy.topK || process.env.ALERT_DECISION_TOP_K || DEFAULT_TOP_K))),
      maxItems: Math.max(1, Math.min(5, Number(policy.maxItems || 5))),
      judgeConcurrency: Math.max(
        1,
        Math.min(6, Number(policy.judgeConcurrency || process.env.ALERT_DECISION_JUDGE_CONCURRENCY || 3))
      ),
      allowDeterministicFallback: true,
      ...policy,
    },
    caller: callers.caller,
    secondOpinionCaller: callers.secondOpinionCaller,
    loadCachedDecisions: ({ inputHashes, compatibility }) => cargarCacheDecisionesJuez(supabase, {
      inputHashes,
      compatibility,
    }),
    budget: dailyBudget,
  });
  return {
    ...result,
    alertas: aplicarPortfolioAAlertas(alertas, result),
    audit_decisions: decisionesAuditoria(result),
  };
}

module.exports = {
  DEFAULT_TOP_K,
  parseJudgePricing,
  configuredDailyCallLimit,
  cargarUsoDiarioJuez,
  crearPresupuestoJuezAtomico,
  crearPresupuestoJuezDiario,
  construirFuentesCandidatas,
  consumeIdempotenciaEntrega,
  cargarContextoDecisionUsuario,
  crearCallersJuez,
  decisionesAuditoria,
  aplicarPortfolioAAlertas,
  decidirAlertasDigest,
};
