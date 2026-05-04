const { checkCronToken } = require('../utils/checkCronToken');
const { calcularPesoDecay } = require('../utils/decay');
const {
  inicializarOpenAI,
  generarEmbedding,
  generarEmbeddingsBatch,
  similitudCoseno,
  calcularCentroidePonderado,
} = require('../utils/embeddings');

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_BATCHES = 1;
const DEFAULT_DELAY_MS = 750;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function textoAlerta(alerta = {}) {
  return [
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen,
    ...(Array.isArray(alerta.sectores) ? alerta.sectores : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
    ...(Array.isArray(alerta.provincias) ? alerta.provincias : []),
    alerta.fuente,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
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

module.exports = function embeddingsRoutes(app, supabase) {
  async function generarEmbeddingHandler(req, res) {
    if (!checkCronToken(req, res)) return;

    const { text, otherText, forceMock } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'Indica text en el body' });
    }

    try {
      inicializarOpenAI();

      const texto = String(text).trim();
      const usarMock = Boolean(forceMock || process.env.EMBEDDINGS_FORCE_MOCK === 'true');
      const embedding = await generarEmbedding(texto, usarMock);

      const result = {
        ok: true,
        text: texto,
        embedding_length: Array.isArray(embedding) ? embedding.length : null,
        sample: Array.isArray(embedding) ? embedding.slice(0, 16) : null,
        source: usarMock ? 'mock' : 'openai',
      };

      if (otherText && typeof otherText === 'string' && otherText.trim().length > 0) {
        const otherEmbedding = await generarEmbedding(String(otherText).trim(), usarMock);
        result.other_text = String(otherText).trim();
        result.other_embedding_length = Array.isArray(otherEmbedding) ? otherEmbedding.length : null;
        result.similarity = similitudCoseno(embedding, otherEmbedding);
      }

      return res.json(result);
    } catch (err) {
      console.error('[embeddings] Error en /embeddings/test:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  async function generarAlertasSinEmbedding(options = {}) {
    const batchSize = clampNumber(options.batchSize, DEFAULT_BATCH_SIZE, 1, 50);
    const maxBatches = clampNumber(options.maxBatches, DEFAULT_MAX_BATCHES, 1, 200);
    const delayMs = clampNumber(options.delayMs, DEFAULT_DELAY_MS, 0, 10000);
    const usarMock = Boolean(options.forceMock || process.env.EMBEDDINGS_FORCE_MOCK === 'true');
    if (!usarMock && !process.env.OPENAI_API_KEY) {
      throw new Error('Falta OPENAI_API_KEY para generar embeddings reales');
    }
    inicializarOpenAI();

    let procesadas = 0;
    let actualizadas = 0;
    const errores = [];

    for (let batch = 1; batch <= maxBatches; batch++) {
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, resumen, resumen_final, fuente, sectores, subsectores, tipos_alerta, provincias')
        .eq('estado_ia', 'listo')
        .is('embedding', null)
        .order('id', { ascending: true })
        .limit(batchSize);

      if (error) throw error;
      if (!alertas || alertas.length === 0) break;

      const textos = alertas.map(textoAlerta);
      const embeddings = await generarEmbeddingsBatch(textos, usarMock);

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

      console.log(`[embeddings] batch ${batch}: ${alertas.length} alertas procesadas`);
      if (batch < maxBatches && alertas.length === batchSize && delayMs > 0) {
        await sleep(delayMs);
      }
      if (alertas.length < batchSize) break;
    }

    return { procesadas, actualizadas, errores, source: usarMock ? 'mock' : 'openai' };
  }

  async function actualizarPerfilUsuario(userId, options = {}) {
    const usarMock = Boolean(options.forceMock || process.env.EMBEDDINGS_FORCE_MOCK === 'true');
    if (!usarMock && !process.env.OPENAI_API_KEY) {
      throw new Error('Falta OPENAI_API_KEY para generar embeddings reales');
    }
    inicializarOpenAI();

    const { data: user, error: errUser } = await supabase
      .from('users')
      .select('id, name, preferences, preferencias_extra')
      .eq('id', userId)
      .maybeSingle();

    if (errUser) throw errUser;
    if (!user) return { ok: false, reason: 'usuario_no_encontrado', user_id: userId };

    const { data: feedbacks, error: errFeedback } = await supabase
      .from('alerta_feedback')
      .select('alerta_id, created_at, updated_at')
      .eq('user_id', user.id)
      .eq('valor', 1)
      .order('created_at', { ascending: false })
      .limit(500);

    if (errFeedback) throw errFeedback;

    let perfilEmbedding = null;
    let origen = 'preferencias_iniciales';
    let feedbacksUsados = 0;

    const alertaIds = [...new Set((feedbacks || []).map((f) => Number(f.alerta_id)).filter(Boolean))];
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
          .filter(([, embedding]) => Array.isArray(embedding) && embedding.length > 0)
      );

      const embeddings = [];
      const pesos = [];
      for (const feedback of feedbacks || []) {
        const embedding = embeddingPorAlerta.get(Number(feedback.alerta_id));
        if (!embedding) continue;

        embeddings.push(embedding);
        pesos.push(calcularPesoDecay(feedback.updated_at || feedback.created_at));
      }

      if (embeddings.length > 0) {
        perfilEmbedding = calcularCentroidePonderado(embeddings, pesos);
        origen = 'feedback_positivo';
        feedbacksUsados = embeddings.length;
      }
    }

    if (!perfilEmbedding) {
      perfilEmbedding = await generarEmbedding(textoPerfilInicial(user), usarMock);
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({
        perfil_embedding: vectorToSql(perfilEmbedding),
        perfil_actualizado_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (updateError) throw updateError;

    return {
      ok: true,
      user_id: user.id,
      origen,
      feedbacks_usados: feedbacksUsados,
      embedding_length: perfilEmbedding.length,
      source: usarMock ? 'mock' : 'openai',
    };
  }

  async function usuariosConFeedbackPendiente() {
    const { data: feedbacks, error } = await supabase
      .from('alerta_feedback')
      .select('user_id, updated_at, created_at')
      .order('updated_at', { ascending: false })
      .limit(2000);

    if (error) throw error;

    const latestByUser = new Map();
    for (const feedback of feedbacks || []) {
      const userId = Number(feedback.user_id);
      const fecha = feedback.updated_at || feedback.created_at;
      if (!userId || !fecha) continue;
      if (!latestByUser.has(userId) || new Date(fecha) > new Date(latestByUser.get(userId))) {
        latestByUser.set(userId, fecha);
      }
    }

    if (latestByUser.size === 0) return [];

    const { data: users, error: errUsers } = await supabase
      .from('users')
      .select('id, perfil_actualizado_at')
      .in('id', [...latestByUser.keys()]);

    if (errUsers) throw errUsers;

    return (users || [])
      .filter((user) => {
        const latestFeedback = latestByUser.get(Number(user.id));
        if (!latestFeedback) return false;
        if (!user.perfil_actualizado_at) return true;
        return new Date(latestFeedback) > new Date(user.perfil_actualizado_at);
      })
      .map((user) => Number(user.id));
  }

  app.post('/embeddings/test', generarEmbeddingHandler);

  const generarAlertasHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const result = await generarAlertasSinEmbedding({
        batchSize: req.body?.batchSize || req.query.batchSize,
        maxBatches: req.body?.maxBatches || req.query.maxBatches,
        delayMs: req.body?.delayMs || req.query.delayMs,
        forceMock: req.body?.forceMock || req.query.forceMock === 'true',
      });
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[embeddings] Error en /embeddings/generar-alertas:', err.message);
      return res.status(500).json({ error: err.message });
    }
  };

  const actualizarPerfilHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'userId invalido' });
      }

      const result = await actualizarPerfilUsuario(userId, {
        forceMock: req.body?.forceMock || req.query.forceMock === 'true',
      });
      return res.json(result);
    } catch (err) {
      console.error('[embeddings] Error en /embeddings/actualizar-perfil:', err.message);
      return res.status(500).json({ error: err.message });
    }
  };

  const cicloCompletoHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const alertas = await generarAlertasSinEmbedding({
        batchSize: req.body?.batchSize || req.query.batchSize,
        maxBatches: req.body?.maxBatches || req.query.maxBatches || 5,
        delayMs: req.body?.delayMs || req.query.delayMs,
        forceMock: req.body?.forceMock || req.query.forceMock === 'true',
      });

      const userIds = await usuariosConFeedbackPendiente();
      const perfiles = [];
      for (const userId of userIds) {
        try {
          perfiles.push(await actualizarPerfilUsuario(userId, {
            forceMock: req.body?.forceMock || req.query.forceMock === 'true',
          }));
        } catch (err) {
          perfiles.push({ ok: false, user_id: userId, error: err.message });
        }
      }

      return res.json({
        ok: true,
        alertas,
        perfiles_actualizados: perfiles.filter((p) => p.ok).length,
        perfiles,
      });
    } catch (err) {
      console.error('[embeddings] Error en /embeddings/ciclo-completo:', err.message);
      return res.status(500).json({ error: err.message });
    }
  };

  app.post('/embeddings/generar-alertas', generarAlertasHandler);
  app.get('/embeddings/generar-alertas', generarAlertasHandler);
  app.post('/embeddings/actualizar-perfil/:userId', actualizarPerfilHandler);
  app.get('/embeddings/actualizar-perfil/:userId', actualizarPerfilHandler);
  app.post('/embeddings/ciclo-completo', cicloCompletoHandler);
  app.get('/embeddings/ciclo-completo', cicloCompletoHandler);
};
