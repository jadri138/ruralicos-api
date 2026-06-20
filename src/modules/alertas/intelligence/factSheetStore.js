const { conOrganizationId } = require('../../mia/organizationContext');
const {
  FACT_SHEET_SCHEMA_VERSION,
  FACT_SHEET_BUILDER_VERSION,
} = require('./factSheetSchema');

const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);

function esTablaNoDisponible(error) {
  return MISSING_TABLE_CODES.has(error?.code);
}

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

function limpiarRowLegacy(row = {}) {
  const {
    truth_score,
    risk_score,
    evidence_coverage,
    source_trace,
    shadow_decision,
    enforcement_mode,
    organization_id,
    ...legacy
  } = row;
  return legacy;
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
    if (error?.code === '42703') {
      try {
        const legacyRow = limpiarRowLegacy(row);
        const { error: legacyError } = await supabase
          .from('alert_fact_sheets')
          .upsert(legacyRow, { onConflict: 'alerta_id,schema_version,builder_version' });

        if (legacyError) throw legacyError;
        return {
          ok: true,
          available: true,
          stored: true,
          row: legacyRow,
          warning: 'alert_fact_sheets_audit_columns_missing',
        };
      } catch (legacyError) {
        if (esTablaNoDisponible(legacyError)) {
          return { ok: true, available: false, stored: false, reason: 'alert_fact_sheets_no_disponible' };
        }
        return { ok: false, available: false, stored: false, error: legacyError.message };
      }
    }

    if (esTablaNoDisponible(error)) {
      return { ok: true, available: false, stored: false, reason: 'alert_fact_sheets_no_disponible' };
    }

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
    if (esTablaNoDisponible(error)) return null;
    return null;
  }
}

module.exports = {
  esTablaNoDisponible,
  construirFactSheetRow,
  guardarFactSheetShadow,
  cargarFactSheetActual,
};

