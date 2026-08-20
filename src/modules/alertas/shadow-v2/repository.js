const TABLES = Object.freeze({
  classifications: 'shadow_v2_alert_classifications',
  digestRuns: 'shadow_v2_digest_runs',
  digestItems: 'shadow_v2_digest_items',
});

const ALERT_SELECT = [
  'id',
  'titulo',
  'url',
  'fecha',
  'region',
  'fuente',
  'contenido',
  'duplicado_de',
  'created_at',
].join(', ');

const USER_SELECT = [
  'id',
  'name',
  'first_name',
  'last_name_1',
  'last_name_2',
  'legal_name',
  'phone',
  'email',
  'phone_verified',
  'subscription',
  'preferences',
  'preferencias_extra',
  'organization_id',
  'created_at',
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
  'seccion',
  'boletin',
  'id_oficial',
  'texto_raw',
  'metadata_json',
  'capture_status',
  'created_at',
].join(', ');

function assertNoError(error, context) {
  if (!error) return;
  const wrapped = new Error(`${context}: ${error.message || 'error Supabase'}`);
  wrapped.code = error.code || null;
  wrapped.details = error.details || null;
  throw wrapped;
}

function chunks(values = [], size = 100) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function buildLearnedProfiles(rows = [], userIds = []) {
  const grouped = new Map(userIds.map((id) => [Number(id), []]));
  for (const row of rows || []) {
    const userId = Number(row.user_id);
    const score = Number(row.score || 0);
    if (!grouped.has(userId) || !String(row.tag || '').trim() || !Number.isFinite(score) || score === 0) continue;
    grouped.get(userId).push({
      tag: String(row.tag).trim(),
      score,
      positivos: Number(row.positivos || 0),
      negativos: Number(row.negativos || 0),
    });
  }

  return new Map([...grouped.entries()].map(([userId, items]) => [userId, {
    interests: items.filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score).slice(0, 8),
    dislikes: items.filter((item) => item.score < 0)
      .sort((a, b) => a.score - b.score).slice(0, 8),
  }]));
}

async function loadLearnedProfiles(supabase, userIds = []) {
  const rows = [];
  for (const group of chunks(userIds.map(Number).filter(Number.isSafeInteger), 100)) {
    if (group.length === 0) continue;
    const result = await supabase.from('user_interest_profile')
      .select('user_id, tag, score, positivos, negativos')
      .in('user_id', group);
    assertNoError(result.error, 'No se pudo cargar el aprendizaje de MIA para shadow-v2');
    rows.push(...(result.data || []));
  }
  return buildLearnedProfiles(rows, userIds);
}

function documentQuality(document = {}) {
  const contentLength = String(document.texto_raw || '').trim().length;
  const url = document.url_pdf || document.url_html || document.url;
  return (contentLength >= 500 ? 4 : contentLength > 0 ? 2 : 0)
    + (/^https?:\/\//i.test(String(url || '')) ? 1 : 0);
}

function officialSnapshot(alert, document, maxOfficialChars) {
  const metadata = document?.metadata_json && typeof document.metadata_json === 'object'
    && !Array.isArray(document.metadata_json) ? document.metadata_json : {};
  const content = String(document?.texto_raw || alert.contenido || '').trim();
  return {
    alert_id: Number(alert.id),
    title: document?.titulo || alert.titulo || null,
    organization: document?.organismo || metadata.organismo || null,
    source: document?.fuente || alert.fuente || null,
    date: document?.fecha || alert.fecha || null,
    official_url: document?.url_pdf || document?.url_html || document?.url || alert.url || null,
    official_content: content.slice(0, maxOfficialChars),
    official_content_original_chars: content.length,
    official_content_truncated: content.length > maxOfficialChars,
    duplicate_of: alert.duplicado_de ?? null,
    raw_document_id: document?.id || null,
    region_hint: document?.region || alert.region || null,
    section: document?.seccion || metadata.seccion || null,
    bulletin: document?.boletin || metadata.boletin || null,
    official_id: document?.id_oficial || metadata.id_oficial || null,
  };
}

async function loadExistingClassificationIds(supabase, workflowRunKey, workflowDate) {
  const result = await supabase.from(TABLES.classifications)
    .select('alert_id, workflow_date').eq('workflow_run_key', workflowRunKey);
  assertNoError(result.error, 'No se pudieron consultar clasificaciones shadow existentes');
  if ((result.data || []).some((row) => row.workflow_date !== workflowDate)) {
    throw new Error('La run key ya pertenece a otra fecha');
  }
  return new Set((result.data || []).map((row) => Number(row.alert_id)));
}

async function loadAlerts(supabase, { workflowDate }) {
  const result = await supabase.from('alertas').select(ALERT_SELECT)
    .eq('fecha', workflowDate).order('id', { ascending: true });
  assertNoError(result.error, 'No se pudieron cargar alertas para shadow-v2');
  return result.data || [];
}

async function loadOfficialDocuments(supabase, alertIds = []) {
  const byAlert = new Map();
  for (const group of chunks(alertIds, 100)) {
    if (group.length === 0) continue;
    const result = await supabase.from('raw_documents').select(RAW_DOCUMENT_SELECT)
      .in('inserted_alerta_id', group).order('created_at', { ascending: false });
    assertNoError(result.error, 'No se pudieron cargar documentos oficiales');
    for (const document of result.data || []) {
      const alertId = Number(document.inserted_alerta_id);
      const current = byAlert.get(alertId);
      if (!current || documentQuality(document) > documentQuality(current)) byAlert.set(alertId, document);
    }
  }
  return byAlert;
}

async function insertClassification(supabase, row) {
  const result = await supabase.from(TABLES.classifications).insert([row]);
  assertNoError(result.error, 'No se pudo persistir la clasificacion shadow-v2');
}

async function loadSuccessfulClassifications(supabase, workflowRunKey) {
  const result = await supabase.from(TABLES.classifications)
    .select('alert_id, official_snapshot, classification, normalized_response')
    .eq('workflow_run_key', workflowRunKey).eq('status', 'SUCCESS').eq('ai1_called', true)
    .order('alert_id', { ascending: true });
  assertNoError(result.error, 'No se pudieron cargar fichas IA 1');
  return (result.data || []).map((row) => ({
    alert_id: Number(row.alert_id),
    official_snapshot: row.official_snapshot,
    card: row.normalized_response,
    send_gate: row.classification?.send_gate || null,
  }));
}

async function loadExistingDigestUserIds(supabase, workflowRunKey, workflowDate) {
  const result = await supabase.from(TABLES.digestRuns)
    .select('user_id, workflow_date').eq('workflow_run_key', workflowRunKey);
  assertNoError(result.error, 'No se pudieron consultar digest runs existentes');
  if ((result.data || []).some((row) => row.workflow_date !== workflowDate)) {
    throw new Error('La run key ya pertenece a otra fecha');
  }
  return new Set((result.data || []).map((row) => Number(row.user_id)));
}

async function loadUsers(supabase) {
  const result = await supabase.from('users').select(USER_SELECT)
    .or('phone_verified.is.null,phone_verified.eq.true')
    .order('id', { ascending: true });
  assertNoError(result.error, 'No se pudieron cargar perfiles para shadow-v2');
  return result.data || [];
}

async function loadSentHistory(supabase, userIds = []) {
  const byUser = new Map(userIds.map((id) => [Number(id), new Set()]));
  const digestUserById = new Map();
  for (const group of chunks(userIds, 100)) {
    if (group.length === 0) continue;
    let result = await supabase.from('digests')
      .select('id, user_id, alerta_ids, delivery_status, enviado').in('user_id', group)
      .or('delivery_status.in.(DELIVERED,READ),enviado.eq.true');
    if (result.error && /delivery_status/i.test(result.error.message || '')) {
      result = await supabase.from('digests').select('id, user_id, alerta_ids, enviado')
        .in('user_id', group).eq('enviado', true);
    }
    assertNoError(result.error, 'No se pudo cargar el historial de envios');
    for (const digest of result.data || []) {
      digestUserById.set(Number(digest.id), Number(digest.user_id));
      const set = byUser.get(Number(digest.user_id)) || new Set();
      for (const alertId of Array.isArray(digest.alerta_ids) ? digest.alerta_ids : []) {
        const number = Number(alertId);
        if (Number.isSafeInteger(number)) set.add(number);
      }
      byUser.set(Number(digest.user_id), set);
    }
  }
  for (const group of chunks([...digestUserById.keys()], 100)) {
    if (group.length === 0) continue;
    const result = await supabase.from('digest_items')
      .select('digest_id, user_id, alerta_id').in('digest_id', group);
    assertNoError(result.error, 'No se pudo cargar el historial de digest_items');
    for (const item of result.data || []) {
      const userId = Number(item.user_id || digestUserById.get(Number(item.digest_id)));
      const alertId = Number(item.alerta_id);
      if (!byUser.has(userId) || !Number.isSafeInteger(alertId)) continue;
      byUser.get(userId).add(alertId);
    }
  }
  return byUser;
}

async function recordLimitEvent(supabase, {
  workflowRunKey,
  phase,
  reason,
  details = {},
} = {}) {
  const payload = { stop_reason: reason, stop_details: { phase, ...details } };
  const digest = await supabase.from(TABLES.digestRuns).select('id')
    .eq('workflow_run_key', workflowRunKey).order('created_at', { ascending: false })
    .limit(1).maybeSingle();
  assertNoError(digest.error, 'No se pudo buscar el ultimo digest run shadow-v2');
  if (digest.data?.id) {
    const updated = await supabase.from(TABLES.digestRuns).update(payload).eq('id', digest.data.id);
    assertNoError(updated.error, 'No se pudo registrar el limite en digest runs shadow-v2');
    return;
  }
  const classification = await supabase.from(TABLES.classifications).select('id')
    .eq('workflow_run_key', workflowRunKey).order('created_at', { ascending: false })
    .limit(1).maybeSingle();
  assertNoError(classification.error, 'No se pudo buscar la ultima clasificacion shadow-v2');
  if (!classification.data?.id) throw new Error('No existe una fila shadow-v2 para registrar el limite');
  const updated = await supabase.from(TABLES.classifications)
    .update(payload).eq('id', classification.data.id);
  assertNoError(updated.error, 'No se pudo registrar el limite en clasificaciones shadow-v2');
}

async function insertDigestRun(supabase, row, items = []) {
  const runResult = await supabase.from(TABLES.digestRuns).insert([row])
    .select('id').single();
  assertNoError(runResult.error, 'No se pudo persistir el digest run shadow-v2');
  if (items.length === 0) return runResult.data.id;
  const itemRows = items.map((item) => ({ ...item, shadow_digest_run_id: runResult.data.id }));
  const itemResult = await supabase.from(TABLES.digestItems).insert(itemRows);
  if (itemResult.error) {
    const cleanup = await supabase.from(TABLES.digestRuns).delete().eq('id', runResult.data.id);
    if (cleanup.error) {
      const combined = new Error(
        `No se pudieron persistir items ni limpiar el digest run shadow-v2: `
        + `${itemResult.error.message}; cleanup: ${cleanup.error.message}`
      );
      combined.code = itemResult.error.code || cleanup.error.code || null;
      combined.details = {
        item_error: itemResult.error.details || null,
        cleanup_error: cleanup.error.details || null,
      };
      throw combined;
    }
    assertNoError(itemResult.error, 'No se pudieron persistir items shadow-v2');
  }
  return runResult.data.id;
}

module.exports = {
  TABLES,
  ALERT_SELECT,
  USER_SELECT,
  RAW_DOCUMENT_SELECT,
  chunks,
  buildLearnedProfiles,
  officialSnapshot,
  loadExistingClassificationIds,
  loadAlerts,
  loadOfficialDocuments,
  insertClassification,
  loadSuccessfulClassifications,
  loadExistingDigestUserIds,
  loadUsers,
  loadLearnedProfiles,
  loadSentHistory,
  recordLimitEvent,
  insertDigestRun,
};
