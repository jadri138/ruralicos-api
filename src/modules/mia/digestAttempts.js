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
    updated_at: new Date().toISOString(),
  };

  // El registro es un upsert (user_id, fecha, kind): solo se incluyen las columnas
  // que el llamador pasa explicitamente. Un re-registro parcial (p.ej. un segundo
  // cron marcando 'skipped_existing') NO debe machacar a 0 el embudo ni la metadata
  // que escribio la pasada 'generated' (bug observado en produccion, jul-2026).
  const incluirEntero = (col, ...keys) => {
    for (const key of keys) {
      if (key in input) {
        row[col] = normalizarEntero(input[key]);
        return;
      }
    }
  };
  const incluirTexto = (col, max, ...keys) => {
    for (const key of keys) {
      if (key in input) {
        row[col] = normalizarTexto(input[key], max);
        return;
      }
    }
  };

  incluirEntero('total_alertas_dia', 'total_alertas_dia', 'totalAlertasDia');
  incluirEntero('total_alertas_ventana', 'total_alertas_ventana', 'totalAlertasVentana');
  incluirEntero('tras_quality_gate', 'tras_quality_gate', 'trasQualityGate');
  incluirEntero('tras_filtro_usuario', 'tras_filtro_usuario', 'trasFiltroUsuario');
  incluirEntero('tras_scoring', 'tras_scoring', 'trasScoring');
  incluirEntero('alertas_finales', 'alertas_finales', 'alertasFinales');
  incluirTexto('motivo_no_envio', 240, 'motivo_no_envio', 'motivoNoEnvio');
  incluirTexto('error_msg', 800, 'error_msg', 'errorMsg');
  if (input.metadata_json !== undefined || input.metadata !== undefined) {
    row.metadata_json = normalizarJson(input.metadata_json || input.metadata);
  }

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
    console.warn('[digest_attempts] No se pudo registrar intento:', error.message);
    return { ok: false, available: false, error: error.message };
  }
}

function seleccionarDigestAttemptCanonico(attempts = []) {
  const statusPriority = {
    rescued: 60,
    generated: 50,
    evaluating: 40,
    sent: 30,
    failed: 20,
    skipped_existing: 10,
    no_send: 0,
  };

  return [...attempts]
    .filter((attempt) => attempt?.id)
    .sort((a, b) => {
      // Un rescate sustituye al intento diario sin coincidencias. Si por datos
      // historicos ambos quedaron enlazados al mismo digest, solo el rescate
      // representa el envio real.
      const rescueDiff = Number(b.kind === 'rescue') - Number(a.kind === 'rescue');
      if (rescueDiff !== 0) return rescueDiff;
      const statusDiff = (statusPriority[b.status] ?? -1) - (statusPriority[a.status] ?? -1);
      if (statusDiff !== 0) return statusDiff;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    })[0] || null;
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
    const { data: attempts, error: lookupError } = await supabase
      .from('digest_attempts')
      .select('id, kind, status, created_at')
      .eq('digest_id', digestId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (lookupError) throw lookupError;
    const canonical = seleccionarDigestAttemptCanonico(attempts);
    if (!canonical) {
      return { ok: false, available: true, reason: 'digest_attempt_not_found' };
    }

    const { error } = await supabase
      .from('digest_attempts')
      .update(row)
      .eq('id', canonical.id);

    if (error) throw error;
    return { ok: true, available: true, id: canonical.id };
  } catch (error) {
    console.warn('[digest_attempts] No se pudo actualizar intento:', error.message);
    return { ok: false, available: false, error: error.message };
  }
}

module.exports = {
  actualizarDigestAttemptPorDigest,
  construirDigestAttemptRow,
  registrarDigestAttempt,
  seleccionarDigestAttemptCanonico,
};
