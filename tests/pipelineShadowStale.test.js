const assert = require('assert');
const fixture = require('./fixtures/pipeline/shadow-stale-jobs.json');
const {
  actualizarEventoRecuperacion,
  anadirEventoRecuperacion,
  crearEventoRecuperacion,
  diagnosticarPipelineJob,
  registrarClaimRecuperacion,
  resumirPipelineJobs,
} = require('../src/modules/tareas/pipelineJobs');
const {
  construirPatchReparacion,
  parseArgs,
  seleccionarJobsStale,
} = require('../scripts/repair_stale_pipeline_jobs');

const options = {
  now: new Date(fixture.now),
  staleMs: fixture.stale_ms,
};

for (const job of fixture.jobs) {
  const diagnostic = diagnosticarPipelineJob(job, options);
  assert.strictEqual(diagnostic.stale, job.expected_stale, `job ${job.id}: stale`);
  assert.strictEqual(diagnostic.recovery_reason || null, job.expected_reason, `job ${job.id}: motivo`);
}

const summary = resumirPipelineJobs(fixture.jobs, options);
assert.strictEqual(summary.stale, 3);
assert.strictEqual(summary.missing_current_stage, 2);

const selected = seleccionarJobsStale(fixture.jobs, options);
assert.deepStrictEqual(selected.map(({ job }) => job.id), [1601, 1701, 1801]);
assert.strictEqual(parseArgs([]).apply, false, 'el script es dry-run por defecto');
assert.strictEqual(parseArgs(['--apply']).apply, true, 'solo --apply habilita escrituras');

const staleJob = fixture.jobs[0];
const repairAt = new Date(fixture.now);
const reopenPatch = construirPatchReparacion(staleJob, {
  action: 'reopen',
  reason: 'heartbeat_missing',
  now: repairAt,
});
assert.strictEqual(reopenPatch.status, 'pending');
assert.strictEqual(reopenPatch.claimed_by, null);
assert.strictEqual(reopenPatch.finished_at, null);
assert.strictEqual(reopenPatch.options_json.recovery_audit[0].previous_job.id, staleJob.id);
assert.strictEqual(reopenPatch.options_json.recovery_audit[0].reason, 'heartbeat_missing');

const abortPatch = construirPatchReparacion(staleJob, {
  action: 'abort',
  reason: 'heartbeat_missing',
  now: repairAt,
});
assert.strictEqual(abortPatch.status, 'aborted');
assert.strictEqual(abortPatch.options_json.recovery_audit[0].final.status, 'aborted');

const event = crearEventoRecuperacion({
  job: staleJob,
  reason: 'heartbeat_missing',
  action: 'reopen',
  now: repairAt,
});
let auditedOptions = anadirEventoRecuperacion({}, event);
auditedOptions = registrarClaimRecuperacion(auditedOptions, 'tick-recovery', repairAt);
auditedOptions = actualizarEventoRecuperacion(auditedOptions, 'tick-recovery', {
  initial_stage: 'scrapers',
});
auditedOptions = actualizarEventoRecuperacion(auditedOptions, 'tick-recovery', {
  final: { status: 'completed', finished_at: repairAt.toISOString() },
});
const auditedEvent = auditedOptions.recovery_audit[0];
assert.strictEqual(auditedEvent.new_claim.tick_id, 'tick-recovery');
assert.strictEqual(auditedEvent.initial_stage, 'scrapers');
assert.strictEqual(auditedEvent.final.status, 'completed');

console.log('OK: corpus de jobs shadow stale del 16 al 21 de julio');
