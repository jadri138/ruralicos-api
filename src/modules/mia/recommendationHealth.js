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

function calcularSaludRecomendaciones({
  digests = [],
  clicks = [],
  feedback = [],
  attempts = [],
  decisions = [],
} = {}) {
  const enviados = (digests || []).filter((row) => row.enviado === true);
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
  const repeticiones = contarRepeticionesPorUsuario(enviados);

  const metrics = {
    sent_digests: enviados.length,
    terminal_attempts: intentosTerminales.length,
    no_send: noSend,
    failed,
    unique_recipients: idsUnicos(enviados, 'user_id').size,
    digests_with_click: digestConClick.size,
    digests_with_feedback: digestConFeedback.size,
    feedback_total: feedback.length,
    feedback_positive: positivos,
    feedback_negative: negativos,
    wrong_location_feedback: ubicacionIncorrecta,
    selection_includes: seleccionInclude.length,
    selection_includes_with_trace: conTrace,
    repeated_alerts_same_user: repeticiones,
    delivery_rate_pct: porcentaje(enviados.length, intentosTerminales.length),
    no_send_rate_pct: porcentaje(noSend, intentosTerminales.length),
    click_rate_pct: porcentaje(digestConClick.size, enviados.length),
    feedback_rate_pct: porcentaje(digestConFeedback.size, enviados.length),
    positive_feedback_pct: porcentaje(positivos, feedback.length),
    negative_feedback_pct: porcentaje(negativos, feedback.length),
    trace_coverage_pct: porcentaje(conTrace, seleccionInclude.length),
  };

  const flags = [];
  const add = (code, severity, detail) => flags.push({ code, severity, detail });
  if (failed > 0) add('digest_failures', 'critical', `${failed} intentos fallidos`);
  if (intentosTerminales.length >= 20 && metrics.delivery_rate_pct < 10) {
    add('delivery_rate_critical', 'critical', `Solo ${metrics.delivery_rate_pct}% de intentos terminaron en envío`);
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
  if (enviados.length >= 10 && metrics.click_rate_pct < 5) {
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
  const fecha = now.toISOString().slice(0, 10);

  const [digestsRes, clicksRes, feedbackRes, attemptsRes, decisionsRes] = await Promise.all([
    supabase.from('digests').select('id, user_id, fecha, alerta_ids, enviado').gte('created_at', desde),
    supabase.from('alerta_clicks').select('digest_id, user_id, alerta_id').gte('created_at', desde),
    supabase.from('alerta_feedback').select('digest_id, user_id, alerta_id, valor, feedback_category').gte('created_at', desde),
    supabase.from('digest_attempts').select('user_id, status, motivo_no_envio').gte('created_at', desde),
    supabase.from('digest_candidate_decisions').select('stage, action, decision_json').eq('stage', 'selection').gte('created_at', desde),
  ]);
  for (const result of [digestsRes, clicksRes, feedbackRes, attemptsRes, decisionsRes]) {
    if (result.error) throw result.error;
  }

  const report = {
    version: 'mia_recommendation_health_v1',
    fecha,
    period_days: dias,
    period_start: desde,
    evaluated_at: now.toISOString(),
    ...calcularSaludRecomendaciones({
      digests: digestsRes.data || [],
      clicks: clicksRes.data || [],
      feedback: feedbackRes.data || [],
      attempts: attemptsRes.data || [],
      decisions: decisionsRes.data || [],
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
  calcularSaludRecomendaciones,
  contarRepeticionesPorUsuario,
  generarSaludRecomendaciones,
  tieneMatchTrace,
};
