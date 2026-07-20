const { hashTexto } = require('../../rawDocuments/rawDocuments.service');
const {
  crearAuditoriaEvidencia,
  obtenerTextoDocumento,
} = require('./bopaScraper');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function normalizarLimite(value) {
  const parsed = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function documentoDesdeRaw(alerta, raw = {}) {
  const bopa = raw.metadata_json?.bopa || {};
  return {
    url: alerta.url,
    urlHtml: raw.url_html || bopa.detail_url || alerta.url,
    urlTexto: bopa.text_url || raw.url_html || alerta.url,
    urlPdf: raw.url_pdf || bopa.summary_pdf_url || null,
    urlsAlternativasOficiales: bopa.official_alternative_urls || [],
    idOficial: raw.id_oficial || bopa.official_id || null,
    fecha: alerta.fecha || raw.fecha || null,
    metadata_json: raw.metadata_json || {},
  };
}

function combinarAuditoriaEvidencia(anterior, evidencia, attemptedAt) {
  const previa = anterior && typeof anterior === 'object' ? anterior : {};
  const actual = crearAuditoriaEvidencia({
    ...evidencia,
    attempted_at: attemptedAt,
    recovered_at: evidencia.evidencia ? (evidencia.recovered_at || attemptedAt) : null,
  });
  const nuevosIntentos = actual.attempts.map((intento) => ({
    ...intento,
    attempted_at: attemptedAt,
  }));
  const recoveryRuns = Array.isArray(previa.recovery_runs) ? previa.recovery_runs : [];

  return {
    ...previa,
    ...actual,
    attempts: [
      ...(Array.isArray(previa.attempts) ? previa.attempts : []),
      ...nuevosIntentos,
    ],
    recovery_runs: [
      ...recoveryRuns,
      {
        attempted_at: attemptedAt,
        status: actual.status,
        source: actual.source,
        reason: actual.reason,
      },
    ],
  };
}

async function actualizarRawEvidencia(supabase, raw, evidencia, attemptedAt) {
  const metadataJson = {
    ...(raw.metadata_json || {}),
    evidence: combinarAuditoriaEvidencia(raw.metadata_json?.evidence, evidencia, attemptedAt),
  };
  const patch = {
    metadata_json: metadataJson,
    updated_at: attemptedAt,
  };

  if (evidencia.evidencia) {
    patch.texto_raw = evidencia.texto;
    patch.contenido_hash = hashTexto(evidencia.texto);
    if (evidencia.urlPdf) patch.url_pdf = evidencia.urlPdf;
  }

  const { data, error } = await supabase
    .from('raw_documents')
    .update(patch)
    .eq('id', raw.id)
    .eq('inserted_alerta_id', raw.inserted_alerta_id)
    .select('id');
  if (error) return { ok: false, error: error.message };
  if (!Array.isArray(data) || data.length === 0) return { ok: false, error: 'raw_document_not_updated' };
  return { ok: true, metadata_json: metadataJson };
}

async function recuperarAlertasBopaSinEvidencia(supabase, options = {}) {
  const dryRun = options.dryRun !== false;
  const fecha = options.fecha || null;
  const limit = normalizarLimite(options.limit);
  const extraerEvidencia = options.obtenerTextoDocumento || obtenerTextoDocumento;
  const now = options.now || (() => new Date().toISOString());

  let query = supabase
    .from('alertas')
    .select('id, url, fecha, fuente, estado_ia, contenido, resumen')
    .eq('fuente', 'BOPA')
    .eq('estado_ia', 'needs_evidence')
    .limit(limit);
  if (fecha) query = query.eq('fecha', fecha);

  const { data: alertas, error: alertasError } = await query;
  if (alertasError) throw new Error(`No se pudieron leer alertas BOPA: ${alertasError.message}`);

  const candidatas = (alertas || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
  const stats = {
    dry_run: dryRun,
    fecha,
    limit,
    total: candidatas.length,
    would_recover: 0,
    recovered: 0,
    missing: 0,
    skipped: 0,
    errors: 0,
    items: [],
  };
  if (!candidatas.length) return stats;

  const alertaIds = candidatas.map((alerta) => alerta.id);
  const { data: raws, error: rawsError } = await supabase
    .from('raw_documents')
    .select('id, inserted_alerta_id, url, url_html, url_pdf, fecha, id_oficial, texto_raw, metadata_json')
    .eq('fuente', 'BOPA')
    .in('inserted_alerta_id', alertaIds);
  if (rawsError) throw new Error(`No se pudieron leer raw_documents BOPA: ${rawsError.message}`);

  const rawPorAlerta = new Map((raws || []).map((raw) => [String(raw.inserted_alerta_id), raw]));
  for (const alerta of candidatas) {
    const raw = rawPorAlerta.get(String(alerta.id));
    if (!raw) {
      stats.skipped += 1;
      stats.items.push({ alerta_id: alerta.id, status: 'skipped', reason: 'raw_document_missing' });
      continue;
    }

    const attemptedAt = now();
    let evidencia;
    try {
      evidencia = await extraerEvidencia(documentoDesdeRaw(alerta, raw), {
        ...options.dependencies,
        now: () => attemptedAt,
      });
    } catch (error) {
      evidencia = {
        texto: '',
        evidencia: false,
        motivo: 'fetch_error',
        attempts: [{ source: 'recovery', status: 'failed', reason: 'fetch_error', error: error.message }],
      };
    }

    if (dryRun) {
      if (evidencia.evidencia) stats.would_recover += 1;
      else stats.missing += 1;
      stats.items.push({
        alerta_id: alerta.id,
        raw_document_id: raw.id,
        status: evidencia.evidencia ? 'would_recover' : 'missing',
        source: evidencia.fuente_evidencia || null,
        reason: evidencia.motivo || null,
      });
      continue;
    }

    const rawUpdate = await actualizarRawEvidencia(supabase, raw, evidencia, attemptedAt);
    if (!rawUpdate.ok) {
      stats.errors += 1;
      stats.items.push({
        alerta_id: alerta.id,
        raw_document_id: raw.id,
        status: 'error',
        reason: `raw_update_error: ${rawUpdate.error}`,
      });
      continue;
    }

    if (!evidencia.evidencia) {
      stats.missing += 1;
      stats.items.push({
        alerta_id: alerta.id,
        raw_document_id: raw.id,
        status: 'missing',
        reason: evidencia.motivo || 'sin_texto_util',
      });
      continue;
    }

    const { data: alertaActualizada, error: alertaError } = await supabase
      .from('alertas')
      .update({
        contenido: evidencia.texto,
        estado_ia: 'pendiente_clasificar',
        resumen: 'Procesando con IA...',
        updated_at: attemptedAt,
      })
      .eq('id', alerta.id)
      .eq('fuente', 'BOPA')
      .eq('estado_ia', 'needs_evidence')
      .select('id');

    if (alertaError) {
      stats.errors += 1;
      stats.items.push({
        alerta_id: alerta.id,
        raw_document_id: raw.id,
        status: 'error',
        reason: `alert_update_error: ${alertaError.message}`,
      });
      continue;
    }
    if (!Array.isArray(alertaActualizada) || alertaActualizada.length === 0) {
      stats.skipped += 1;
      stats.items.push({
        alerta_id: alerta.id,
        raw_document_id: raw.id,
        status: 'skipped',
        reason: 'alert_state_changed',
      });
      continue;
    }

    stats.recovered += 1;
    stats.items.push({
      alerta_id: alerta.id,
      raw_document_id: raw.id,
      status: 'recovered',
      source: evidencia.fuente_evidencia,
    });
  }

  return stats;
}

module.exports = {
  combinarAuditoriaEvidencia,
  documentoDesdeRaw,
  normalizarLimite,
  recuperarAlertasBopaSinEvidencia,
};
