const {
  DISCARD_REASON_MESSAGES,
  HARD_DISCARD_REASON_CODES,
  construirDescarteAuditable,
  esAlertaDescartada,
  esDescarteAuditable,
  obtenerClasificacionAlerta,
  obtenerPreclasificacionAlerta,
} = require('./discardDecision');

const LEGACY_DISCARD_SELECT = Object.freeze([
  'id',
  'estado_ia',
  'resumen',
  'discard_reason_code',
  'discard_reason',
  'discard_stage',
  'discard_confidence',
  'pre_score',
  'pre_status',
  'pre_reasons',
  'candidate_level',
  'decision_audit',
]);

function textoNoVacio(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function confianzaConocida(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const numero = Number(value);
    if (Number.isFinite(numero) && numero >= 0 && numero <= 1) return numero;
  }
  return null;
}

function codigoDuroPreclasificado(preclassification = {}) {
  const reasons = Array.isArray(preclassification.pre_reasons)
    ? preclassification.pre_reasons
    : [];
  return reasons.find((reason) =>
    reason && HARD_DISCARD_REASON_CODES.includes(reason.tag)
  )?.tag || null;
}

function deducirDescarteHistorico(alerta = {}) {
  const auditAnterior = alerta.decision_audit && typeof alerta.decision_audit === 'object'
    ? alerta.decision_audit
    : {};
  const auditDiscard = auditAnterior.discard && typeof auditAnterior.discard === 'object'
    ? auditAnterior.discard
    : {};
  const preclassification = obtenerPreclasificacionAlerta(alerta);
  const classification = obtenerClasificacionAlerta(alerta);
  const hardCode = codigoDuroPreclasificado(preclassification);

  let code = textoNoVacio(alerta.discard_reason_code)
    || textoNoVacio(auditDiscard.code)
    || textoNoVacio(classification.discard_reason_code)
    || hardCode;
  let reason = textoNoVacio(alerta.discard_reason)
    || textoNoVacio(auditDiscard.reason)
    || textoNoVacio(classification.discard_reason);
  let stage = textoNoVacio(alerta.discard_stage)
    || textoNoVacio(auditDiscard.stage)
    || textoNoVacio(classification.discard_stage);
  let confidence = confianzaConocida(
    alerta.discard_confidence,
    auditDiscard.confidence,
    classification.discard_confidence
  );

  if (hardCode && !stage) stage = 'preclassifier';
  if (hardCode && confidence === null) confidence = 1;

  if (code && !reason && DISCARD_REASON_MESSAGES[code]) {
    reason = DISCARD_REASON_MESSAGES[code];
  }

  if (!code) {
    code = 'legacy_unstructured_discard';
  }
  if (!reason) {
    if (!DISCARD_REASON_MESSAGES[code]) code = 'legacy_unstructured_discard';
    reason = DISCARD_REASON_MESSAGES.legacy_unstructured_discard;
  }

  stage = stage || 'legacy_unknown';
  confidence = confidence ?? 0;

  return {
    code,
    reason,
    stage,
    confidence,
    preclassification,
    classification,
    previousAudit: auditAnterior,
  };
}

function prepararReparacionDescarteHistorico(alerta = {}) {
  if (!esAlertaDescartada(alerta)) {
    return { status: 'not_discarded', patch: null };
  }
  if (esDescarteAuditable(alerta)) {
    return { status: 'already_structured', patch: null };
  }

  const metadata = deducirDescarteHistorico(alerta);
  const patch = construirDescarteAuditable(metadata);
  delete patch.resumen;
  return {
    status: metadata.code === 'legacy_unstructured_discard'
      ? 'repair_unknown_reason'
      : 'repair_deduced_reason',
    patch,
  };
}

function normalizarTamanoPagina(value, fallback = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 1000);
}

async function repararDescartesHistoricos(supabase, {
  dryRun = true,
  pageSize = 500,
} = {}) {
  const tamanoPagina = normalizarTamanoPagina(pageSize);
  const alertas = [];
  let cursorId = null;

  while (true) {
    let query = supabase
      .from('alertas')
      .select(LEGACY_DISCARD_SELECT.join(', '))
      .eq('estado_ia', 'descartado');
    if (cursorId !== null) query = query.gt('id', cursorId);
    query = query
      .order('id', { ascending: true })
      .limit(tamanoPagina);

    const { data, error } = await query;
    if (error) throw new Error(`No se pudieron leer los descartes historicos: ${error.message}`);

    const pagina = data || [];
    alertas.push(...pagina);
    if (pagina.length < tamanoPagina) break;

    const siguienteCursor = pagina[pagina.length - 1]?.id;
    if (siguienteCursor === null || siguienteCursor === undefined || siguienteCursor === cursorId) {
      throw new Error('La paginacion de descartes historicos no pudo avanzar');
    }
    cursorId = siguienteCursor;
  }

  const planes = alertas.map((alerta) => ({
    id: alerta.id,
    ...prepararReparacionDescarteHistorico(alerta),
  }));
  const pendientes = planes.filter((plan) => plan.patch);
  const resultado = {
    mode: dryRun ? 'dry-run' : 'apply',
    scanned: planes.length,
    already_structured: planes.filter((plan) => plan.status === 'already_structured').length,
    repairable: pendientes.length,
    repaired: 0,
    failed: [],
    preview: pendientes.slice(0, 50).map((plan) => ({
      id: plan.id,
      status: plan.status,
      discard_reason_code: plan.patch.discard_reason_code,
      discard_stage: plan.patch.discard_stage,
      discard_confidence: plan.patch.discard_confidence,
    })),
  };

  if (dryRun) return resultado;

  for (const plan of pendientes) {
    const { error: updateError } = await supabase
      .from('alertas')
      .update(plan.patch)
      .eq('id', plan.id)
      .eq('estado_ia', 'descartado');

    if (updateError) {
      resultado.failed.push({ id: plan.id, error: updateError.message });
    } else {
      resultado.repaired += 1;
    }
  }

  return resultado;
}

module.exports = {
  LEGACY_DISCARD_SELECT,
  deducirDescarteHistorico,
  normalizarTamanoPagina,
  prepararReparacionDescarteHistorico,
  repararDescartesHistoricos,
};
