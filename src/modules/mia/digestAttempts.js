// Versiona la decision completa del digest, no solo el esquema de la fila.
// Al cambiar filtros/validadores, subir esta version permite reevaluar una vez
// los no-envios antiguos sin tocar digests ya generados o enviados.
// Subir esta versión cuando cambie la lógica de decisión: un `no_send` o un
// `failed` de una versión anterior deja de considerarse terminal y esa persona
// se vuelve a evaluar el mismo día. Los estados que ya produjeron un mensaje
// (`sent`, `generated`, `rescued`, `skipped_existing`) siguen siendo inmutables,
// así que subirla nunca provoca un envío repetido.
// v9: las comunidades autónomas dejan de tratarse como provincia, así que las
// decisiones tomadas con la versión anterior bloqueaban territorio de más.
// v10: la auditoría consolida las decisiones repetidas de una misma alerta, que
// antes hacían fallar el lote entero y dejaban a esa persona sin digest.
// v11: el territorio deja de leerse del centinela "no_detectado" y pasa a
// derivarse del boletín cuando la alerta no lo declara. Cambia quién es
// elegible, así que los `no_send` de v10 -tomados con la barrera rota- no pueden
// seguir contando como decisión firme del día.
// v12: la barrera de evidencia deja de exigir beneficiarios y acción. Los
// silencios de v11 se tomaron reteniendo por un dato que el mensaje no afirma.
//
// AVISO PARA QUIEN TOQUE LA DECISIÓN: esta constante es manual y ya ha fallado
// dos veces (7-08-2026). Si cambias una barrera y no la subes, el cron devuelve
// `usuarios_evaluados: 0` y parece que el despliegue no ha servido de nada,
// porque los intentos del día ya cuentan como resueltos.
const DIGEST_DECISION_VERSION = 'digest_decision_v12_evidencia_minima';

const ESTADOS_TERMINALES_INMUTABLES = new Set([
  'generated',
  'rescued',
  'sent',
  'skipped_existing',
]);

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
  incluirEntero('judge_evaluated_count', 'judge_evaluated_count', 'judgeEvaluatedCount');
  incluirEntero('approved_count', 'approved_count', 'approvedCount');
  incluirEntero('queued_count', 'queued_count', 'queuedCount');
  incluirEntero('delivered_count', 'delivered_count', 'deliveredCount');
  incluirTexto('motivo_no_envio', 240, 'motivo_no_envio', 'motivoNoEnvio');
  incluirTexto('error_msg', 800, 'error_msg', 'errorMsg');
  incluirTexto('delivery_status', 40, 'delivery_status', 'deliveryStatus');
  const metadata = normalizarJson(input.metadata_json || input.metadata);
  row.metadata_json = {
    ...metadata,
    decision_version: DIGEST_DECISION_VERSION,
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

// `alertasDelDiaAhora` es cuántas alertas hay listas para esa fecha en el momento
// de preguntar. Sirve para detectar un silencio decidido antes de que existiera
// el material del día: una pasada lanzada a las 00:01 de Madrid juzga a todo el
// mundo contra un día todavía vacío, lo sella, y cuando por la mañana llegan las
// alertas el cron se salta a esas personas (8-08-2026: 79 usuarios sellados con
// `total_alertas_dia = 0` y 6 alertas esperando sin evaluar).
function esDigestAttemptTerminalActual(attempt = {}, { alertasDelDiaAhora = null } = {}) {
  const status = normalizarTexto(attempt.status, 60);
  if (ESTADOS_TERMINALES_INMUTABLES.has(status)) return true;
  if (!['no_send', 'failed'].includes(status)) return false;
  if (attempt.metadata_json?.decision_version !== DIGEST_DECISION_VERSION) return false;

  // Solo se reabre si HOY hay más material del día que cuando se decidió. Si el
  // día sigue igual de vacío -un domingo de verdad-, la decisión se respeta y no
  // se reevalúa a nadie en balde.
  if (alertasDelDiaAhora !== null) {
    const decididoCon = normalizarEntero(attempt.total_alertas_dia, 0);
    if (normalizarEntero(alertasDelDiaAhora, 0) > decididoCon) return false;
  }
  return true;
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

// `evaluating` es un estado de paso: se escribe al empezar con una persona y lo
// sustituye el resultado. Si el proceso muere en medio -o lo mata el reinicio
// del contenedor- la fila se queda ahí para siempre y esa persona no se vuelve a
// evaluar. Al arrancar una pasada se cierran los intentos de días anteriores y
// los del propio día que llevan más de `staleMs` sin tocarse.
const EVALUATING_STALE_MS = 30 * 60 * 1000;

async function recuperarIntentosEvaluandoAtascados(supabase, {
  fecha,
  staleMs = EVALUATING_STALE_MS,
  now = new Date(),
} = {}) {
  if (!supabase?.from || !fecha) return { ok: false, available: false, recovered: 0 };
  const limite = new Date(new Date(now).getTime() - Math.max(60000, Number(staleMs) || 0)).toISOString();

  try {
    const { data, error } = await supabase
      .from('digest_attempts')
      .update({
        status: 'failed',
        motivo_no_envio: 'evaluating_interrumpido_recuperado',
        error_msg: 'El intento quedo en evaluating: el proceso no llego a cerrarlo.',
        updated_at: new Date(now).toISOString(),
      })
      .eq('status', 'evaluating')
      .lte('fecha', fecha)
      .lt('updated_at', limite)
      .select('id, user_id, fecha');

    if (error) throw error;
    const recuperados = Array.isArray(data) ? data : [];
    if (recuperados.length > 0) {
      console.warn(`[digest_attempts] ${recuperados.length} intento(s) atascado(s) en evaluating recuperados`);
    }
    return { ok: true, available: true, recovered: recuperados.length, attempts: recuperados };
  } catch (error) {
    console.warn('[digest_attempts] No se pudieron recuperar intentos en evaluating:', error.message);
    return { ok: false, available: false, recovered: 0, error: error.message };
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
  if (patch.delivery_status !== undefined || patch.deliveryStatus !== undefined) {
    row.delivery_status = normalizarTexto(
      patch.delivery_status ?? patch.deliveryStatus,
      40
    );
  }
  for (const [column, camel] of [
    ['judge_evaluated_count', 'judgeEvaluatedCount'],
    ['approved_count', 'approvedCount'],
    ['queued_count', 'queuedCount'],
    ['delivered_count', 'deliveredCount'],
  ]) {
    if (patch[column] !== undefined || patch[camel] !== undefined) {
      row[column] = normalizarEntero(patch[column] ?? patch[camel]);
    }
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
  DIGEST_DECISION_VERSION,
  EVALUATING_STALE_MS,
  actualizarDigestAttemptPorDigest,
  construirDigestAttemptRow,
  esDigestAttemptTerminalActual,
  recuperarIntentosEvaluandoAtascados,
  registrarDigestAttempt,
  seleccionarDigestAttemptCanonico,
};
