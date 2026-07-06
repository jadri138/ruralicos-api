// src/modules/tareas/pipelineJobs.js
//
// Acceso a datos de pipeline_jobs: el estado con checkpoints del runner de
// pipeline (pipelineRunner.js). Un job por (kind, fecha, shadow); los ticks
// lo reclaman con claim + heartbeat para que dos crons no se pisen.

const crypto = require('crypto');

const JOB_STATUS_TERMINAL = new Set(['completed', 'failed', 'aborted']);

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
      const { data, error } = await supabase
        .from('pipeline_jobs')
        .update({
          claimed_by: tickId,
          heartbeat_at: now.toISOString(),
          status: 'running',
          started_at: job.started_at || now.toISOString(),
          ticks: Number(job.ticks || 0) + 1,
          updated_at: now.toISOString(),
        })
        .eq('id', job.id)
        .in('status', ['pending', 'running'])
        .or(`claimed_by.is.null,heartbeat_at.lt.${cutoff}`)
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

    // Reset manual de un job terminal (failed/aborted) para reintentar el dia.
    async reabrir({ jobId }) {
      const { data, error } = await supabase
        .from('pipeline_jobs')
        .update({
          status: 'pending',
          error_msg: null,
          claimed_by: null,
          finished_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .select()
        .single();
      if (error) throw error;
      return data;
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
  crearPipelineJobsStore,
  nuevoTickId,
};
