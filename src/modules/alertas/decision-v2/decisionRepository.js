const ALERT_SELECT = [
  'id',
  'titulo',
  'url',
  'fecha',
  'region',
  'fuente',
  'resumen',
  'resumen_final',
  'contenido',
  'provincias',
  'sectores',
  'subsectores',
  'tipos_alerta',
  'estado_ia',
  'duplicado_de',
  'organization_id',
  'created_at',
  'taxonomy_tags',
  'pre_score',
  'pre_status',
  'candidate_level',
].join(', ');

const USER_SELECT = [
  'id',
  'name',
  'first_name',
  'legal_name',
  'phone_verified',
  'subscription',
  'preferences',
  'preferencias_extra',
  'organization_id',
].join(', ');

const RAW_DOCUMENT_SELECT = [
  'id',
  'inserted_alerta_id',
  'fuente',
  'region',
  'fecha',
  'titulo',
  'url',
  'url_html',
  'url_pdf',
  'organismo',
  'boletin',
  'id_oficial',
  'texto_raw',
  'contenido_hash',
  'url_hash',
  'capture_status',
  'created_at',
].join(', ');

function chunks(values = [], size = 100) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function assertNoError(error, context) {
  if (!error) return;
  const wrapped = new Error(`${context}: ${error.message || 'error Supabase'}`);
  wrapped.code = error.code || null;
  wrapped.details = error.details || null;
  throw wrapped;
}

function puntuacionDocumentoOficial(document = {}) {
  const content = String(document.texto_raw || '').trim();
  const urls = [document.url_pdf, document.url_html, document.url]
    .map((value) => String(value || '').trim());
  return (content.length >= 100 ? 2 : content.length > 0 ? 1 : 0) +
    (urls.some((value) => /^https?:\/\//i.test(value)) ? 1 : 0);
}

async function cargarUsuariosPendientesShadow(supabase, {
  workflowRunKey,
  batchSize = 1,
} = {}) {
  const existing = await supabase
    .from('shadow_digest_runs')
    .select('user_id')
    .eq('workflow_run_key', workflowRunKey);
  assertNoError(existing.error, 'No se pudieron consultar ejecuciones shadow existentes');
  const completed = new Set((existing.data || []).map((row) => Number(row.user_id)));

  const users = await supabase
    .from('users')
    .select(USER_SELECT)
    .in('subscription', ['corral', 'agricultor', 'cooperativa'])
    .or('phone_verified.is.null,phone_verified.eq.true')
    .order('id', { ascending: true });
  assertNoError(users.error, 'No se pudieron cargar los perfiles reales');

  const safeLimit = Math.max(1, Math.min(25, Number(batchSize) || 1));
  return (users.data || [])
    .filter((user) => !completed.has(Number(user.id)))
    .slice(0, safeLimit);
}

async function cargarAlertasPeriodoShadow(supabase, { workflowDate } = {}) {
  const result = await supabase
    .from('alertas')
    .select(ALERT_SELECT)
    .eq('fecha', workflowDate)
    .order('id', { ascending: true });
  assertNoError(result.error, 'No se pudieron cargar todas las alertas ingeridas del periodo');
  return result.data || [];
}

async function cargarDocumentosOficialesShadow(supabase, alertIds = []) {
  const ids = [...new Set(alertIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const byAlert = new Map();
  for (const group of chunks(ids, 100)) {
    const result = await supabase
      .from('raw_documents')
      .select(RAW_DOCUMENT_SELECT)
      .in('inserted_alerta_id', group)
      .order('created_at', { ascending: false });
    assertNoError(result.error, 'No se pudieron cargar documentos oficiales');
    for (const document of result.data || []) {
      const alertId = Number(document.inserted_alerta_id);
      const current = byAlert.get(alertId);
      if (!current || puntuacionDocumentoOficial(document) > puntuacionDocumentoOficial(current)) {
        byAlert.set(alertId, document);
      }
    }
  }
  return byAlert;
}

async function cargarHistorialEnviadoShadow(supabase, userIds = []) {
  const ids = [...new Set(userIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const byUser = new Map(ids.map((id) => [id, new Set()]));
  if (ids.length === 0) return byUser;

  let result = await supabase
    .from('digests')
    .select('user_id, alerta_ids, delivery_status, enviado')
    .in('user_id', ids)
    .or('delivery_status.in.(DELIVERED,READ),enviado.eq.true');

  if (result.error && /delivery_status/i.test(result.error.message || '')) {
    result = await supabase
      .from('digests')
      .select('user_id, alerta_ids, enviado')
      .in('user_id', ids)
      .eq('enviado', true);
  }
  assertNoError(result.error, 'No se pudo cargar el historial usuario-alerta enviado');
  for (const digest of result.data || []) {
    const userId = Number(digest.user_id);
    if (!byUser.has(userId)) byUser.set(userId, new Set());
    for (const alertId of Array.isArray(digest.alerta_ids) ? digest.alerta_ids : []) {
      const number = Number(alertId);
      if (Number.isSafeInteger(number) && number > 0) byUser.get(userId).add(number);
    }
  }
  return byUser;
}

async function reclamarShadowRun(supabase, {
  shadowRunId,
  workflowRunKey,
  workflowDate,
  user,
  engineVersion,
  contractVersion,
  promptVersion,
  renderVersion,
  model,
  maxIncluded,
} = {}) {
  const row = {
    shadow_run_id: shadowRunId,
    workflow_run_key: workflowRunKey,
    workflow_date: workflowDate,
    user_id: user.id,
    organization_id: user.organization_id || null,
    status: 'ERROR',
    engine_version: engineVersion,
    contract_version: contractVersion,
    prompt_version: promptVersion,
    render_version: renderVersion,
    model,
    max_included: maxIncluded,
    error_code: 'RUNNING',
    error_message: 'Ejecucion reclamada; pendiente de finalizar.',
  };
  const result = await supabase
    .from('shadow_digest_runs')
    .insert([row])
    .select('shadow_run_id')
    .single();
  if (!result.error) return { claimed: true, shadowRunId: result.data?.shadow_run_id || shadowRunId };
  if (result.error.code !== '23505') {
    assertNoError(result.error, 'No se pudo reclamar la ejecucion shadow');
  }

  const existing = await supabase
    .from('shadow_digest_runs')
    .select('shadow_run_id, status')
    .eq('workflow_run_key', workflowRunKey)
    .eq('user_id', user.id)
    .maybeSingle();
  assertNoError(existing.error, 'No se pudo recuperar la ejecucion shadow idempotente');
  return {
    claimed: false,
    shadowRunId: existing.data?.shadow_run_id || null,
    status: existing.data?.status || null,
  };
}

async function insertarPorLotes(supabase, table, rows = [], size = 250) {
  for (const group of chunks(rows, size)) {
    if (group.length === 0) continue;
    const result = await supabase.from(table).insert(group);
    assertNoError(result.error, `No se pudieron insertar filas en ${table}`);
  }
}

async function actualizarShadowRun(supabase, shadowRunId, values) {
  const result = await supabase
    .from('shadow_digest_runs')
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq('shadow_run_id', shadowRunId);
  assertNoError(result.error, 'No se pudo finalizar shadow_digest_runs');
}

async function persistirResultadoShadow(supabase, {
  shadowRunId,
  workflowDate,
  user,
  engineResult,
  rendered = null,
} = {}) {
  const decisions = (engineResult.decisions || []).map((decision) => ({
    shadow_run_id: shadowRunId,
    workflow_date: workflowDate,
    user_id: user.id,
    organization_id: user.organization_id || null,
    alert_id: decision.alert_id,
    input_position: decision.input_position,
    decision_position: decision.decision_position,
    decision_source: decision.decision_source,
    alert_snapshot: decision.alert_snapshot,
    objective_filters: decision.objective_filters,
    decision: decision.decision,
    priority: decision.priority,
    reason: decision.reason,
    evidence: decision.evidence,
  }));
  const decisionById = new Map(decisions.map((decision) => [Number(decision.alert_id), decision]));
  const items = (rendered?.items || []).map((item, index) => {
    const decision = decisionById.get(Number(item.alert_id));
    return {
      shadow_run_id: shadowRunId,
      workflow_date: workflowDate,
      user_id: user.id,
      organization_id: user.organization_id || null,
      alert_id: item.alert_id,
      final_position: index + 1,
      alert_snapshot: decision?.alert_snapshot || {},
      decision_snapshot: {
        decision: decision?.decision || 'include',
        priority: decision?.priority || index + 1,
        reason: decision?.reason || null,
        evidence: decision?.evidence || [],
      },
      rendered_block: item.rendered_block,
    };
  });

  try {
    await insertarPorLotes(supabase, 'shadow_candidate_decisions', decisions);
    await insertarPorLotes(supabase, 'shadow_digest_items', items);
    await actualizarShadowRun(supabase, shadowRunId, {
      status: engineResult.status,
      profile_snapshot: engineResult.profile_snapshot,
      candidates_snapshot: engineResult.candidates_snapshot,
      objective_filter_summary: engineResult.objective_filter_summary,
      policy_snapshot: engineResult.policy_snapshot,
      system_prompt: engineResult.system_prompt,
      prompt_text: engineResult.prompt_text,
      retry_prompt_text: engineResult.retry_prompt_text,
      llm_input: engineResult.llm_input,
      llm_raw_response: engineResult.llm_raw_response,
      llm_raw_responses: engineResult.llm_raw_responses,
      llm_normalized_response: engineResult.llm_normalized_response,
      llm_attempts: engineResult.llm_attempts,
      usage_json: engineResult.usage_json,
      error_code: engineResult.error_code,
      error_message: engineResult.error_message,
      error_details: engineResult.error_details,
      mensaje_preview: rendered?.message || null,
      counts_json: {
        alerts_in_period: engineResult.candidates_snapshot.length,
        objective_excluded: decisions.filter((item) => item.decision_source === 'objective_filter').length,
        llm_candidates: decisions.filter((item) => item.decision_source !== 'objective_filter').length,
        included: decisions.filter((item) => item.decision === 'include').length,
        excluded: decisions.filter((item) => item.decision === 'exclude').length,
        technical_errors: decisions.filter((item) => item.decision_source === 'technical_error').length,
        duplicate_input_rows: engineResult.duplicate_input_count || 0,
        luna_review_recommended: engineResult.usage_json?.routing?.escalation_recommended === true,
        luna_review_used: engineResult.usage_json?.routing?.escalation_used === true,
      },
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    try {
      await actualizarShadowRun(supabase, shadowRunId, {
        status: 'ERROR',
        error_code: 'shadow_persistence_error',
        error_message: String(error.message || error).slice(0, 1000),
        error_details: { code: error.code || null, details: error.details || null },
        finished_at: new Date().toISOString(),
      });
    } catch {
      // El error original conserva el contexto mas util.
    }
    throw error;
  }

  return { decisions: decisions.length, items: items.length };
}

module.exports = {
  ALERT_SELECT,
  USER_SELECT,
  RAW_DOCUMENT_SELECT,
  chunks,
  puntuacionDocumentoOficial,
  cargarUsuariosPendientesShadow,
  cargarAlertasPeriodoShadow,
  cargarDocumentosOficialesShadow,
  cargarHistorialEnviadoShadow,
  reclamarShadowRun,
  persistirResultadoShadow,
};
