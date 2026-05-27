const { evaluarRelevanciaExperta } = require('./expertRelevance');

const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

const REVIEW_VERDICTS = new Set([
  'buena',
  'dudosa',
  'ruido',
  'critica',
  'local_solo_si_municipio',
]);

const EXPECTED_ACTIONS = new Set([
  'incluir',
  'revisar',
  'bloquear',
]);

const REASON_CODES = new Set([
  'territorio_incorrecto',
  'sector_incorrecto',
  'subsector_incorrecto',
  'tipo_incorrecto',
  'localidad_no_declarada',
  'expediente_individual',
  'resumen_generico',
  'resumen_incorrecto',
  'prioridad_exagerada',
  'faltan_datos_clave',
  'no_accionable',
  'fuente_ruidosa',
  'interes_real',
  'muy_accionable',
]);

function esTablaRevisionNoDisponible(error) {
  return Boolean(error && MISSING_TABLE_CODES.has(error.code));
}

function limpiarTexto(value, max = 500) {
  const limpio = String(value || '').replace(/\s+/g, ' ').trim();
  return limpio ? limpio.slice(0, max) : null;
}

function normalizarNumero(value) {
  const num = Number(value);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

function normalizarVerdict(value) {
  const limpio = limpiarTexto(value, 80);
  if (!limpio) return null;
  const key = limpio.toLowerCase();
  return REVIEW_VERDICTS.has(key) ? key : null;
}

function normalizarExpectedAction(value) {
  const limpio = limpiarTexto(value, 80);
  if (!limpio) return null;
  const key = limpio.toLowerCase();
  return EXPECTED_ACTIONS.has(key) ? key : null;
}

function normalizarReasonCodes(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/[,;\n]/g);

  return [...new Set(raw
    .map((item) => limpiarTexto(item, 80))
    .filter(Boolean)
    .map((item) => item.toLowerCase())
    .filter((item) => REASON_CODES.has(item)))]
    .slice(0, 12);
}

function normalizarJsonPlano(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function keyRevision({ digest_id, user_id, alerta_id } = {}) {
  return [
    normalizarNumero(digest_id) || 'sin_digest',
    normalizarNumero(user_id) || 'sin_user',
    normalizarNumero(alerta_id) || 'sin_alerta',
  ].join(':');
}

function construirReviewRowMIA({
  body = {},
  actor = {},
  alerta = null,
  user = null,
  expert = null,
  organizationId = null,
} = {}) {
  const digestId = normalizarNumero(body.digest_id);
  const userId = normalizarNumero(body.user_id || user?.id);
  const alertaId = normalizarNumero(body.alerta_id || alerta?.id);
  const verdict = normalizarVerdict(body.verdict);
  const expectedAction = normalizarExpectedAction(body.expected_action);

  if (!digestId || !userId || !alertaId) {
    throw new Error('digest_id, user_id y alerta_id son obligatorios');
  }
  if (!verdict) {
    throw new Error(`verdict invalido. Usa: ${[...REVIEW_VERDICTS].join(', ')}`);
  }
  if (!expectedAction) {
    throw new Error(`expected_action invalido. Usa: ${[...EXPECTED_ACTIONS].join(', ')}`);
  }

  const experto = expert || (
    alerta && user ? evaluarRelevanciaExperta(alerta, user) : null
  );

  return {
    digest_item_id: normalizarNumero(body.digest_item_id),
    digest_id: digestId,
    user_id: userId,
    alerta_id: alertaId,
    item_numero: normalizarNumero(body.item_numero),
    organization_id: normalizarNumero(organizationId || body.organization_id || user?.organization_id),
    reviewer_admin_user_id: normalizarNumero(actor.admin_user_id),
    reviewer_username: limpiarTexto(actor.username, 120),
    verdict,
    expected_action: expectedAction,
    reason_codes: normalizarReasonCodes(body.reason_codes || body.reasons),
    notes: limpiarTexto(body.notes || body.nota, 1200),
    expert_version: limpiarTexto(experto?.version, 80),
    expert_score: Number.isFinite(Number(experto?.score)) ? Number(experto.score) : null,
    expert_verdict: limpiarTexto(experto?.veredicto, 80),
    decision_json: normalizarJsonPlano(body.decision_json || body.decision || {}),
    correction_json: normalizarJsonPlano(body.correction_json || body.correction || {}),
    reviewed_at: new Date().toISOString(),
  };
}

function reviewMap(reviews = []) {
  const map = new Map();
  for (const review of reviews || []) {
    const key = keyRevision(review);
    if (!map.has(key)) map.set(key, review);
  }
  return map;
}

function feedbackMap(feedbacks = []) {
  const map = new Map();
  for (const feedback of feedbacks || []) {
    const key = keyRevision(feedback);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(feedback);
  }
  return map;
}

function resumirFeedback(items = []) {
  const positivos = items.filter((item) => Number(item.valor) > 0).length;
  const negativos = items.filter((item) => Number(item.valor) < 0).length;
  return {
    total: items.length,
    positivos,
    negativos,
    score: positivos - negativos,
    latest: items[0] || null,
  };
}

function etiquetaSugerida({ expert = {}, feedback = {}, review = null } = {}) {
  if (review?.verdict) return review.verdict;
  if (feedback.negativos > 0 && expert.veredicto === 'incluir') return 'dudosa';
  if (expert.blocks?.some((block) => block.code === 'expediente_individual_sin_municipio')) {
    return 'local_solo_si_municipio';
  }
  if (expert.veredicto === 'bloquear') return 'ruido';
  if (expert.veredicto === 'revisar') return 'dudosa';
  return 'buena';
}

function construirItemRevisionMIA({
  digestItem,
  alerta,
  user,
  review = null,
  feedbacks = [],
} = {}) {
  const expert = alerta && user ? evaluarRelevanciaExperta(alerta, user) : null;
  const feedback = resumirFeedback(feedbacks);
  const tags = digestItem?.tags_json && typeof digestItem.tags_json === 'object'
    ? digestItem.tags_json
    : {};

  return {
    key: keyRevision(digestItem),
    reviewed: Boolean(review),
    suggested_verdict: etiquetaSugerida({ expert, feedback, review }),
    digest_item: {
      id: digestItem?.id || null,
      digest_id: digestItem?.digest_id || null,
      user_id: digestItem?.user_id || null,
      alerta_id: digestItem?.alerta_id || null,
      fecha: digestItem?.fecha || null,
      item_numero: digestItem?.item_numero || null,
      score: digestItem?.score ?? null,
      motivo_seleccion: digestItem?.motivo_seleccion || null,
      resumen_usado: digestItem?.resumen_usado || null,
      decision_digest: tags.decision_digest || null,
    },
    user: user ? {
      id: user.id,
      name: user.legal_name || user.name || user.first_name || null,
      phone: user.phone || null,
      subscription: user.subscription || null,
      preferences: user.preferences || {},
      preferencias_extra: user.preferencias_extra || null,
      organization_id: user.organization_id || null,
    } : null,
    alerta: alerta ? {
      id: alerta.id,
      titulo: alerta.titulo || null,
      url: alerta.url || null,
      fecha: alerta.fecha || null,
      fuente: alerta.fuente || null,
      region: alerta.region || null,
      resumen: alerta.resumen || null,
      resumen_final: alerta.resumen_final || null,
      provincias: Array.isArray(alerta.provincias) ? alerta.provincias : [],
      sectores: Array.isArray(alerta.sectores) ? alerta.sectores : [],
      subsectores: Array.isArray(alerta.subsectores) ? alerta.subsectores : [],
      tipos_alerta: Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : [],
      estado_ia: alerta.estado_ia || null,
    } : null,
    expert: expert ? {
      version: expert.version,
      score: expert.score,
      veredicto: expert.veredicto,
      riesgo: expert.riesgo,
      blocks: expert.blocks,
      reasons: expert.reasons.slice(0, 8),
      features: expert.features,
      calidad: expert.calidad,
    } : null,
    feedback,
    review,
  };
}

function resumirDatasetRevisionMIA(items = []) {
  const summary = {
    total: items.length,
    revisadas: 0,
    pendientes: 0,
    con_feedback_negativo: 0,
    by_suggested_verdict: {},
    by_expert_verdict: {},
    by_review_verdict: {},
  };

  for (const item of items || []) {
    if (item.reviewed) summary.revisadas += 1;
    else summary.pendientes += 1;
    if (item.feedback?.negativos > 0) summary.con_feedback_negativo += 1;

    const suggested = item.suggested_verdict || 'sin_etiqueta';
    summary.by_suggested_verdict[suggested] = (summary.by_suggested_verdict[suggested] || 0) + 1;

    const expertVerdict = item.expert?.veredicto || 'sin_experto';
    summary.by_expert_verdict[expertVerdict] = (summary.by_expert_verdict[expertVerdict] || 0) + 1;

    const reviewVerdict = item.review?.verdict || 'sin_revision';
    summary.by_review_verdict[reviewVerdict] = (summary.by_review_verdict[reviewVerdict] || 0) + 1;
  }

  return summary;
}

function construirDatasetRevisionMIA({
  digestItems = [],
  alertas = [],
  users = [],
  reviews = [],
  feedbacks = [],
  onlyUnreviewed = false,
  verdict = null,
} = {}) {
  const alertasPorId = new Map((alertas || []).map((alerta) => [Number(alerta.id), alerta]));
  const usersPorId = new Map((users || []).map((user) => [Number(user.id), user]));
  const reviewsPorKey = reviewMap(reviews);
  const feedbacksPorKey = feedbackMap(feedbacks);
  const filtroVerdict = normalizarVerdict(verdict);

  const items = (digestItems || [])
    .map((digestItem) => {
      const key = keyRevision(digestItem);
      return construirItemRevisionMIA({
        digestItem,
        alerta: alertasPorId.get(Number(digestItem.alerta_id)),
        user: usersPorId.get(Number(digestItem.user_id)),
        review: reviewsPorKey.get(key) || null,
        feedbacks: feedbacksPorKey.get(key) || [],
      });
    })
    .filter((item) => !onlyUnreviewed || !item.reviewed)
    .filter((item) => !filtroVerdict || item.suggested_verdict === filtroVerdict || item.review?.verdict === filtroVerdict);

  return {
    items,
    summary: resumirDatasetRevisionMIA(items),
    options: {
      verdicts: [...REVIEW_VERDICTS],
      expected_actions: [...EXPECTED_ACTIONS],
      reason_codes: [...REASON_CODES],
    },
  };
}

module.exports = {
  REVIEW_VERDICTS,
  EXPECTED_ACTIONS,
  REASON_CODES,
  esTablaRevisionNoDisponible,
  normalizarVerdict,
  normalizarExpectedAction,
  normalizarReasonCodes,
  keyRevision,
  construirReviewRowMIA,
  construirItemRevisionMIA,
  construirDatasetRevisionMIA,
  resumirDatasetRevisionMIA,
};
