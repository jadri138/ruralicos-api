const { conOrganizationId } = require('./organizationContext');

function resumenUsado(alerta = {}) {
  return String(alerta.resumen_final || alerta.resumen || alerta.titulo || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function tagsAlerta(alerta = {}) {
  const decision = alerta.decision_digest || null;
  const similitud = normalizarNumero(alerta.similitud);
  const selectionScore = scoreSeleccion(alerta);
  const finalValidation = alerta.final_validation || alerta.validacion_final_digest || {};
  const effectiveSendGate = alerta.effective_send_gate || alerta.contexto_mia_digest?.effective_send_gate || {};

  return {
    provincias: Array.isArray(alerta.provincias) ? alerta.provincias : [],
    sectores: Array.isArray(alerta.sectores) ? alerta.sectores : [],
    subsectores: Array.isArray(alerta.subsectores) ? alerta.subsectores : [],
    tipos_alerta: Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : [],
    fuente: alerta.fuente || null,
    decision_digest: decision,
    selection: decision ? {
      action: decision.action || (decision.incluir ? 'include' : 'exclude'),
      incluir: Boolean(decision.incluir),
      motivo: decision.motivo || null,
      riesgo: decision.riesgo || null,
      score: selectionScore,
      score_source: Number.isFinite(Number(decision.score)) ? 'selection_engine' : 'similarity',
    } : null,
    // Auditoria top-level (fallback seguro en tags_json si faltan columnas dedicadas en digest_items).
    selection_action: decision ? (decision.action || (decision.incluir ? 'include' : null)) : null,
    selection_risk: decision?.riesgo || null,
    selection_reason: decision?.motivo || null,
    enviable_automatico: decision ? Boolean((decision.action || (decision.incluir ? 'include' : null)) === 'include') : null,
    similitud,
    calidad_mia: alerta.calidad_mia || null,
    mia_profile_score: normalizarNumero(alerta.mia_profile_score),
    mia_profile_reasons: Array.isArray(alerta.mia_profile_reasons) ? alerta.mia_profile_reasons : [],
    mia_profile_excluded: Boolean(alerta.mia_profile_excluded),
    motivo_seleccion_mia: alerta.motivo_seleccion_mia || null,
    grupo_digest: alerta.grupo_digest || null,
    grupo_digest_key: alerta.grupo_digest_key || null,
    relevancia_digest: alerta.relevancia_digest || null,
    relevancia_digest_key: alerta.relevancia_digest_key || null,
    contexto_mia_digest: alerta.contexto_mia_digest || null,
    fact_sheet_status: alerta.fact_sheet_status || alerta.fact_sheet?.status || null,
    truth_score: normalizarNumero(alerta.truth_score ?? alerta.fact_sheet?.truth_score),
    risk_score: normalizarNumero(alerta.risk_score ?? alerta.fact_sheet?.risk_score),
    evidence_coverage: normalizarNumero(alerta.evidence_coverage ?? alerta.fact_sheet?.evidence_coverage),
    final_validation_status: alerta.final_validation_status || finalValidation.status || null,
    final_validation_flags: Array.isArray(alerta.final_validation_flags)
      ? alerta.final_validation_flags
      : (Array.isArray(finalValidation.flags) ? finalValidation.flags : []),
    final_validation_reasons: Array.isArray(alerta.final_validation_reasons)
      ? alerta.final_validation_reasons
      : (Array.isArray(finalValidation.reasons) ? finalValidation.reasons : []),
    critical_double_check: alerta.critical_double_check || finalValidation.critical_double_check || null,
    shadow_decision: alerta.shadow_decision || null,
    final_validation_decision: effectiveSendGate.final_validation_decision || null,
    effective_send_decision: effectiveSendGate.effective_send_decision || 'blocked',
    effective_reason: effectiveSendGate.effective_reason || 'effective_send_decision_missing',
    effective_gate_version: effectiveSendGate.gate_version || null,
    automatic_send_allowed: effectiveSendGate.automatic_send_allowed === true
      && effectiveSendGate.final_validation_decision?.status === 'send',
  };
}

function motivoSeleccion(alerta = {}, origen = 'desconocido') {
  const motivo = String(alerta.motivo_seleccion_mia || '').trim();
  if (motivo) {
    if (motivo === origen || motivo.startsWith(`${origen}:`)) return motivo.slice(0, 240);
    return `${origen}:${motivo}`.slice(0, 240);
  }
  return origen;
}

function normalizarNumero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decisionDigest(alerta = {}) {
  return alerta.decision_digest && typeof alerta.decision_digest === 'object'
    ? alerta.decision_digest
    : null;
}

function scoreDecision(alerta = {}) {
  return normalizarNumero(decisionDigest(alerta)?.score);
}

function scoreSeleccion(alerta = {}) {
  const decisionScore = scoreDecision(alerta);
  if (decisionScore !== null) return decisionScore;
  return normalizarNumero(alerta.similitud);
}

function construirDigestItems({
  digestId,
  userId,
  fecha,
  alertas = [],
  origen = 'desconocido',
  organizationId = null,
}) {
  return (alertas || [])
    .map((alerta, index) => conOrganizationId({
      digest_id: digestId,
      user_id: userId,
      fecha,
      item_numero: index + 1,
      alerta_id: alerta.id,
      score: scoreSeleccion(alerta),
      motivo_seleccion: motivoSeleccion(alerta, origen),
      resumen_usado: resumenUsado(alerta),
      tags_json: tagsAlerta(alerta),
      selection_score: scoreDecision(alerta),
      selection_action: decisionDigest(alerta)?.action || (decisionDigest(alerta)?.incluir ? 'include' : null),
      selection_reason: decisionDigest(alerta)?.motivo || null,
      selection_risk: decisionDigest(alerta)?.riesgo || null,
      similarity_score: normalizarNumero(alerta.similitud),
      selection_decision: decisionDigest(alerta) || {},
    }, organizationId))
    .filter((row) => row.digest_id && row.user_id && row.alerta_id && row.item_numero > 0);
}

async function registrarDigestItemsMIA(supabase, options = {}) {
  const rows = construirDigestItems(options);
  if (rows.length === 0) return { ok: true, available: true, inserted: 0 };

  try {
    const { error } = await supabase
      .from('digest_items')
      .upsert(rows, { onConflict: 'digest_id,item_numero' });

    if (error) throw error;
    return { ok: true, available: true, inserted: rows.length };
  } catch (error) {
    console.warn('[mia:digest_items] No se pudieron registrar digest_items:', error.message);
    return {
      ok: false,
      available: false,
      inserted: 0,
      error: error.message,
    };
  }
}

async function cargarDigestItemsMIA(supabase, digestId) {
  if (!digestId) return null;

  try {
    const { data, error } = await supabase
      .from('digest_items')
      .select('item_numero, alerta_id, score, motivo_seleccion, resumen_usado, tags_json, selection_score, selection_action, selection_reason, selection_risk, similarity_score, selection_decision')
      .eq('digest_id', digestId)
      .order('item_numero', { ascending: true });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.warn('[mia:digest_items] No se pudieron cargar digest_items:', error.message);
    return null;
  }
}

module.exports = {
  construirDigestItems,
  registrarDigestItemsMIA,
  cargarDigestItemsMIA,
};
