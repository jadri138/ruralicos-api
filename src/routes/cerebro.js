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
const {
  generarContextoNarrativo,
  generarPreguntaExploracion,
} = require('../utils/cerebro');
const { enviarDigestPro } = require('../whatsapp');

const DEFAULT_SELECT_LIMIT = 100;
const DEFAULT_MAX_LOOPS = 1;
const MAX_PREGUNTAS_EXPLORACION_DIA = 3;

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

function restarDias(fecha, dias) {
  return new Date(fecha.getTime() - dias * 24 * 60 * 60 * 1000);
}

function inicioDiaISO(fecha = new Date()) {
  return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate())).toISOString();
}

function extraerPreferenciasDeclaradas(user = {}) {
  const prefs = user.preferences || {};
  const tipos = Object.entries(prefs.tipos_alerta || {})
    .filter(([, activo]) => activo === true)
    .map(([tipo]) => tipo);

  return {
    sectores: Array.isArray(prefs.sectores) ? prefs.sectores : [],
    provincias: Array.isArray(prefs.provincias) ? prefs.provincias : [],
    subsectores: Array.isArray(prefs.subsectores) ? prefs.subsectores : [],
    tipos_alerta: tipos,
  };
}

function detectarZonaIncertidumbre(user, memorias = []) {
  const declaradas = extraerPreferenciasDeclaradas(user);
  const textoMemoria = memorias
    .map((m) => `${m.tipo} ${m.contenido}`)
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const temasDeclarados = [
    ...declaradas.subsectores.map((tema) => ({ tipo: 'subsector', tema })),
    ...declaradas.provincias.map((tema) => ({ tipo: 'provincia', tema })),
    ...declaradas.tipos_alerta.map((tema) => ({ tipo: 'tipo de alerta', tema })),
    ...declaradas.sectores.map((tema) => ({ tipo: 'sector', tema })),
  ];

  const sinConfirmar = temasDeclarados.find(({ tema }) => {
    const normalizado = String(tema || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return normalizado && !textoMemoria.includes(normalizado);
  });

  if (sinConfirmar) {
    return `No sabemos aun si el ${sinConfirmar.tipo} "${sinConfirmar.tema}" sigue siendo prioritario para el usuario.`;
  }

  if (user.preferencias_extra && memorias.length < 5) {
    return `Hay poca memoria acumulada. Conviene confirmar que sigue buscando esto: "${String(user.preferencias_extra).slice(0, 180)}".`;
  }

  return 'Perfil con poca señal reciente. Conviene preguntar que tema agricola o ganadero quiere priorizar en sus proximas alertas.';
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

  async function contarPreguntasExploracionHoy() {
    const { count, error } = await supabase
      .from('user_memory')
      .select('id', { count: 'exact', head: true })
      .eq('tipo', 'pregunta_sistema')
      .gte('created_at', inicioDiaISO(new Date()));

    if (error) throw error;
    return count || 0;
  }

  async function explorarUsuarioMIA(userId, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const force = Boolean(options.force);

    const { data: user, error: errUser } = await supabase
      .from('users')
      .select('id, name, phone, subscription, preferences, preferencias_extra, contexto_narrativo, ultima_interaccion_at')
      .eq('id', userId)
      .maybeSingle();

    if (errUser) throw errUser;
    if (!user) return { ok: false, reason: 'usuario_no_encontrado', user_id: userId };
    if (!user.phone) return { ok: false, reason: 'usuario_sin_telefono', user_id: userId };

    const { data: memorias, error: errMemorias } = await supabase
      .from('user_memory')
      .select('id, tipo, contenido, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (errMemorias) throw errMemorias;

    const memoriaLista = memorias || [];
    const ultimaInteraccion = user.ultima_interaccion_at ? new Date(user.ultima_interaccion_at) : null;
    const inactivo7Dias = !ultimaInteraccion || ultimaInteraccion < restarDias(new Date(), 7);
    const pocaMemoria = memoriaLista.length < 5;
    const elegible = force || inactivo7Dias || pocaMemoria;

    if (!elegible) {
      return {
        ok: true,
        skipped: true,
        reason: 'usuario_no_elegible',
        user_id: userId,
        memoria_total: memoriaLista.length,
        ultima_interaccion_at: user.ultima_interaccion_at,
      };
    }

    const preguntasHoy = await contarPreguntasExploracionHoy();
    if (!force && preguntasHoy >= MAX_PREGUNTAS_EXPLORACION_DIA) {
      return {
        ok: true,
        skipped: true,
        reason: 'limite_diario_exploracion',
        preguntas_hoy: preguntasHoy,
        limite: MAX_PREGUNTAS_EXPLORACION_DIA,
      };
    }

    const zonaIncertidumbre = detectarZonaIncertidumbre(user, memoriaLista);
    const pregunta = await generarPreguntaExploracion(user, zonaIncertidumbre);

    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        user_id: userId,
        zona_incertidumbre: zonaIncertidumbre,
        pregunta,
        preguntas_hoy: preguntasHoy,
      };
    }

    await enviarDigestPro(user.phone, pregunta);

    const { data: memoriaInsertada, error: errMemoria } = await supabase
      .from('user_memory')
      .insert({
        user_id: userId,
        tipo: 'pregunta_sistema',
        contenido: pregunta,
        peso_inicial: 0.5,
      })
      .select('id')
      .single();

    if (errMemoria) throw errMemoria;

    const { data: conversacion, error: errConversacion } = await supabase
      .from('user_conversations')
      .insert({
        user_id: userId,
        estado: 'activa',
        tipo: 'pregunta_exploracion',
        contexto_json: {
          pregunta_enviada: pregunta,
          zona_incertidumbre: zonaIncertidumbre,
          memoria_id: memoriaInsertada?.id || null,
        },
        expira_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();

    if (errConversacion) throw errConversacion;

    return {
      ok: true,
      user_id: userId,
      pregunta,
      zona_incertidumbre: zonaIncertidumbre,
      memoria_id: memoriaInsertada?.id || null,
      conversacion_id: conversacion?.id || null,
      preguntas_hoy: preguntasHoy + 1,
    };
  }

  async function usuariosConMemoriaPendiente() {
    const { data: memorias, error } = await supabase
      .from('user_memory')
      .select('user_id, created_at')
      .eq('incorporado_a_embedding', false)
      .order('created_at', { ascending: false })
      .limit(2000);

    if (error) throw error;

    return [...new Set((memorias || []).map((m) => Number(m.user_id)).filter(Boolean))];
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

  const diagnosticoUsuarioHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ ok: false, error: 'userId invalido' });
    }

    try {
      const { data: user, error: errUser } = await supabase
        .from('users')
        .select('id, name, phone, subscription, preferences, preferencias_extra, perfil_embedding, perfil_version, contexto_narrativo, ultima_interaccion_at, perfil_actualizado_at')
        .eq('id', userId)
        .maybeSingle();

      if (errUser) throw errUser;
      if (!user) return res.status(404).json({ ok: false, reason: 'usuario_no_encontrado', user_id: userId });

      const [memoriasRes, conversacionesRes, digestsRes, exploracionRes] = await Promise.all([
        supabase
          .from('user_memory')
          .select('id, tipo, contenido, alerta_id, digest_id, peso_inicial, incorporado_a_embedding, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('user_conversations')
          .select('id, tipo, estado, digest_id, contexto_json, abierta_at, cerrada_at, expira_at')
          .eq('user_id', userId)
          .order('abierta_at', { ascending: false })
          .limit(10),
        supabase
          .from('digests')
          .select('id, fecha, alerta_ids, enviado, enviado_at, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('exploration_log')
          .select('id, digest_id, alerta_id, tipo_exploracion, motivo, resultado, procesado, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      for (const result of [memoriasRes, conversacionesRes, digestsRes, exploracionRes]) {
        if (result.error) throw result.error;
      }

      const memorias = memoriasRes.data || [];
      const resumenMemoria = memorias.reduce((acc, memoria) => {
        acc[memoria.tipo] = (acc[memoria.tipo] || 0) + 1;
        return acc;
      }, {});

      const perfilEmbedding = parseVector(user.perfil_embedding);
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : null;

      let candidatosSemanticos = null;
      if (fecha && vectorValido(perfilEmbedding)) {
        const { data, error } = await supabase
          .rpc('buscar_alertas_similares', {
            p_perfil_vector: vectorToSql(perfilEmbedding),
            p_fecha: fecha,
            p_limite: 10,
          });

        candidatosSemanticos = error
          ? { ok: false, error: error.message }
          : {
            ok: true,
            fecha,
            alertas: (data || []).map((a) => ({
              id: a.id,
              titulo: a.titulo,
              fuente: a.fuente,
              provincias: a.provincias,
              sectores: a.sectores,
              subsectores: a.subsectores,
              tipos_alerta: a.tipos_alerta,
              similitud: Number(a.similitud),
            })),
          };
      }

      return res.json({
        ok: true,
        user: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          subscription: user.subscription,
          tiene_perfil_embedding: vectorValido(perfilEmbedding),
          perfil_version: user.perfil_version,
          perfil_actualizado_at: user.perfil_actualizado_at,
          ultima_interaccion_at: user.ultima_interaccion_at,
          contexto_narrativo: user.contexto_narrativo,
          preferences: user.preferences || {},
          preferencias_extra: user.preferencias_extra || null,
        },
        memoria: {
          total_mostradas: memorias.length,
          por_tipo: resumenMemoria,
          pendientes_embedding: memorias.filter((m) => m.incorporado_a_embedding === false).length,
          ultimas: memorias.slice(0, 20),
        },
        conversaciones: conversacionesRes.data || [],
        digests: digestsRes.data || [],
        exploracion: exploracionRes.data || [],
        candidatos_semanticos: candidatosSemanticos,
      });
    } catch (err) {
      console.error('[mia] Error en /cerebro/diagnostico/usuario:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  };

  const explorarUsuarioHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ ok: false, error: 'userId invalido' });
    }

    const run = await iniciarPipelineRun(supabase, {
      stage: 'mia_explorar_usuario',
      endpoint: `/cerebro/explorar/${userId}`,
      fechaObjetivo: getFechaMadridISO(),
    });

    try {
      const result = await explorarUsuarioMIA(userId, {
        dryRun: req.body?.dryRun === true || req.query.dryRun === 'true',
        force: req.body?.force === true || req.query.force === 'true',
      });

      await cerrarPipelineRun(supabase, run, {
        status: result.ok && !result.skipped ? 'ok' : 'warning',
        procesadas: result.ok && !result.skipped && !result.dry_run ? 1 : 0,
        errores: result.ok ? 0 : 1,
        response_json: result,
      });

      return res.json(result);
    } catch (err) {
      console.error('[mia] Error en /cerebro/explorar:', err.message);
      await cerrarPipelineRun(supabase, run, {
        status: 'error',
        errores: 1,
        error_msg: err.message,
        response_json: { error: err.message },
      });
      return res.status(500).json({ ok: false, error: err.message });
    }
  };

  const cicloDiarioHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const fechaObjetivo = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || req.body?.fecha || '')
      ? (req.query.fecha || req.body.fecha)
      : getFechaMadridISO();

    const run = await iniciarPipelineRun(supabase, {
      stage: 'mia_ciclo_diario',
      endpoint: '/cerebro/ciclo-diario',
      fechaObjetivo,
    });

    try {
      const forceMock = req.body?.forceMock || req.query.forceMock === 'true';
      const dryRunExploracion = req.body?.dryRunExploracion !== false && req.query.dryRunExploracion !== 'false';

      const embeddings = await inicializarEmbeddingsAlertas({
        fechaObjetivo,
        selectLimit: req.body?.limit || req.query.limit || 100,
        maxLoops: req.body?.maxLoops || req.query.maxLoops || 10,
        forceMock,
      });

      const userIdsPendientes = await usuariosConMemoriaPendiente();
      const perfiles = [];
      for (const userId of userIdsPendientes) {
        try {
          perfiles.push(await actualizarPerfilUsuarioMIA(userId, { forceMock }));
        } catch (err) {
          perfiles.push({ ok: false, user_id: userId, error: err.message });
        }
      }

      const { data: conversacionesExpiradas, error: errExpirar } = await supabase
        .from('user_conversations')
        .update({
          estado: 'expirada',
          cerrada_at: new Date().toISOString(),
        })
        .eq('estado', 'activa')
        .lt('expira_at', new Date().toISOString())
        .select('id');

      if (errExpirar) throw errExpirar;

      const explorar = req.body?.explorar === true || req.query.explorar === 'true';
      const exploraciones = [];
      if (explorar) {
        const preguntasHoy = await contarPreguntasExploracionHoy();
        const disponibles = Math.max(0, MAX_PREGUNTAS_EXPLORACION_DIA - preguntasHoy);

        if (disponibles > 0) {
          const { data: candidatos, error: errUsuarios } = await supabase
            .from('users')
            .select('id, ultima_interaccion_at')
            .in('subscription', ['corral', 'agricultor', 'cooperativa'])
            .not('phone', 'is', null)
            .neq('phone', '')
            .order('ultima_interaccion_at', { ascending: true, nullsFirst: true })
            .limit(disponibles);

          if (errUsuarios) throw errUsuarios;

          for (const user of candidatos || []) {
            try {
              exploraciones.push(await explorarUsuarioMIA(user.id, {
                dryRun: dryRunExploracion,
                force: false,
              }));
            } catch (err) {
              exploraciones.push({ ok: false, user_id: user.id, error: err.message });
            }
          }
        }
      }

      const result = {
        ok: true,
        fecha: fechaObjetivo,
        embeddings,
        perfiles_actualizados: perfiles.filter((p) => p.ok).length,
        perfiles,
        conversaciones_expiradas: (conversacionesExpiradas || []).length,
        exploracion: {
          habilitada: explorar,
          dry_run: dryRunExploracion,
          resultados: exploraciones,
        },
      };

      await cerrarPipelineRun(supabase, run, {
        status: 'ok',
        procesadas: embeddings.actualizadas + perfiles.filter((p) => p.ok).length + exploraciones.filter((e) => e.ok && !e.skipped).length,
        errores: perfiles.filter((p) => !p.ok).length + exploraciones.filter((e) => !e.ok).length,
        response_json: result,
      });

      return res.json(result);
    } catch (err) {
      console.error('[mia] Error en /cerebro/ciclo-diario:', err.message);
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
  app.get('/cerebro/diagnostico/usuario/:userId', diagnosticoUsuarioHandler);
  app.post('/cerebro/explorar/:userId', explorarUsuarioHandler);
  app.get('/cerebro/explorar/:userId', explorarUsuarioHandler);
  app.post('/cerebro/ciclo-diario', cicloDiarioHandler);
  app.get('/cerebro/ciclo-diario', cicloDiarioHandler);
};
