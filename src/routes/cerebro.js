const { checkCronToken } = require('../utils/checkCronToken');
const { getFechaMadridISO } = require('../utils/fechaMadrid');
const {
  inicializarOpenAI,
  generarEmbeddingsBatch,
  BATCH_SIZE,
  BATCH_DELAY_MS,
} = require('../utils/embeddings');

const DEFAULT_SELECT_LIMIT = 100;
const DEFAULT_MAX_LOOPS = 1;

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function vectorToSql(vector) {
  if (!Array.isArray(vector)) throw new Error('Vector invalido');
  return `[${vector.map((n) => Number(n)).join(',')}]`;
}

function textoRepresentativoAlerta(alerta = {}) {
  return [
    alerta.titulo || '',
    alerta.resumen_final || alerta.resumen || '',
    `Sector: ${(Array.isArray(alerta.sectores) ? alerta.sectores : []).join(', ') || 'sin sector'}.`,
    `Subsector: ${(Array.isArray(alerta.subsectores) ? alerta.subsectores : []).join(', ') || 'sin subsector'}.`,
    `Tipo: ${(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []).join(', ') || 'sin tipo'}.`,
    `Provincia: ${(Array.isArray(alerta.provincias) ? alerta.provincias : []).join(', ') || 'nacional'}.`,
    `Fuente: ${alerta.fuente || 'desconocida'}.`,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

async function iniciarPipelineRun(supabase, { stage, endpoint, fechaObjetivo }) {
  const startedAt = new Date();
  const run = {
    stage,
    endpoint,
    fecha_objetivo: fechaObjetivo,
    started_at: startedAt.toISOString(),
    status: 'running',
  };

  const { data, error } = await supabase
    .from('pipeline_runs')
    .insert(run)
    .select('id, started_at')
    .single();

  if (error) {
    console.warn('[mia] No se pudo iniciar pipeline_runs:', error.message);
    return { id: null, startedAt };
  }

  return { id: data?.id || null, startedAt };
}

async function cerrarPipelineRun(supabase, run, patch) {
  if (!run?.id) return;

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - new Date(run.startedAt).getTime();

  const { error } = await supabase
    .from('pipeline_runs')
    .update({
      finished_at: finishedAt.toISOString(),
      duration_ms: durationMs,
      ...patch,
    })
    .eq('id', run.id);

  if (error) {
    console.warn('[mia] No se pudo cerrar pipeline_runs:', error.message);
  }
}

module.exports = function cerebroRoutes(app, supabase) {
  async function inicializarEmbeddingsAlertas(options = {}) {
    const selectLimit = clampNumber(options.selectLimit, DEFAULT_SELECT_LIMIT, 1, 100);
    const maxLoops = clampNumber(options.maxLoops, DEFAULT_MAX_LOOPS, 1, 200);
    const usarMock = Boolean(options.forceMock || process.env.EMBEDDINGS_FORCE_MOCK === 'true');
    const fechaObjetivo = options.fechaObjetivo || getFechaMadridISO();

    if (!usarMock && !process.env.OPENAI_API_KEY) {
      throw new Error('Falta OPENAI_API_KEY para generar embeddings reales');
    }

    inicializarOpenAI();

    let procesadas = 0;
    let actualizadas = 0;
    let loops = 0;
    const errores = [];

    for (loops = 1; loops <= maxLoops; loops++) {
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, resumen, resumen_final, fuente, sectores, subsectores, tipos_alerta, provincias')
        .eq('estado_ia', 'listo')
        .eq('fecha', fechaObjetivo)
        .is('embedding', null)
        .order('id', { ascending: true })
        .limit(selectLimit);

      if (error) throw error;
      if (!alertas || alertas.length === 0) {
        loops -= 1;
        break;
      }

      const textos = alertas.map(textoRepresentativoAlerta);
      const embeddings = await generarEmbeddingsBatch(
        textos,
        usarMock,
        (hechos, total) => console.log(`[mia:embeddings] lote OpenAI ${hechos}/${total}`)
      );

      for (let i = 0; i < alertas.length; i++) {
        const alerta = alertas[i];
        const embedding = embeddings[i];
        procesadas++;

        const { error: updateError } = await supabase
          .from('alertas')
          .update({
            embedding: vectorToSql(embedding),
            embedding_generated_at: new Date().toISOString(),
          })
          .eq('id', alerta.id)
          .is('embedding', null);

        if (updateError) {
          errores.push({ alerta_id: alerta.id, error: updateError.message });
          continue;
        }

        actualizadas++;
      }

      console.log(`[mia:embeddings] vuelta ${loops}: procesadas=${alertas.length}, actualizadas=${actualizadas}`);
      if (alertas.length < selectLimit) break;
    }

    return {
      ok: errores.length === 0,
      fecha: fechaObjetivo,
      procesadas,
      actualizadas,
      loops,
      errores,
      source: usarMock ? 'mock' : 'openai',
      batch_size_openai: BATCH_SIZE,
      batch_delay_ms: BATCH_DELAY_MS,
    };
  }

  const inicializarEmbeddingsHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const fechaObjetivo = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || req.body?.fecha || '')
      ? (req.query.fecha || req.body.fecha)
      : getFechaMadridISO();

    const run = await iniciarPipelineRun(supabase, {
      stage: 'mia_embeddings_inicializar',
      endpoint: '/cerebro/embeddings/inicializar',
      fechaObjetivo,
    });

    try {
      const result = await inicializarEmbeddingsAlertas({
        fechaObjetivo,
        selectLimit: req.body?.limit || req.query.limit,
        maxLoops: req.body?.maxLoops || req.query.maxLoops,
        forceMock: req.body?.forceMock || req.query.forceMock === 'true',
      });

      await cerrarPipelineRun(supabase, run, {
        status: result.errores.length > 0 ? 'warning' : 'ok',
        loops: result.loops,
        procesadas: result.actualizadas,
        errores: result.errores.length,
        response_json: result,
      });

      return res.json(result);
    } catch (err) {
      console.error('[mia] Error en /cerebro/embeddings/inicializar:', err.message);
      await cerrarPipelineRun(supabase, run, {
        status: 'error',
        errores: 1,
        error_msg: err.message,
        response_json: { error: err.message },
      });
      return res.status(500).json({ ok: false, error: err.message });
    }
  };

  app.post('/cerebro/embeddings/inicializar', inicializarEmbeddingsHandler);
  app.get('/cerebro/embeddings/inicializar', inicializarEmbeddingsHandler);
};
