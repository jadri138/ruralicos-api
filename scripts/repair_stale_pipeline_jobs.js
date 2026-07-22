#!/usr/bin/env node

const {
  anadirEventoRecuperacion,
  crearEventoRecuperacion,
  diagnosticarPipelineJob,
} = require('../src/modules/tareas/pipelineJobs');

function parseArgs(argv = process.argv.slice(2)) {
  const values = new Map();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value = 'true'] = arg.slice(2).split('=', 2);
    values.set(key, value);
  }
  const action = values.get('action') || 'reopen';
  if (!['reopen', 'abort'].includes(action)) throw new Error('action debe ser reopen o abort');
  return {
    apply: values.get('apply') === 'true',
    action,
    from: values.get('from') || null,
    to: values.get('to') || null,
    staleMs: Math.max(60_000, Number(values.get('stale-ms') || 5 * 60 * 1000)),
  };
}

function seleccionarJobsStale(jobs = [], options = {}) {
  return jobs
    .filter((job) => job.shadow === true && job.status === 'running')
    .map((job) => ({ job, diagnostic: diagnosticarPipelineJob(job, options) }))
    .filter(({ diagnostic }) => diagnostic.stale);
}

function construirPatchReparacion(job, {
  action = 'reopen',
  reason,
  now = new Date(),
} = {}) {
  const event = crearEventoRecuperacion({
    job,
    reason: reason || 'historical_stale_repair',
    action,
    now,
  });
  if (action === 'abort') {
    event.final = { status: 'aborted', finished_at: now.toISOString() };
  }
  const common = {
    claimed_by: null,
    heartbeat_at: null,
    updated_at: now.toISOString(),
    options_json: anadirEventoRecuperacion(job.options_json || {}, event),
  };
  if (action === 'abort') {
    return {
      ...common,
      status: 'aborted',
      finished_at: now.toISOString(),
      error_msg: reason || 'historical_stale_repair',
    };
  }
  return {
    ...common,
    status: 'pending',
    current_stage: null,
    finished_at: null,
    error_msg: null,
  };
}

async function main() {
  require('dotenv').config();
  const args = parseArgs();
  const { supabase } = require('../src/platform/supabase');
  let query = supabase
    .from('pipeline_jobs')
    .select('*')
    .eq('shadow', true)
    .eq('status', 'running')
    .order('fecha', { ascending: true });
  if (args.from) query = query.gte('fecha', args.from);
  if (args.to) query = query.lte('fecha', args.to);
  const { data, error } = await query;
  if (error) throw error;

  const now = new Date();
  const selected = seleccionarJobsStale(data || [], { now, staleMs: args.staleMs });
  const report = selected.map(({ job, diagnostic }) => ({
    id: job.id,
    fecha: job.fecha,
    shadow: job.shadow,
    status: job.status,
    current_stage: job.current_stage,
    heartbeat_at: job.heartbeat_at,
    recovery_reason: diagnostic.recovery_reason,
    action: args.action,
  }));
  console.log(JSON.stringify({ dry_run: !args.apply, count: report.length, jobs: report }, null, 2));
  if (!args.apply) return;

  for (const { job, diagnostic } of selected) {
    const patch = construirPatchReparacion(job, {
      action: args.action,
      reason: diagnostic.recovery_reason,
      now,
    });
    let update = supabase
      .from('pipeline_jobs')
      .update(patch)
      .eq('id', job.id)
      .eq('status', 'running');
    if (job.updated_at) update = update.eq('updated_at', job.updated_at);
    const { data: updated, error: updateError } = await update.select();
    if (updateError) throw updateError;
    if (!Array.isArray(updated) || updated.length !== 1) {
      throw new Error(`pipeline_job_${job.id}_cambio_durante_reparacion`);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  construirPatchReparacion,
  parseArgs,
  seleccionarJobsStale,
};
