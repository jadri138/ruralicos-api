const TRACE_RELATION = 'raw_documents.inserted_alerta_id -> alertas.id';

const DEFAULT_SELECT = [
  'id',
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
  'contenido_hash',
  'url_hash',
  'scraper_run_id',
  'capture_status',
  'capture_reason',
  'metadata_json',
  'organization_id',
  'inserted_alerta_id',
  'created_at',
  'updated_at',
].join(', ');

const FALLBACK_SELECT = [
  'id',
  'titulo',
  'url',
  'texto_raw',
  'capture_status',
  'capture_reason',
  'inserted_alerta_id',
  'created_at',
].join(', ');

function normalizarId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function extraerAlertaId(input) {
  if (input && typeof input === 'object') {
    return normalizarId(input.id ?? input.alerta_id);
  }
  return normalizarId(input);
}

function extraerOrganizationId(input = {}) {
  const raw = input.organizationId ??
    input.organization_id ??
    input.alerta?.organization_id ??
    input.alerta?.organizationId ??
    input.rawDocument?.organization_id ??
    input.rawDocument?.organizationId ??
    input.organization?.id;
  return normalizarId(raw);
}

function recortarTexto(value, max = 420) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max).trim() : text;
}

function sourceUrl(rawDocument = {}) {
  return rawDocument.url_pdf || rawDocument.url_html || rawDocument.url || null;
}

function evidenceAvailable(rawDocument = {}) {
  return Boolean(rawDocument.texto_raw || rawDocument.contenido_hash || sourceUrl(rawDocument));
}

function crearResultadoBase(alertaId, overrides = {}) {
  return {
    ok: false,
    found: false,
    available: true,
    status: 'unknown',
    reason: 'unknown',
    relation: TRACE_RELATION,
    uses_alerta_raw_document_id: false,
    alerta_id: alertaId ?? null,
    organization_id: null,
    raw_document_id: null,
    source_url: null,
    official_id: null,
    content_hash: null,
    text_excerpt: null,
    evidence_available: false,
    rawDocument: null,
    candidates: [],
    warnings: [],
    ...overrides,
  };
}

function relationMatches(rawDocument, alertaId) {
  const rawAlertId = normalizarId(rawDocument?.inserted_alerta_id);
  return rawAlertId !== null && alertaId !== null && rawAlertId === alertaId;
}

function organizationMatches(rawDocument, organizationId = null) {
  const expected = normalizarId(organizationId);
  if (!expected) return true;
  const rawOrganizationId = normalizarId(rawDocument?.organization_id ?? rawDocument?.organizationId);
  if (!rawOrganizationId) return true;
  return rawOrganizationId === expected;
}

function resumirRawDocument(rawDocument = {}) {
  return {
    raw_document_id: rawDocument.id ?? null,
    source_url: sourceUrl(rawDocument),
    official_id: rawDocument.id_oficial ?? null,
    content_hash: rawDocument.contenido_hash ?? null,
    text_excerpt: recortarTexto(rawDocument.texto_raw),
    evidence_available: evidenceAvailable(rawDocument),
  };
}

function scoreCandidate(rawDocument = {}) {
  let score = 0;
  if (rawDocument.capture_status === 'inserted') score += 20;
  if (rawDocument.texto_raw) score += 8;
  if (rawDocument.url_pdf) score += 4;
  if (rawDocument.url_html) score += 3;
  if (rawDocument.url) score += 2;
  if (rawDocument.updated_at) score += 1;
  return score;
}

function ordenarCandidatos(rawDocuments = []) {
  return [...(Array.isArray(rawDocuments) ? rawDocuments : [])].sort((left, right) => {
    const diff = scoreCandidate(right) - scoreCandidate(left);
    if (diff) return diff;
    return String(right.updated_at || right.created_at || '').localeCompare(String(left.updated_at || left.created_at || ''));
  });
}

function crearTraceDesdeRawDocument({ alerta, alertaId: explicitAlertaId, organizationId: explicitOrganizationId, rawDocument }) {
  const alertaId = explicitAlertaId ?? extraerAlertaId(alerta);
  const organizationId = explicitOrganizationId ?? extraerOrganizationId({ alerta, rawDocument });
  const result = crearResultadoBase(alertaId, { organization_id: organizationId });

  if (!alertaId) {
    return {
      ...result,
      status: 'missing_alerta_id',
      reason: 'missing_alerta_id',
      warnings: [{ code: 'missing_alerta_id', detail: 'No se puede resolver raw_documents sin alertas.id.' }],
    };
  }

  if (!rawDocument) {
    return {
      ...result,
      ok: true,
      status: 'not_found',
      reason: 'not_found',
    };
  }

  if (!relationMatches(rawDocument, alertaId)) {
    return {
      ...result,
      status: 'mismatch',
      reason: 'raw_document_alerta_mismatch',
      raw_document_id: rawDocument.id ?? null,
      rawDocument,
      warnings: [{
        code: 'raw_document_alerta_mismatch',
        detail: `raw_documents.inserted_alerta_id=${rawDocument.inserted_alerta_id ?? 'null'} no coincide con alertas.id=${alertaId}.`,
      }],
    };
  }

  if (!organizationMatches(rawDocument, organizationId)) {
    return {
      ...result,
      status: 'organization_mismatch',
      reason: 'organization_mismatch',
      raw_document_id: rawDocument.id ?? null,
      rawDocument,
      warnings: [{
        code: 'organization_mismatch',
        detail: `raw_documents.organization_id=${rawDocument.organization_id ?? 'null'} no coincide con organization_id=${organizationId}.`,
      }],
    };
  }

  const summary = resumirRawDocument(rawDocument);
  return {
    ...result,
    ok: true,
    found: true,
    status: 'linked',
    reason: 'linked',
    ...summary,
    rawDocument,
  };
}

async function ejecutarSelectRawDocuments(supabase, alertaId, { select = DEFAULT_SELECT, limit = 5 } = {}) {
  return supabase
    .from('raw_documents')
    .select(select)
    .eq('inserted_alerta_id', alertaId)
    .order('updated_at', { ascending: false })
    .limit(Math.max(1, Math.min(20, Number(limit) || 5)));
}

async function cargarRawDocumentsPorAlerta(supabase, alertaId, options = {}) {
  try {
    const result = await ejecutarSelectRawDocuments(supabase, alertaId, options);
    if (result.error) throw result.error;
    return { available: true, data: result.data || [], error: null };
  } catch (error) {
    return {
      available: false,
      data: [],
      error,
      reason: 'raw_documents_error',
    };
  }
}

async function resolverDocumentTrace(supabase, input = {}, options = {}) {
  const alerta = input.alerta ?? input;
  const alertaId = normalizarId(input.alertaId ?? input.alerta_id) ?? extraerAlertaId(alerta);
  const organizationId = extraerOrganizationId({ ...input, alerta }) ?? extraerOrganizationId(options);
  const base = crearResultadoBase(alertaId, { organization_id: organizationId });

  if (!supabase?.from || typeof supabase.from !== 'function') {
    return {
      ...base,
      ok: true,
      status: 'missing_supabase_client',
      reason: 'missing_supabase_client',
      available: false,
      warnings: [{ code: 'missing_supabase_client', detail: 'Supabase client invalido o ausente.' }],
    };
  }

  if (!alertaId) {
    return {
      ...base,
      status: 'missing_alerta_id',
      reason: 'missing_alerta_id',
      warnings: [{ code: 'missing_alerta_id', detail: 'No se puede resolver raw_documents sin alertas.id.' }],
    };
  }

  const loaded = await cargarRawDocumentsPorAlerta(supabase, alertaId, options);
  if (!loaded.available) {
    return {
      ...base,
      ok: false,
      available: false,
      status: loaded.reason,
      reason: loaded.reason,
      error: loaded.error?.message || null,
      warnings: [{
        code: loaded.reason,
        detail: loaded.error?.message || 'No se pudo consultar raw_documents.',
      }],
    };
  }

  const relatedCandidates = ordenarCandidatos(loaded.data)
    .filter((rawDocument) => relationMatches(rawDocument, alertaId));
  const candidates = relatedCandidates
    .filter((rawDocument) => organizationMatches(rawDocument, organizationId));

  if (relatedCandidates.length > 0 && candidates.length === 0) {
    return {
      ...base,
      ok: true,
      status: 'organization_mismatch',
      reason: 'organization_mismatch',
      warnings: [{
        code: 'organization_mismatch',
        detail: 'Hay raw_documents enlazados a la alerta, pero pertenecen a otro organization_id.',
      }],
    };
  }

  if (candidates.length === 0) {
    return {
      ...base,
      ok: true,
      status: 'not_found',
      reason: 'not_found',
    };
  }

  const [rawDocument] = candidates;
  const summary = resumirRawDocument(rawDocument);
  const warnings = [];
  if (candidates.length > 1) {
    warnings.push({
      code: 'multiple_raw_documents',
      detail: `Se encontraron ${candidates.length} raw_documents para la alerta; se eligio el candidato mas completo.`,
    });
  }

  return {
    ...base,
    ok: true,
    found: true,
    status: 'linked',
    reason: 'linked',
    ...summary,
    rawDocument,
    candidates: candidates.map((item) => ({
      id: item.id ?? null,
      inserted_alerta_id: item.inserted_alerta_id ?? null,
      organization_id: item.organization_id ?? null,
      capture_status: item.capture_status ?? null,
      score: scoreCandidate(item),
    })),
    warnings,
  };
}

module.exports = {
  TRACE_RELATION,
  DEFAULT_SELECT,
  FALLBACK_SELECT,
  normalizarId,
  extraerAlertaId,
  extraerOrganizationId,
  sourceUrl,
  evidenceAvailable,
  relationMatches,
  organizationMatches,
  resumirRawDocument,
  scoreCandidate,
  ordenarCandidatos,
  crearTraceDesdeRawDocument,
  cargarRawDocumentsPorAlerta,
  resolverDocumentTrace,
};
