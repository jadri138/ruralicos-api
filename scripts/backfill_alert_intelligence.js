#!/usr/bin/env node

require('dotenv').config();

const { preclassifyAlerta } = require('../src/modules/alertas/clasificacion/alertPreclassifier');
const { construirFactSheetAlerta } = require('../src/modules/alertas/intelligence/factSheetBuilder');
const { guardarFactSheetShadow } = require('../src/modules/alertas/intelligence/factSheetStore');
const { normalizarClasificacionCanonica } = require('../src/shared/taxonomyRegistry');

const ALERT_SELECT = [
  'id',
  'titulo',
  'url',
  'fecha',
  'fuente',
  'region',
  'provincias',
  'sectores',
  'subsectores',
  'tipos_alerta',
  'taxonomy_tags',
  'contenido',
  'resumen',
  'resumen_borrador',
  'resumen_final',
  'organization_id',
  'decision_audit',
  'created_at',
].join(', ');

function valorArg(argv, name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')
    ? argv[index + 1]
    : fallback;
}

function parseBackfillArgs(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const explicitDryRun = argv.includes('--dry-run');
  if (write && explicitDryRun) {
    throw new Error('Usa solo uno de --dry-run o --write.');
  }

  const positiveInt = (name, fallback, max) => {
    const value = Number(valorArg(argv, name, fallback));
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`--${name} debe ser un entero entre 1 y ${max}.`);
    }
    return value;
  };

  const resumeRaw = valorArg(argv, 'resume-after-id', '0');
  const resumeAfterId = Number(resumeRaw);
  if (!Number.isInteger(resumeAfterId) || resumeAfterId < 0) {
    throw new Error('--resume-after-id debe ser un entero mayor o igual que 0.');
  }

  return {
    days: positiveInt('days', 30, 3650),
    batch: positiveInt('batch', 100, 1000),
    concurrency: positiveInt('concurrency', 3, 20),
    resumeAfterId,
    write,
    dryRun: !write,
  };
}

function fechaCorteISO(days, now = new Date()) {
  return new Date(now.getTime() - (days * 24 * 60 * 60 * 1000)).toISOString();
}

async function mapConcurrencia(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run())
  );
  return results;
}

function construirPatchIntelligence(alerta, preclassification, taxonomyTags) {
  return {
    pre_score: preclassification.pre_score,
    pre_status: preclassification.pre_status,
    pre_reasons: preclassification.pre_reasons,
    candidate_level: preclassification.candidate_level,
    taxonomy_tags: taxonomyTags,
    decision_audit: {
      ...(alerta.decision_audit && typeof alerta.decision_audit === 'object'
        ? alerta.decision_audit
        : {}),
      intelligence_backfill: {
        version: 'alert_intelligence_backfill_v1',
        preclassification,
        taxonomy_tags: taxonomyTags,
        processed_at: new Date().toISOString(),
      },
    },
  };
}

async function procesarAlertaBackfill(supabase, alerta, options = {}) {
  const preclassification = preclassifyAlerta(alerta);
  const canonical = normalizarClasificacionCanonica(alerta, alerta);
  const taxonomyTags = canonical.taxonomy_tags || [];
  const factSheet = await construirFactSheetAlerta(alerta, {
    supabase,
    organizationId: alerta.organization_id,
  });
  const patch = construirPatchIntelligence(alerta, preclassification, taxonomyTags);

  if (!options.write) {
    return {
      id: alerta.id,
      written: false,
      candidate_level: preclassification.candidate_level,
      taxonomy_tags: taxonomyTags.length,
      fact_sheet_status: factSheet.status,
    };
  }

  const { error: updateError } = await supabase
    .from('alertas')
    .update(patch)
    .eq('id', alerta.id);
  if (updateError) throw updateError;

  const store = await guardarFactSheetShadow(supabase, {
    factSheet,
    organizationId: alerta.organization_id,
    enforcementMode: 'shadow',
    shadowDecision: {
      source: 'alert_intelligence_backfill_v1',
      dry_run: false,
    },
  });
  if (!store.ok) throw new Error(store.error || store.reason || 'fact_sheet_store_failed');

  return {
    id: alerta.id,
    written: true,
    candidate_level: preclassification.candidate_level,
    taxonomy_tags: taxonomyTags.length,
    fact_sheet_status: factSheet.status,
  };
}

async function ejecutarBackfill(supabase, options, logger = console) {
  const cutoff = fechaCorteISO(options.days);
  let cursor = options.resumeAfterId;
  const metrics = {
    mode: options.write ? 'write' : 'dry-run',
    days: options.days,
    batch: options.batch,
    concurrency: options.concurrency,
    cutoff,
    resume_after_id: options.resumeAfterId,
    read: 0,
    processed: 0,
    written: 0,
    errors: 0,
    last_id: cursor,
    candidate_levels: {},
    fact_sheet_statuses: {},
  };

  while (true) {
    let query = supabase
      .from('alertas')
      .select(ALERT_SELECT)
      .gte('created_at', cutoff)
      .order('id', { ascending: true })
      .limit(options.batch);
    if (cursor > 0) query = query.gt('id', cursor);

    const { data, error } = await query;
    if (error) throw error;
    const alertas = data || [];
    if (alertas.length === 0) break;
    metrics.read += alertas.length;

    const results = await mapConcurrencia(alertas, options.concurrency, async (alerta) => {
      try {
        return await procesarAlertaBackfill(supabase, alerta, options);
      } catch (workerError) {
        return { id: alerta.id, error: workerError.message };
      }
    });

    for (const result of results) {
      cursor = Math.max(cursor, Number(result.id) || cursor);
      metrics.last_id = cursor;
      if (result.error) {
        metrics.errors += 1;
        logger.error(`[backfill] alerta ${result.id}: ${result.error}`);
        continue;
      }
      metrics.processed += 1;
      if (result.written) metrics.written += 1;
      metrics.candidate_levels[result.candidate_level] =
        (metrics.candidate_levels[result.candidate_level] || 0) + 1;
      metrics.fact_sheet_statuses[result.fact_sheet_status] =
        (metrics.fact_sheet_statuses[result.fact_sheet_status] || 0) + 1;
    }

    logger.log(
      `[backfill] mode=${metrics.mode} read=${metrics.read} processed=${metrics.processed} ` +
      `errors=${metrics.errors} last_id=${metrics.last_id}`
    );
    if (alertas.length < options.batch) break;
  }

  return metrics;
}

async function main() {
  const options = parseBackfillArgs();
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }

  const { supabase } = require('../src/platform/supabase');
  console.log(
    `[backfill] Inicio seguro: mode=${options.write ? 'write' : 'dry-run'} ` +
    `days=${options.days} batch=${options.batch} concurrency=${options.concurrency} ` +
    `resume_after_id=${options.resumeAfterId}`
  );
  const metrics = await ejecutarBackfill(supabase, options);
  console.log(JSON.stringify(metrics, null, 2));
  if (metrics.errors > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[backfill] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  ALERT_SELECT,
  construirPatchIntelligence,
  ejecutarBackfill,
  fechaCorteISO,
  mapConcurrencia,
  parseBackfillArgs,
  procesarAlertaBackfill,
};
