const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);

function esTablaNoDisponible(error) {
  return MISSING_TABLE_CODES.has(error?.code);
}

function normalizarEntero(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function normalizarTexto(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function normalizarJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function construirDigestAttemptRow(input = {}) {
  const userId = input.user_id ?? input.userId;
  const fecha = input.fecha;
  const kind = normalizarTexto(input.kind || 'daily', 60) || 'daily';
  const status = normalizarTexto(input.status || 'unknown', 60) || 'unknown';

  const row = {
    user_id: userId,
    fecha,
    kind,
    status,
    total_alertas_dia: normalizarEntero(input.total_alertas_dia ?? input.totalAlertasDia),
    total_alertas_ventana: normalizarEntero(input.total_alertas_ventana ?? input.totalAlertasVentana),
    tras_quality_gate: normalizarEntero(input.tras_quality_gate ?? input.trasQualityGate),
    tras_filtro_usuario: normalizarEntero(input.tras_filtro_usuario ?? input.trasFiltroUsuario),
    tras_scoring: normalizarEntero(input.tras_scoring ?? input.trasScoring),
    alertas_finales: normalizarEntero(input.alertas_finales ?? input.alertasFinales),
    motivo_no_envio: normalizarTexto(input.motivo_no_envio ?? input.motivoNoEnvio, 240),
    error_msg: normalizarTexto(input.error_msg ?? input.errorMsg, 800),
    metadata_json: normalizarJson(input.metadata_json || input.metadata),
    updated_at: new Date().toISOString(),
  };

  const organizationId = input.organization_id ?? input.organizationId;
  if (organizationId !== undefined && organizationId !== null && organizationId !== '') {
    row.organization_id = organizationId;
  }

  const digestId = input.digest_id ?? input.digestId;
  if (digestId !== undefined && digestId !== null && digestId !== '') {
    row.digest_id = digestId;
  }

  return row;
}

async function registrarDigestAttempt(supabase, input = {}) {
  const row = construirDigestAttemptRow(input);
  if (!supabase || !row.user_id || !row.fecha) {
    return { ok: false, available: false, reason: 'invalid_digest_attempt' };
  }

  try {
    const upsertQuery = supabase
      .from('digest_attempts')
      .upsert(row, { onConflict: 'user_id,fecha,kind' });
    let result;
    if (typeof upsertQuery?.select === 'function') {
      const selectQuery = upsertQuery.select('id');
      result = typeof selectQuery?.maybeSingle === 'function'
        ? await selectQuery.maybeSingle()
        : await selectQuery;
    } else {
      result = await upsertQuery;
    }
    const { data, error } = result || {};

    if (error) throw error;
    return {
      ok: true,
      available: true,
      id: data?.id || (Array.isArray(data) ? data[0]?.id : null) || null,
      row,
    };
  } catch (error) {
    if (esTablaNoDisponible(error)) {
      return { ok: true, available: false, reason: 'digest_attempts_no_disponible' };
    }

    console.warn('[digest_attempts] No se pudo registrar intento:', error.message);
    return { ok: false, available: false, error: error.message };
  }
}

async function actualizarDigestAttemptPorDigest(supabase, digestId, patch = {}) {
  if (!supabase || !digestId) {
    return { ok: false, available: false, reason: 'invalid_digest_attempt_update' };
  }

  const row = {};
  if (patch.status !== undefined) row.status = normalizarTexto(patch.status, 60) || 'unknown';
  if (patch.motivo_no_envio !== undefined || patch.motivoNoEnvio !== undefined) {
    row.motivo_no_envio = normalizarTexto(patch.motivo_no_envio ?? patch.motivoNoEnvio, 240);
  }
  if (patch.error_msg !== undefined || patch.errorMsg !== undefined) {
    row.error_msg = normalizarTexto(patch.error_msg ?? patch.errorMsg, 800);
  }
  if (patch.metadata_json !== undefined || patch.metadata !== undefined) {
    row.metadata_json = normalizarJson(patch.metadata_json || patch.metadata);
  }
  row.updated_at = new Date().toISOString();

  try {
    const { error } = await supabase
      .from('digest_attempts')
      .update(row)
      .eq('digest_id', digestId);

    if (error) throw error;
    return { ok: true, available: true };
  } catch (error) {
    if (esTablaNoDisponible(error)) {
      return { ok: true, available: false, reason: 'digest_attempts_no_disponible' };
    }

    console.warn('[digest_attempts] No se pudo actualizar intento:', error.message);
    return { ok: false, available: false, error: error.message };
  }
}

module.exports = {
  actualizarDigestAttemptPorDigest,
  construirDigestAttemptRow,
  registrarDigestAttempt,
};
