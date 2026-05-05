const { checkCronToken } = require('../utils/checkCronToken');
const { getFechaMadridISO } = require('../utils/fechaMadrid');
const {
  inicializarOpenAI,
  generarEmbedding,
  generarEmbeddingsBatch,
  calcularCentroidePonderado,
  BATCH_SIZE,
  BATCH_DELAY_MS,
} = require('../utils/embeddings');
const { generarContextoNarrativo } = require('../utils/cerebro');

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

function parseVector(value) {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed).map(Number);
  } catch {
    return trimmed
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n));
  }
}

function aplicarDecayTemporal(fechaCreacion, pesoInicial = 1) {
  const fecha = new Date(fechaCreacion);
  if (Number.isNaN(fecha.getTime())) return Number(pesoInicial) || 1;

  const diasDesde = (Date.now() - fecha.getTime()) / (1000 * 60 * 60 * 24);
  let factor = 1.0;
  if (diasDesde > 180) factor = 0.1;
  else if (diasDesde > 90) factor = 0.3;
  else if (diasDesde > 30) factor = 0.6;

  return (Number(pesoInicial) || 1) * factor;
}

function textoPerfilInicial(user = {}) {
  const prefs = user.preferences || {};
  const tiposActivos = Object.entries(prefs.tipos_alerta || {})
    .filter(([, activo]) => activo === true)
    .map(([tipo]) => tipo);

  return [
    user.name ? `Usuario: ${user.name}` : '',
    Array.isArray(prefs.sectores) ? `Sectores: ${prefs.sectores.join(', ')}` : '',
    Array.isArray(prefs.provincias) ? `Provincias: ${prefs.provincias.join(', ')}` : '',
    Array.isArray(prefs.subsectores) ? `Subsectores: ${prefs.subsectores.join(', ')}` : '',
    tiposActivos.length ? `Tipos de alerta: ${tiposActivos.join(', ')}` : '',
    user.preferencias_extra ? `Texto libre: ${user.preferencias_extra}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim() || 'Preferencias agrarias generales';
}

function textoMemorias(memorias = []) {
  return memorias
    .filter((m) => !['feedback_positivo', 'feedback_negativo'].includes(m.tipo))
    .slice(0, 120)
    .map((m) => `[${m.tipo}] ${m.contenido}`)
    .join('\n')
    .trim();
}

function vectorValido(vector) {
  return Array.isArray(vector) && vector.length === 1536 && vector.every((n) => Number.isFinite(Number(n)));
}

function restarVector(base, resta, factor = 0.35) {
  if (!vectorValido(base)) return null;
  if (!vectorValido(resta)) return base;
  return base.map((v, i) => Number(v) - Number(resta[i]) * factor);
}

function combinarVectores(partes) {
  const validas = partes
    .filter((parte) => vectorValido(parte.vector) && Number(parte.peso) > 0);

  if (validas.length === 0) return null;

  const sumaPesos = validas.reduce((acc, parte) => acc + parte.peso, 0);
  const resultado = new Array(1536).fill(0);

  for (const { vector, peso } of validas) {
    const pesoNormalizado = peso / sumaPesos;
    for (let i = 0; i < 1536; i++) {
      resultado[i] += Number(vector[i]) * pesoNormalizado;
    }
  }

  return resultado;
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

  async function actualizarPerfilUsuarioMIA(userId, options = {}) {
    const usarMock = Boolean(options.forceMock || process.env.EMBEDDINGS_FORCE_MOCK === 'true');
    if (!usarMock && !process.env.OPENAI_API_KEY) {
      throw new Error('Falta OPENAI_API_KEY para recalcular el perfil MIA');
    }

    inicializarOpenAI();

    const { data: user, error: errUser } = await supabase
      .from('users')
      .select('id, name, subscription, preferences, preferencias_extra, perfil_version')
      .eq('id', userId)
      .maybeSingle();

    if (errUser) throw errUser;
    if (!user) return { ok: false, reason: 'usuario_no_encontrado', user_id: userId };

    const { data: memorias, error: errMemorias } = await supabase
      .from('user_memory')
      .select('id, tipo, contenido, alerta_id, digest_id, peso_inicial, incorporado_a_embedding, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1500);

    if (errMemorias) throw errMemorias;

    const memoriasLista = memorias || [];
    const memoriasConAlerta = memoriasLista.filter((m) =>
      m.alerta_id && ['feedback_positivo', 'feedback_negativo'].includes(m.tipo)
    );

    let perfilFeedback = null;
    let feedbacksPositivosUsados = 0;
    let feedbacksNegativosUsados = 0;

    const alertaIds = [...new Set(memoriasConAlerta.map((m) => Number(m.alerta_id)).filter(Boolean))];
    if (alertaIds.length > 0) {
      const { data: alertas, error: errAlertas } = await supabase
        .from('alertas')
        .select('id, embedding')
        .in('id', alertaIds)
        .not('embedding', 'is', null);

      if (errAlertas) throw errAlertas;

      const embeddingPorAlerta = new Map(
        (alertas || [])
          .map((a) => [Number(a.id), parseVector(a.embedding)])
          .filter(([, embedding]) => vectorValido(embedding))
      );

      const positivos = [];
      const pesosPositivos = [];
      const negativos = [];
      const pesosNegativos = [];

      for (const memoria of memoriasConAlerta) {
        const embedding = embeddingPorAlerta.get(Number(memoria.alerta_id));
        if (!embedding) continue;

        const peso = aplicarDecayTemporal(memoria.created_at, memoria.peso_inicial);
        if (memoria.tipo === 'feedback_positivo') {
          positivos.push(embedding);
          pesosPositivos.push(peso);
        } else {
          negativos.push(embedding);
          pesosNegativos.push(peso);
        }
      }

      feedbacksPositivosUsados = positivos.length;
      feedbacksNegativosUsados = negativos.length;

      const centroidePositivo = positivos.length > 0
        ? calcularCentroidePonderado(positivos, pesosPositivos)
        : null;
      const centroideNegativo = negativos.length > 0
        ? calcularCentroidePonderado(negativos, pesosNegativos)
        : null;

      perfilFeedback = centroidePositivo
        ? restarVector(centroidePositivo, centroideNegativo)
        : null;
    }

    const textoMemoria = textoMemorias(memoriasLista);
    const embeddingMemorias = textoMemoria
      ? await generarEmbedding(textoMemoria, usarMock)
      : null;
    const embeddingPreferencias = await generarEmbedding(textoPerfilInicial(user), usarMock);

    const perfilFinal = perfilFeedback
      ? combinarVectores([
        { vector: perfilFeedback, peso: 0.55 },
        { vector: embeddingMemorias, peso: 0.30 },
        { vector: embeddingPreferencias, peso: 0.15 },
      ])
      : combinarVectores([
        { vector: embeddingMemorias, peso: 0.70 },
        { vector: embeddingPreferencias, peso: 0.30 },
      ]);

    if (!vectorValido(perfilFinal)) {
      throw new Error('No se pudo calcular un perfil embedding valido');
    }

    let contextoNarrativo = null;
    try {
      contextoNarrativo = await generarContextoNarrativo(user, memoriasLista);
    } catch (err) {
      console.warn(`[mia:perfil] No se pudo generar contexto narrativo user ${user.id}:`, err.message);
      contextoNarrativo = user.preferencias_extra || null;
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({
        perfil_embedding: vectorToSql(perfilFinal),
        perfil_version: Number(user.perfil_version || 0) + 1,
        perfil_actualizado_at: new Date().toISOString(),
        contexto_narrativo: contextoNarrativo,
      })
      .eq('id', user.id);

    if (updateError) throw updateError;

    const memoriaIdsPendientes = memoriasLista
      .filter((m) => m.incorporado_a_embedding === false)
      .map((m) => Number(m.id))
      .filter(Boolean);

    if (memoriaIdsPendientes.length > 0) {
      const { error: errMarcado } = await supabase
        .from('user_memory')
        .update({ incorporado_a_embedding: true })
        .in('id', memoriaIdsPendientes);

      if (errMarcado) {
        console.warn(`[mia:perfil] No se pudieron marcar memorias incorporadas user ${user.id}:`, errMarcado.message);
      }
    }

    return {
      ok: true,
      user_id: user.id,
      perfil_version: Number(user.perfil_version || 0) + 1,
      memorias_usadas: memoriasLista.length,
      feedbacks_positivos_usados: feedbacksPositivosUsados,
      feedbacks_negativos_usados: feedbacksNegativosUsados,
      memorias_textuales_usadas: textoMemoria ? memoriasLista.length - memoriasConAlerta.length : 0,
      embedding_length: perfilFinal.length,
      contexto_narrativo_actualizado: Boolean(contextoNarrativo),
      source: usarMock ? 'mock' : 'openai',
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

  const actualizarPerfilHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ ok: false, error: 'userId invalido' });
    }

    const run = await iniciarPipelineRun(supabase, {
      stage: 'mia_perfil_actualizar',
      endpoint: `/cerebro/perfil/actualizar/${userId}`,
      fechaObjetivo: getFechaMadridISO(),
    });

    try {
      const result = await actualizarPerfilUsuarioMIA(userId, {
        forceMock: req.body?.forceMock || req.query.forceMock === 'true',
      });

      await cerrarPipelineRun(supabase, run, {
        status: result.ok ? 'ok' : 'warning',
        procesadas: result.ok ? 1 : 0,
        errores: result.ok ? 0 : 1,
        response_json: result,
      });

      return res.json(result);
    } catch (err) {
      console.error('[mia] Error en /cerebro/perfil/actualizar:', err.message);
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
  app.post('/cerebro/perfil/actualizar/:userId', actualizarPerfilHandler);
  app.get('/cerebro/perfil/actualizar/:userId', actualizarPerfilHandler);
};
