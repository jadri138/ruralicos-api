function normalizarId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizarLimite(value, fallback = 20, max = 100) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

function normalizarFecha(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function mapByNumber(rows = [], field = 'id') {
  const map = new Map();
  for (const row of rows || []) {
    const id = Number(row?.[field]);
    if (Number.isFinite(id)) map.set(id, row);
  }
  return map;
}

function latestFactSheetsByAlerta(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const alertaId = Number(row?.alerta_id);
    if (!Number.isFinite(alertaId)) continue;
    const current = map.get(alertaId);
    if (!current || String(row.generated_at || '') > String(current.generated_at || '')) {
      map.set(alertaId, row);
    }
  }
  return map;
}

function tags(row = {}) {
  return row.tags_json && typeof row.tags_json === 'object' && !Array.isArray(row.tags_json)
    ? row.tags_json
    : {};
}

function construirWhyItem(row = {}, { alerta = null, factSheet = null } = {}) {
  const tagPayload = tags(row);
  const selection = row.selection_decision && Object.keys(row.selection_decision || {}).length
    ? row.selection_decision
    : tagPayload.selection || tagPayload.decision_digest || {};
  const finalStatus = row.final_validation_status ||
    tagPayload.final_validation_status ||
    tagPayload.contexto_mia_digest?.final_validation?.status ||
    null;
  const factStatus = tagPayload.fact_sheet_status || factSheet?.status || factSheet?.fact_sheet?.status || null;
  const shadowDecision = tagPayload.shadow_decision || factSheet?.shadow_decision || {};

  return {
    item_numero: row.item_numero,
    alerta_id: row.alerta_id,
    digest_item_id: row.id || null,
    score: row.selection_score ?? row.score ?? null,
    resumen_usado: row.resumen_usado || null,
    alerta: alerta ? {
      id: alerta.id,
      titulo: alerta.titulo,
      fuente: alerta.fuente || null,
      fecha: alerta.fecha || null,
      url: alerta.url || null,
      provincias: alerta.provincias || [],
      sectores: alerta.sectores || [],
      subsectores: alerta.subsectores || [],
      tipos_alerta: alerta.tipos_alerta || [],
    } : null,
    selection: {
      action: row.selection_action || selection.action || null,
      score: row.selection_score ?? selection.score ?? null,
      reason: row.selection_reason || selection.motivo || null,
      risk: row.selection_risk || selection.riesgo || null,
      decision: selection,
    },
    fact_sheet: {
      status: factStatus,
      truth_score: tagPayload.truth_score ?? factSheet?.truth_score ?? factSheet?.fact_sheet?.truth_score ?? null,
      risk_score: tagPayload.risk_score ?? factSheet?.risk_score ?? factSheet?.fact_sheet?.risk_score ?? null,
      evidence_coverage: tagPayload.evidence_coverage ?? factSheet?.evidence_coverage ?? factSheet?.fact_sheet?.evidence_coverage ?? null,
      flags: tagPayload.contexto_mia_digest?.fact_sheet?.flags || factSheet?.flags || factSheet?.fact_sheet?.flags || [],
      reasons: factSheet?.reasons || factSheet?.fact_sheet?.reasons || [],
    },
    final_validation: {
      status: finalStatus,
      flags: tagPayload.final_validation_flags || tagPayload.contexto_mia_digest?.final_validation?.flags || [],
      reasons: tagPayload.final_validation_reasons || tagPayload.contexto_mia_digest?.final_validation?.reasons || [],
    },
    shadow_decision: shadowDecision,
    explanation: {
      sent_because: [
        row.selection_action ? `selection:${row.selection_action}` : null,
        factStatus ? `fact_sheet:${factStatus}` : null,
        finalStatus ? `final_validation:${finalStatus}` : null,
      ].filter(Boolean),
      future_decision: shadowDecision.future_decision || null,
    },
  };
}

function construirWhySentDigest({
  digest = {},
  digestItems = [],
  alertas = [],
  factSheets = [],
  attempts = [],
} = {}) {
  const alertasById = mapByNumber(alertas, 'id');
  const factSheetsByAlerta = latestFactSheetsByAlerta(factSheets);
  const items = (digestItems || [])
    .filter((row) => Number(row.digest_id) === Number(digest.id))
    .sort((a, b) => Number(a.item_numero || 0) - Number(b.item_numero || 0))
    .map((row) => construirWhyItem(row, {
      alerta: alertasById.get(Number(row.alerta_id)) || null,
      factSheet: factSheetsByAlerta.get(Number(row.alerta_id)) || null,
    }));

  return {
    digest: {
      id: digest.id,
      user_id: digest.user_id,
      fecha: digest.fecha,
      enviado: Boolean(digest.enviado),
      enviado_at: digest.enviado_at || null,
      created_at: digest.created_at || null,
      alerta_ids: digest.alerta_ids || [],
      organization_id: digest.organization_id || null,
    },
    message_excerpt: String(digest.mensaje || '').slice(0, 1200),
    attempts: (attempts || []).filter((row) => Number(row.digest_id) === Number(digest.id)),
    items,
  };
}

function construirWhyNotSentAttempt(row = {}, user = null) {
  const metadata = row.metadata_json && typeof row.metadata_json === 'object' ? row.metadata_json : {};
  return {
    attempt: {
      id: row.id,
      user_id: row.user_id,
      fecha: row.fecha,
      kind: row.kind,
      status: row.status,
      digest_id: row.digest_id || null,
      motivo_no_envio: row.motivo_no_envio || null,
      error_msg: row.error_msg || null,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
    },
    user: user ? {
      id: user.id,
      name: user.legal_name || user.name || null,
      phone: user.phone || null,
      subscription: user.subscription || null,
      organization_id: user.organization_id || null,
    } : null,
    counters: {
      total_alertas_dia: row.total_alertas_dia || 0,
      total_alertas_ventana: row.total_alertas_ventana || 0,
      tras_quality_gate: row.tras_quality_gate || 0,
      tras_filtro_usuario: row.tras_filtro_usuario || 0,
      tras_scoring: row.tras_scoring || 0,
      alertas_finales: row.alertas_finales || 0,
    },
    final_validation: metadata.final_validation || null,
    final_validation_enforcement: metadata.final_validation_enforcement || null,
    metadata,
  };
}

function construirWhyNotSentResponse({ attempts = [], users = [] } = {}) {
  const usersById = mapByNumber(users, 'id');
  return (attempts || []).map((row) =>
    construirWhyNotSentAttempt(row, usersById.get(Number(row.user_id)) || null)
  );
}

function normalizarDigestExplainParams(query = {}) {
  return {
    digest_id: normalizarId(query.digest_id || query.digestId),
    user_id: normalizarId(query.user_id || query.userId),
    fecha: normalizarFecha(query.fecha),
    kind: query.kind ? String(query.kind).trim().slice(0, 60) : null,
    limit: normalizarLimite(query.limit),
  };
}

module.exports = {
  normalizarDigestExplainParams,
  latestFactSheetsByAlerta,
  construirWhyItem,
  construirWhySentDigest,
  construirWhyNotSentAttempt,
  construirWhyNotSentResponse,
};
