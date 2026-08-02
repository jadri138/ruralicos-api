function porcentaje(numerador, denominador) {
  if (!denominador) return 0;
  return Number(((Number(numerador || 0) / Number(denominador)) * 100).toFixed(1));
}

function idsUnicos(rows = [], field) {
  return new Set((rows || []).map((row) => row?.[field]).filter((value) => value !== null && value !== undefined));
}

function contarRepeticionesPorUsuario(digests = []) {
  const vistos = new Map();
  let repeticiones = 0;
  for (const digest of [...digests].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))) {
    const userId = String(digest.user_id || '');
    if (!userId) continue;
    const userSet = vistos.get(userId) || new Set();
    for (const alertaId of digest.alerta_ids || []) {
      const id = String(alertaId);
      if (userSet.has(id)) repeticiones++;
      userSet.add(id);
    }
    vistos.set(userId, userSet);
  }
  return repeticiones;
}

function tieneMatchTrace(decision = {}) {
  const trace = decision?.match_trace ||
    decision?.diagnostico?.match_trace ||
    decision?.selection_decision?.match_trace ||
    decision?.selection_decision?.diagnostico?.match_trace;
  return Boolean(trace?.version && trace?.reason);
}

function numeroNoNegativo(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function sumarUso(rows = [], keys = []) {
  return rows.reduce((total, row) => {
    const usage = row?.llm_usage || {};
    const value = keys.map((key) => usage[key]).find((item) => Number.isFinite(Number(item)));
    return total + numeroNoNegativo(value);
  }, 0);
}

function dividirCostes(costes = {}, divisor = 0) {
  if (!divisor) return {};
  return Object.fromEntries(Object.entries(costes).map(([currency, amount]) => [
    currency,
    Number((amount / divisor).toFixed(8)),
  ]));
}

function enteroNoNegativo(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function resumirEmbudoDigest(attempts = []) {
  const funnel = {
    judge_evaluated: 0,
    approved: 0,
    queued: 0,
    delivered: 0,
  };

  for (const row of attempts || []) {
    funnel.judge_evaluated += enteroNoNegativo(row?.judge_evaluated_count);
    funnel.approved += enteroNoNegativo(row?.approved_count);
    funnel.queued += enteroNoNegativo(row?.queued_count);
    funnel.delivered += enteroNoNegativo(row?.delivered_count);
  }

  return funnel;
}

const VOLUME_METRICS = Object.freeze([
  { key: 'available_alerts', field: 'available_alerts', label: 'alertas disponibles' },
  { key: 'judge_evaluated', field: 'judge_evaluated', label: 'parejas evaluadas por el juez' },
  { key: 'approved', field: 'approved', label: 'candidatas aprobadas' },
  { key: 'queued', field: 'queued', label: 'digests encolados' },
  { key: 'delivered', field: 'delivered', label: 'digests entregados' },
]);

function numeroAcotado(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function resolverPoliticaAnomaliasVolumen(input = process.env) {
  const minBaselineDays = Math.floor(numeroAcotado(
    input?.minBaselineDays ?? input?.min_baseline_days ?? input?.RECOMMENDATION_VOLUME_MIN_BASELINE_DAYS,
    5,
    2,
    30
  ));
  const baselineDays = Math.floor(numeroAcotado(
    input?.baselineDays ?? input?.baseline_days ?? input?.RECOMMENDATION_VOLUME_BASELINE_DAYS,
    7,
    minBaselineDays,
    60
  ));

  return {
    baseline_days: Math.max(minBaselineDays, baselineDays),
    min_baseline_days: minBaselineDays,
    min_baseline_volume: Math.floor(numeroAcotado(
      input?.minBaselineVolume ?? input?.min_baseline_volume ?? input?.RECOMMENDATION_VOLUME_MIN_BASELINE_VOLUME,
      5,
      1,
      1000000
    )),
    drop_ratio: numeroAcotado(
      input?.dropRatio ?? input?.drop_ratio ?? input?.RECOMMENDATION_VOLUME_DROP_RATIO,
      0.5,
      0.05,
      0.95
    ),
    spike_ratio: numeroAcotado(
      input?.spikeRatio ?? input?.spike_ratio ?? input?.RECOMMENDATION_VOLUME_SPIKE_RATIO,
      2,
      1.05,
      20
    ),
  };
}

function mediana(values = []) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function construirVolumenDiario(attempts = []) {
  const byDate = new Map();

  for (const row of attempts || []) {
    const day = normalizarFechaCalendario(row?.fecha);
    if (!day) continue;
    const daily = byDate.get(day.fecha) || {
      fecha: day.fecha,
      ordinal: day.ordinal,
      available_alerts: 0,
      judge_evaluated: 0,
      approved: 0,
      queued: 0,
      delivered: 0,
    };

    // total_alertas_dia es un contador global repetido por usuario. El maximo
    // representa el volumen real del dia; sumarlo inflaria el baseline.
    daily.available_alerts = Math.max(
      daily.available_alerts,
      enteroNoNegativo(row?.total_alertas_dia)
    );
    daily.judge_evaluated += enteroNoNegativo(row?.judge_evaluated_count);
    daily.approved += enteroNoNegativo(row?.approved_count);
    daily.queued += enteroNoNegativo(row?.queued_count);
    daily.delivered += enteroNoNegativo(row?.delivered_count);
    byDate.set(day.fecha, daily);
  }

  return [...byDate.values()].sort((a, b) => a.ordinal - b.ordinal);
}

function analizarAnomaliasVolumen(attempts = [], policyInput = {}) {
  const policy = resolverPoliticaAnomaliasVolumen(policyInput);
  const series = construirVolumenDiario(attempts);
  const latest = series.at(-1) || null;
  const historical = latest
    ? series.slice(Math.max(0, series.length - 1 - policy.baseline_days), -1)
    : [];
  const checks = [];

  for (const metric of VOLUME_METRICS) {
    const sample = historical.map((row) => enteroNoNegativo(row[metric.field]));
    const baseline = Number(mediana(sample).toFixed(2));
    const actual = latest ? enteroNoNegativo(latest[metric.field]) : 0;
    let state = 'normal';
    let ratio = baseline > 0 ? Number((actual / baseline).toFixed(3)) : null;

    if (!latest || sample.length < policy.min_baseline_days) {
      state = 'insufficient_sample';
      ratio = null;
    } else if (baseline < policy.min_baseline_volume) {
      state = 'insufficient_volume';
      ratio = null;
    } else if (ratio <= policy.drop_ratio) {
      state = 'drop';
    } else if (ratio >= policy.spike_ratio) {
      state = 'spike';
    }

    checks.push({
      metric: metric.key,
      label: metric.label,
      date: latest?.fecha || null,
      actual,
      baseline_median: baseline,
      baseline_sample_size: sample.length,
      ratio,
      state,
    });
  }

  return {
    version: 'recommendation_volume_anomaly_v1',
    date: latest?.fecha || null,
    policy,
    sample_days: historical.length,
    checks,
    anomalies: checks.filter((check) => ['drop', 'spike'].includes(check.state)),
  };
}

function contarEstadosEntrega(digests = []) {
  const counts = {};
  for (const digest of digests || []) {
    const raw = String(digest?.delivery_status || '').trim().toUpperCase();
    const status = raw || (digest?.enviado === true ? 'LEGACY_UNKNOWN' : 'UNKNOWN');
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

const HOLD_LIFECYCLE_STATUSES = Object.freeze([
  'PENDING',
  'PROCESSING',
  'FAILED',
  'RESOLVED',
  'EXHAUSTED',
  'EXPIRED',
]);

function resumirCicloHold(rows = []) {
  const statusCounts = Object.fromEntries(HOLD_LIFECYCLE_STATUSES.map((status) => [status, 0]));
  let holdEvaluations = 0;
  let retryAttempts = 0;
  let transferred = 0;

  for (const row of rows || []) {
    const decisionState = String(
      row?.decision_state || row?.decision_json?.decision || row?.decision_json?.decision_state || ''
    ).trim().toUpperCase();
    if (decisionState === 'HOLD_FOR_EVIDENCE') holdEvaluations += 1;

    const holdStatus = String(row?.hold_status || '').trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(statusCounts, holdStatus)) continue;
    statusCounts[holdStatus] += 1;
    // Cada fila con attempt > 0 representa una reevaluación. El valor es el
    // ordinal acumulado (1, 2, 3), por lo que sumarlo inflaría los reintentos.
    if (enteroNoNegativo(row?.hold_attempts) > 0) retryAttempts += 1;
    if (row?.hold_resolution_json?.transferred_to_new_hold === true) transferred += 1;
  }

  // Un RESOLVED transferido solo mueve el caso a la siguiente fila de retry;
  // no se cuenta como solucion real para evitar inflar la tasa.
  const successfullyResolved = Math.max(0, statusCounts.RESOLVED - transferred);
  const terminalOutcomes = successfullyResolved + statusCounts.EXHAUSTED + statusCounts.EXPIRED;
  const lifecycleTotal = Object.values(statusCounts).reduce((total, count) => total + count, 0);

  return {
    judge_hold_evaluations: holdEvaluations,
    judge_hold_rate_pct: porcentaje(holdEvaluations, rows.length),
    hold_lifecycle_total: lifecycleTotal,
    hold_status_counts: statusCounts,
    hold_retry_attempts: retryAttempts,
    hold_transferred_to_retry: transferred,
    hold_successfully_resolved: successfullyResolved,
    hold_terminal_outcomes: terminalOutcomes,
    hold_resolution_rate_pct: porcentaje(successfullyResolved, terminalOutcomes),
  };
}

function resumirUsoJuez(rows = []) {
  const users = idsUnicos(rows, 'user_id');
  const approvedDigests = new Set(
    rows
      .filter((row) => row?.action === 'include' && row?.digest_id != null)
      .map((row) => row.digest_id)
  );
  const fallbacks = {};
  const costs = {};
  const costsByDay = {};
  let budgetUnavailable = 0;
  let budgetUnlimited = 0;
  let providerAttempts = 0;

  for (const row of rows) {
    if (row?.fallback_reason) {
      fallbacks[row.fallback_reason] = (fallbacks[row.fallback_reason] || 0) + 1;
    }
    const dailyBudget = row?.decision_json?.judge_audit?.daily_budget;
    const auditedCalls = Array.isArray(row?.decision_json?.judge_audit?.calls)
      ? row.decision_json.judge_audit.calls
      : [];
    providerAttempts += auditedCalls.reduce(
      (total, call) => total + Math.max(1, Number(call?.attempts) || 1),
      0
    );
    if (dailyBudget?.unavailable === true) {
      budgetUnavailable += 1;
    }
    if (
      dailyBudget
      && dailyBudget.unavailable !== true
      && Object.prototype.hasOwnProperty.call(dailyBudget, 'max_calls')
      && dailyBudget.max_calls == null
    ) {
      budgetUnlimited += 1;
    }
    const amount = Number(row?.llm_cost?.amount);
    const currency = String(row?.llm_cost?.currency || '').trim().toUpperCase();
    if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) continue;
    costs[currency] = (costs[currency] || 0) + amount;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(row?.fecha || '')) ? row.fecha : 'unknown';
    costsByDay[day] ||= {};
    costsByDay[day][currency] = (costsByDay[day][currency] || 0) + amount;
  }

  for (const [currency, amount] of Object.entries(costs)) {
    costs[currency] = Number(amount.toFixed(8));
  }
  for (const day of Object.keys(costsByDay)) {
    for (const [currency, amount] of Object.entries(costsByDay[day])) {
      costsByDay[day][currency] = Number(amount.toFixed(8));
    }
  }

  const evaluations = rows.length;
  const approvedCandidates = rows.filter((row) => row?.action === 'include').length;
  const logicalCalls = rows.reduce(
    (total, row) => total + numeroNoNegativo(row?.llm_calls),
    0
  );
  return {
    judge_evaluations: evaluations,
    judge_users_evaluated: users.size,
    judge_approved_candidates: approvedCandidates,
    judge_approved_digests: approvedDigests.size,
    judge_llm_calls: logicalCalls,
    judge_provider_attempts: providerAttempts || logicalCalls,
    judge_provider_retries: Math.max(0, (providerAttempts || logicalCalls) - logicalCalls),
    judge_cache_hits: rows.filter((row) => row?.cache_hit === true).length,
    judge_cache_hit_rate_pct: porcentaje(rows.filter((row) => row?.cache_hit === true).length, evaluations),
    judge_input_tokens: sumarUso(rows, ['input_tokens', 'prompt_tokens']),
    judge_cached_input_tokens: sumarUso(rows, ['cached_input_tokens']),
    judge_output_tokens: sumarUso(rows, ['output_tokens', 'completion_tokens']),
    judge_total_tokens: sumarUso(rows, ['total_tokens']),
    judge_fallbacks: fallbacks,
    judge_budget_unavailable: budgetUnavailable,
    judge_budget_unlimited: budgetUnlimited,
    judge_cost_by_currency: costs,
    judge_cost_by_day: costsByDay,
    judge_cost_per_evaluation: dividirCostes(costs, evaluations),
    judge_cost_per_user: dividirCostes(costs, users.size),
    judge_cost_per_approved_digest: dividirCostes(costs, approvedDigests.size),
    ...resumirCicloHold(rows),
  };
}

const ESTADOS_INTENTO_EVALUADO = new Set([
  'failed',
  'generated',
  'no_send',
  'rescued',
  'sent',
  'skipped_existing',
]);
const ESTADOS_CON_RESULTADO = new Set(['generated', 'rescued', 'sent']);

function normalizarFechaCalendario(value) {
  const fecha = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return { fecha, ordinal: Math.floor(timestamp / (24 * 60 * 60 * 1000)) };
}

function calcularRachaSilencioGlobal(attempts = [], digests = []) {
  const diasEvaluados = new Map();

  for (const attempt of attempts || []) {
    const status = String(attempt?.status || '').trim().toLowerCase();
    const dia = normalizarFechaCalendario(attempt?.fecha);
    if (!dia || !ESTADOS_INTENTO_EVALUADO.has(status)) continue;

    const actual = diasEvaluados.get(dia.fecha) || {
      fecha: dia.fecha,
      ordinal: dia.ordinal,
      tieneResultado: false,
    };
    actual.tieneResultado ||= ESTADOS_CON_RESULTADO.has(status);
    diasEvaluados.set(dia.fecha, actual);
  }

  // Un digest existente tambien prueba que ese dia produjo resultado. Esto evita
  // falsos avisos si un segundo intento quedo como `skipped_existing`.
  for (const digest of digests || []) {
    const dia = normalizarFechaCalendario(digest?.fecha);
    const evaluado = dia ? diasEvaluados.get(dia.fecha) : null;
    if (evaluado) evaluado.tieneResultado = true;
  }

  let racha = 0;
  let ordinalAnterior = null;
  for (const dia of [...diasEvaluados.values()].sort((a, b) => a.ordinal - b.ordinal)) {
    if (ordinalAnterior !== null && dia.ordinal !== ordinalAnterior + 1) racha = 0;
    racha = dia.tieneResultado ? 0 : racha + 1;
    ordinalAnterior = dia.ordinal;
  }

  return racha;
}

function calcularSaludRecomendaciones({
  digests = [],
  clicks = [],
  feedback = [],
  attempts = [],
  decisions = [],
  judgeDecisions = [],
  volumePolicy = {},
} = {}) {
  const aceptados = (digests || []).filter((row) => [
    'PROVIDER_ACCEPTED', 'SENT_TO_WHATSAPP', 'DELIVERED', 'READ',
  ].includes(row.delivery_status));
  const entregados = (digests || []).filter((row) => ['DELIVERED', 'READ'].includes(row.delivery_status));
  const leidos = (digests || []).filter((row) => row.delivery_status === 'READ');
  const legacySinAck = (digests || []).filter((row) => row.enviado === true && !row.delivery_status);
  const intentosTerminales = (attempts || []).filter((row) =>
    ['sent', 'generated', 'rescued', 'no_send', 'failed'].includes(row.status)
  );
  const noSend = intentosTerminales.filter((row) => row.status === 'no_send').length;
  const failed = intentosTerminales.filter((row) => row.status === 'failed').length;
  const positivos = feedback.filter((row) => Number(row.valor) > 0).length;
  const negativos = feedback.filter((row) => Number(row.valor) < 0).length;
  const ubicacionIncorrecta = feedback.filter((row) => row.feedback_category === 'wrong_location').length;
  const seleccionInclude = decisions.filter((row) => row.stage === 'selection' && row.action === 'include');
  const conTrace = seleccionInclude.filter((row) => tieneMatchTrace(row.decision_json || {})).length;
  const digestConClick = idsUnicos(clicks, 'digest_id');
  const digestConFeedback = idsUnicos(feedback, 'digest_id');
  const repeticiones = contarRepeticionesPorUsuario(entregados);
  const rachaSilencioGlobal = calcularRachaSilencioGlobal(attempts, digests);
  const judgeMetrics = resumirUsoJuez(judgeDecisions);
  const digestFunnel = resumirEmbudoDigest(attempts);
  const volumeHealth = analizarAnomaliasVolumen(attempts, volumePolicy);

  const metrics = {
    provider_accepted_digests: aceptados.length,
    delivered_digests: entregados.length,
    read_digests: leidos.length,
    legacy_delivery_unknown: legacySinAck.length,
    terminal_attempts: intentosTerminales.length,
    no_send: noSend,
    failed,
    unique_recipients: idsUnicos(entregados, 'user_id').size,
    digests_with_click: digestConClick.size,
    digests_with_feedback: digestConFeedback.size,
    feedback_total: feedback.length,
    feedback_positive: positivos,
    feedback_negative: negativos,
    wrong_location_feedback: ubicacionIncorrecta,
    selection_includes: seleccionInclude.length,
    selection_includes_with_trace: conTrace,
    repeated_alerts_same_user: repeticiones,
    global_silence_streak_days: rachaSilencioGlobal,
    digest_funnel: digestFunnel,
    delivery_status_counts: contarEstadosEntrega(digests),
    volume_health: volumeHealth,
    provider_acceptance_rate_pct: porcentaje(aceptados.length, intentosTerminales.length),
    delivery_rate_pct: porcentaje(entregados.length, intentosTerminales.length),
    no_send_rate_pct: porcentaje(noSend, intentosTerminales.length),
    click_rate_pct: porcentaje(digestConClick.size, entregados.length),
    feedback_rate_pct: porcentaje(digestConFeedback.size, entregados.length),
    positive_feedback_pct: porcentaje(positivos, feedback.length),
    negative_feedback_pct: porcentaje(negativos, feedback.length),
    trace_coverage_pct: porcentaje(conTrace, seleccionInclude.length),
    ...judgeMetrics,
  };

  const flags = [];
  const add = (code, severity, detail) => flags.push({ code, severity, detail });
  if (failed > 0) add('digest_failures', 'critical', `${failed} intentos fallidos`);
  if (intentosTerminales.length >= 20 && metrics.delivery_rate_pct < 10) {
    add('delivery_rate_critical', 'critical', `Solo ${metrics.delivery_rate_pct}% de intentos llegaron al dispositivo`);
  }
  if (seleccionInclude.length >= 10 && metrics.trace_coverage_pct < 99) {
    add('trace_coverage_low', 'critical', `${metrics.trace_coverage_pct}% de inclusiones tienen explicación`);
  }
  if (feedback.length >= 5 && metrics.negative_feedback_pct >= 35) {
    add('negative_feedback_high', 'warning', `${metrics.negative_feedback_pct}% del feedback es negativo`);
  }
  if (ubicacionIncorrecta > 0) {
    add('wrong_location_feedback', 'critical', `${ubicacionIncorrecta} respuestas indican territorio incorrecto`);
  }
  if (repeticiones > 0) {
    add('repeated_alerts_same_user', 'critical', `${repeticiones} alertas se repitieron al mismo usuario`);
  }
  if (rachaSilencioGlobal >= 3) {
    add(
      'global_silence_multiple_days',
      'critical',
      `${rachaSilencioGlobal} dias calendario consecutivos evaluados sin resultados`
    );
  }
  if (metrics.judge_budget_unavailable > 0) {
    add(
      'judge_budget_unavailable',
      'warning',
      `${metrics.judge_budget_unavailable} evaluaciones degradadas sin poder comprobar el presupuesto`
    );
  }
  if (metrics.judge_budget_unlimited > 0) {
    add(
      'judge_budget_unlimited',
      'warning',
      `${metrics.judge_budget_unlimited} evaluaciones se ejecutaron sin tope diario configurado`
    );
  }
  if (metrics.hold_status_counts.EXHAUSTED > 0) {
    add(
      'hold_retries_exhausted',
      'warning',
      `${metrics.hold_status_counts.EXHAUSTED} casos HOLD agotaron sus reintentos`
    );
  }
  if (metrics.hold_status_counts.EXPIRED > 0) {
    add(
      'hold_cases_expired',
      'warning',
      `${metrics.hold_status_counts.EXPIRED} casos HOLD caducaron sin una salida util`
    );
  }
  for (const anomaly of volumeHealth.anomalies) {
    const direction = anomaly.state === 'drop' ? 'caida' : 'pico';
    const severity = anomaly.state === 'drop' && anomaly.actual === 0 ? 'critical' : 'warning';
    add(
      `volume_${anomaly.state}_${anomaly.metric}`,
      severity,
      `${direction} de ${anomaly.label}: ${anomaly.actual} frente a mediana ${anomaly.baseline_median}`
    );
  }
  if (entregados.length >= 10 && metrics.click_rate_pct < 5) {
    add('click_rate_low', 'warning', `Solo ${metrics.click_rate_pct}% de digests tuvieron clic`);
  }

  const status = flags.some((flag) => flag.severity === 'critical')
    ? 'critical'
    : (flags.length ? 'warning' : 'healthy');
  const score = Math.max(
    0,
    100 -
      flags.filter((flag) => flag.severity === 'critical').length * 25 -
      flags.filter((flag) => flag.severity === 'warning').length * 10
  );

  return { status, score, metrics, flags };
}

async function generarSaludRecomendaciones(supabase, { days = 14, persist = true, now = new Date() } = {}) {
  const dias = Math.max(1, Math.min(90, Number(days) || 14));
  const desde = new Date(now.getTime() - dias * 24 * 60 * 60 * 1000).toISOString();
  const traceCutoff = new Date(process.env.DIGEST_DECISION_REQUIRED_FROM || '2026-07-21T00:00:00+02:00');
  const traceDesde = !Number.isNaN(traceCutoff.getTime()) && traceCutoff > new Date(desde)
    ? traceCutoff.toISOString()
    : desde;
  const fecha = now.toISOString().slice(0, 10);

  const [digestsRes, clicksRes, feedbackRes, attemptsRes, decisionsRes, judgeDecisionsRes] = await Promise.all([
    supabase.from('digests').select('id, user_id, fecha, alerta_ids, enviado, delivery_status').gte('created_at', desde),
    supabase.from('alerta_clicks').select('digest_id, user_id, alerta_id').gte('created_at', desde),
    supabase.from('alerta_feedback').select('digest_id, user_id, alerta_id, valor, feedback_category').gte('created_at', desde),
    supabase
      .from('digest_attempts')
      .select('user_id, fecha, status, motivo_no_envio, total_alertas_dia, judge_evaluated_count, approved_count, queued_count, delivered_count, delivery_status')
      .gte('created_at', desde),
    supabase.from('digest_candidate_decisions').select('stage, action, decision_json').eq('stage', 'selection').gte('created_at', traceDesde),
    supabase
      .from('digest_candidate_decisions')
      .select('user_id, digest_id, fecha, action, decision_state, decision_json, llm_usage, llm_cost, llm_calls, cache_hit, fallback_reason, hold_status, hold_attempts, hold_resolution_json')
      .eq('stage', 'personal_relevance_judge')
      .gte('created_at', desde),
  ]);
  for (const result of [digestsRes, clicksRes, feedbackRes, attemptsRes, decisionsRes, judgeDecisionsRes]) {
    if (result.error) throw result.error;
  }

  const report = {
    version: 'mia_recommendation_health_v3',
    fecha,
    period_days: dias,
    period_start: desde,
    trace_period_start: traceDesde,
    evaluated_at: now.toISOString(),
    ...calcularSaludRecomendaciones({
      digests: digestsRes.data || [],
      clicks: clicksRes.data || [],
      feedback: feedbackRes.data || [],
      attempts: attemptsRes.data || [],
      decisions: decisionsRes.data || [],
      judgeDecisions: judgeDecisionsRes.data || [],
      volumePolicy: resolverPoliticaAnomaliasVolumen(),
    }),
  };

  if (persist) {
    const { error } = await supabase
      .from('mia_recommendation_health_snapshots')
      .upsert({
        fecha,
        status: report.status,
        score: report.score,
        period_days: dias,
        metrics_json: report.metrics,
        flags_json: report.flags,
        evaluated_at: report.evaluated_at,
      }, { onConflict: 'fecha' });
    if (error) throw error;
  }

  return report;
}

module.exports = {
  analizarAnomaliasVolumen,
  calcularRachaSilencioGlobal,
  calcularSaludRecomendaciones,
  construirVolumenDiario,
  contarEstadosEntrega,
  contarRepeticionesPorUsuario,
  generarSaludRecomendaciones,
  resolverPoliticaAnomaliasVolumen,
  resumirCicloHold,
  resumirEmbudoDigest,
  resumirUsoJuez,
  tieneMatchTrace,
};
