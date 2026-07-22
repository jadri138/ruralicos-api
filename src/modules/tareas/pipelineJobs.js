// src/modules/tareas/pipelineJobs.js
//
// Acceso a datos de pipeline_jobs: el estado con checkpoints del runner de
// pipeline (pipelineRunner.js). Un job por (kind, fecha, shadow); los ticks
// lo reclaman con claim + heartbeat para que dos crons no se pisen.

const crypto = require('crypto');

const JOB_STATUS_TERMINAL = new Set(['completed', 'failed', 'aborted']);
const RECOVERY_AUDIT_VERSION = 'pipeline_recovery_v1';

function fechaValida(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function snapshotPipelineJob(job = {}) {
  return {
    id: job.id ?? null,
    kind: job.kind ?? null,
    fecha: job.fecha ?? null,
    shadow: Boolean(job.shadow),
    status: job.status ?? null,
    current_stage: job.current_stage ?? null,
    claimed_by: job.claimed_by ?? null,
    heartbeat_at: job.heartbeat_at ?? null,
    started_at: job.started_at ?? null,
    finished_at: job.finished_at ?? null,
    updated_at: job.updated_at ?? null,
    ticks: Number(job.ticks || 0),
  };
}

function diagnosticarPipelineJob(job = {}, { now = new Date(), staleMs = 5 * 60 * 1000 } = {}) {
  const heartbeat = fechaValida(job.heartbeat_at);
  const updatedAt = fechaValida(job.updated_at);
  const heartbeatMissing = job.status === 'running' && !heartbeat;
  const heartbeatStale = job.status === 'running'
    && Boolean(heartbeat)
    && (now.getTime() - heartbeat.getTime()) > staleMs;
  const currentStageMissingTooLong = job.status === 'running'
    && !job.current_stage
    && Boolean(updatedAt)
    && (now.getTime() - updatedAt.getTime()) > staleMs;
  const stale = heartbeatMissing || heartbeatStale || currentStageMissingTooLong;
  const recoveryReason = heartbeatMissing
    ? 'heartbeat_missing'
    : heartbeatStale
      ? 'heartbeat_stale'
      : currentStageMissingTooLong
        ? 'current_stage_missing_too_long'
        : null;
  const flags = [];
  if (heartbeatMissing) flags.push('heartbeat_missing');
  if (heartbeatStale) flags.push('heartbeat_stale');
  if (job.status === 'running' && !job.current_stage) flags.push('current_stage_missing');
  if (currentStageMissingTooLong) flags.push('current_stage_missing_too_long');
  if (stale) flags.push('pipeline_job_stale');
  return {
    job_id: job.id ?? null,
    stale,
    recoverable: stale,
    recovery_reason: recoveryReason,
    flags,
    heartbeat_at: heartbeat ? heartbeat.toISOString() : null,
    updated_at: updatedAt ? updatedAt.toISOString() : null,
    current_stage: job.current_stage || null,
  };
}

function recoveryAuditList(options = {}) {
  return Array.isArray(options.recovery_audit) ? options.recovery_audit : [];
}

function crearEventoRecuperacion({
  job,
  reason,
  action = 'claim_takeover',
  tickId = null,
  now = new Date(),
} = {}) {
  return {
    version: RECOVERY_AUDIT_VERSION,
    reason: reason || 'manual_recovery',
    action,
    detected_at: now.toISOString(),
    previous_job: snapshotPipelineJob(job),
    new_claim: tickId ? { tick_id: tickId, claimed_at: now.toISOString() } : null,
    initial_stage: null,
    final: null,
  };
}

function anadirEventoRecuperacion(options = {}, event) {
  return {
    ...options,
    recovery_audit: [...recoveryAuditList(options), event].slice(-20),
  };
}

function actualizarEventoRecuperacion(options = {}, tickId, patch = {}) {
  const events = recoveryAuditList(options).map((event) => ({ ...event }));
  let index = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const eventTick = events[i]?.new_claim?.tick_id;
    if (eventTick === tickId || (!eventTick && events[i]?.final === null)) {
      index = i;
      break;
    }
  }
  if (index < 0) return options;
  events[index] = { ...events[index], ...patch };
  return { ...options, recovery_audit: events };
}

function registrarClaimRecuperacion(options = {}, tickId, now = new Date()) {
  return actualizarEventoRecuperacion(options, tickId, {
    new_claim: { tick_id: tickId, claimed_at: now.toISOString() },
  });
}

function resumirPipelineJobs(jobs = [], options = {}) {
  const diagnostics = (jobs || []).map((job) => diagnosticarPipelineJob(job, options));
  return {
    total: diagnostics.length,
    running: (jobs || []).filter((job) => job.status === 'running').length,
    stale: diagnostics.filter((item) => item.stale).length,
    missing_current_stage: diagnostics.filter((item) => item.flags.includes('current_stage_missing')).length,
    diagnostics,
  };
}

function nuevoTickId() {
  return crypto.randomBytes(8).toString('hex');
}

function crearPipelineJobsStore(supabase) {
  async function obtenerJob({ kind, fecha, shadow }) {
    const { data, error } = await supabase
      .from('pipeline_jobs')
      .select('*')
      .eq('kind', kind)
      .eq('fecha', fecha)
      .eq('shadow', shadow)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  return {
    async obtenerOCrear({ kind = 'daily', fecha, shadow = false, options = {} }) {
      const existente = await obtenerJob({ kind, fecha, shadow });
      if (existente) return existente;

      const { data, error } = await supabase
        .from('pipeline_jobs')
        .insert([{ kind, fecha, shadow, status: 'pending', stages_json: {}, options_json: options }])
        .select()
        .single();
      if (!error) return data;

      // Otro tick lo creo a la vez: la unique (kind, fecha, shadow) manda.
      if (error.code === '23505') {
        const reintento = await obtenerJob({ kind, fecha, shadow });
        if (reintento) return reintento;
      }
      throw error;
    },

    // Claim atomico: solo reclama si nadie lo tiene o el heartbeat esta rancio.
    async reclamar({ job, tickId, staleMs, now = new Date() }) {
      const cutoff = new Date(now.getTime() - staleMs).toISOString();
      const diagnostic = diagnosticarPipelineJob(job, { now, staleMs });
      let optionsJson = job.options_json || {};
      if (diagnostic.stale) {
        optionsJson = anadirEventoRecuperacion(optionsJson, crearEventoRecuperacion({
          job,
          reason: diagnostic.recovery_reason,
          action: 'claim_takeover',
          tickId,
          now,
        }));
      } else {
        optionsJson = registrarClaimRecuperacion(optionsJson, tickId, now);
      }
      const { data, error } = await supabase
        .from('pipeline_jobs')
        .update({
          claimed_by: tickId,
          heartbeat_at: now.toISOString(),
          status: 'running',
          started_at: job.started_at || now.toISOString(),
          ticks: Number(job.ticks || 0) + 1,
          options_json: optionsJson,
          updated_at: now.toISOString(),
        })
        .eq('id', job.id)
        .in('status', ['pending', 'running'])
        .or(`claimed_by.is.null,heartbeat_at.is.null,heartbeat_at.lt.${cutoff},and(current_stage.is.null,updated_at.lt.${cutoff})`)
        .select();
      if (error) throw error;
      return Array.isArray(data) && data.length ? data[0] : null;
    },

    // Checkpoint: escribe estado y renueva heartbeat. Exige conservar el claim.
    async guardar({ jobId, tickId, patch = {} }) {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('pipeline_jobs')
        .update({ ...patch, heartbeat_at: now, updated_at: now })
        .eq('id', jobId)
        .eq('claimed_by', tickId)
        .select();
      if (error) throw error;
      if (!Array.isArray(data) || !data.length) {
        throw new Error('pipeline_job_claim_perdido');
      }
      return data[0];
    },

    async liberar({ jobId, tickId, patch = {} }) {
      const { error } = await supabase
        .from('pipeline_jobs')
        .update({ ...patch, claimed_by: null, updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .eq('claimed_by', tickId);
      if (error) console.warn('[pipeline_jobs] No se pudo liberar claim:', error.message);
    },

    // Reset manual de un job terminal o stale para reintentar el dia.
    async reabrir({ jobId, job = {}, reason = 'manual_reopen', now = new Date() }) {
      const optionsJson = anadirEventoRecuperacion(
        job.options_json || {},
        crearEventoRecuperacion({ job: { ...job, id: jobId }, reason, action: 'reopen', now })
      );
      const { data, error } = await supabase
        .from('pipeline_jobs')
        .update({
          status: 'pending',
          error_msg: null,
          claimed_by: null,
          heartbeat_at: null,
          current_stage: null,
          finished_at: null,
          options_json: optionsJson,
          updated_at: now.toISOString(),
        })
        .eq('id', jobId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async abortar({ job, reason = 'manual_abort', now = new Date() }) {
      const event = crearEventoRecuperacion({ job, reason, action: 'abort', now });
      event.final = { status: 'aborted', finished_at: now.toISOString() };
      const optionsJson = anadirEventoRecuperacion(job.options_json || {}, event);
      const { data, error } = await supabase
        .from('pipeline_jobs')
        .update({
          status: 'aborted',
          claimed_by: null,
          heartbeat_at: null,
          finished_at: now.toISOString(),
          error_msg: reason,
          options_json: optionsJson,
          updated_at: now.toISOString(),
        })
        .eq('id', job.id)
        .in('status', ['pending', 'running'])
        .select();
      if (error) throw error;
      return Array.isArray(data) && data.length ? data[0] : null;
    },

    async listar({ fecha = null, kind = null, limit = 20 } = {}) {
      let query = supabase
        .from('pipeline_jobs')
        .select('*')
        .order('fecha', { ascending: false })
        .order('shadow', { ascending: true })
        .limit(limit);
      if (fecha) query = query.eq('fecha', fecha);
      if (kind) query = query.eq('kind', kind);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  };
}

module.exports = {
  JOB_STATUS_TERMINAL,
  RECOVERY_AUDIT_VERSION,
  actualizarEventoRecuperacion,
  anadirEventoRecuperacion,
  crearEventoRecuperacion,
  crearPipelineJobsStore,
  diagnosticarPipelineJob,
  nuevoTickId,
  registrarClaimRecuperacion,
  resumirPipelineJobs,
  snapshotPipelineJob,
};
