const { conOrganizationId } = require('../../mia/organizationContext');
const {
  FACT_SHEET_SCHEMA_VERSION,
  FACT_SHEET_BUILDER_VERSION,
} = require('./factSheetSchema');

function normalizarNumero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizarJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizarJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function construirFactSheetRow({
  factSheet,
  organizationId = null,
  shadowDecision = null,
  enforcementMode = 'shadow',
} = {}) {
  if (!factSheet?.alerta_id) return null;

  return conOrganizationId({
    alerta_id: factSheet.alerta_id,
    schema_version: factSheet.schema_version || FACT_SHEET_SCHEMA_VERSION,
    builder_version: factSheet.builder_version || FACT_SHEET_BUILDER_VERSION,
    status: factSheet.status || 'unknown',
    truth_score: normalizarNumero(factSheet.truth_score),
    risk_score: normalizarNumero(factSheet.risk_score),
    evidence_coverage: normalizarNumero(factSheet.evidence_coverage),
    fact_sheet: normalizarJsonObject(factSheet),
    flags: normalizarJsonArray(factSheet.flags),
    reasons: normalizarJsonArray(factSheet.reasons),
    source_trace: normalizarJsonObject(factSheet.document_trace),
    shadow_decision: normalizarJsonObject(shadowDecision),
    enforcement_mode: enforcementMode || 'shadow',
    generated_at: factSheet.generated_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, organizationId);
}

async function guardarFactSheetShadow(supabase, options = {}) {
  const row = construirFactSheetRow(options);
  if (!supabase?.from || !row) {
    return { ok: false, available: false, stored: false, reason: 'invalid_fact_sheet_store_input' };
  }

  try {
    const { error } = await supabase
      .from('alert_fact_sheets')
      .upsert(row, { onConflict: 'alerta_id,schema_version,builder_version' });

    if (error) throw error;
    return { ok: true, available: true, stored: true, row };
  } catch (error) {
    return { ok: false, available: false, stored: false, error: error.message };
  }
}

async function cargarFactSheetActual(supabase, {
  alertaId,
  schemaVersion = FACT_SHEET_SCHEMA_VERSION,
  builderVersion = FACT_SHEET_BUILDER_VERSION,
} = {}) {
  if (!supabase?.from || !alertaId) return null;

  try {
    const { data, error } = await supabase
      .from('alert_fact_sheets')
      .select('fact_sheet, status, truth_score, risk_score, evidence_coverage, flags, reasons, shadow_decision, generated_at')
      .eq('alerta_id', alertaId)
      .eq('schema_version', schemaVersion)
      .eq('builder_version', builderVersion)
      .order('generated_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : null;
    return row?.fact_sheet || null;
  } catch (error) {
    return null;
  }
}

module.exports = {
  construirFactSheetRow,
  guardarFactSheetShadow,
  cargarFactSheetActual,
};

