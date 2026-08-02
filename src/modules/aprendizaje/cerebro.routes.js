const { checkCronToken } = require('../../middleware/cronToken');
const { getFechaMadridISO, getRangoDiaMadridUTC } = require('../../shared/fechaMadrid');
const {
  inicializarOpenAI,
  generarEmbeddingsBatch,
  BATCH_SIZE,
  BATCH_DELAY_MS,
} = require('../../platform/ia/embeddings');
const {

  generarPreguntaExploracion,
} = require('./cerebro');
const { diagnosticarAlertaUsuario } = require('../alertas/seleccion/alertaMatcher');
const { encolarComunicacionWhatsApp } = require('../mia/outbox');
const {
  actualizarPerfilUsuarioMIA,
  parseVector,
  vectorToSql,
  vectorValido,
} = require('./miaProfile');
const { cargarPerfilOperativoMIA } = require('../mia/userProfile');
const {
  EXPLORATION_CONTROL_PREFIX,
  construirPreguntaExploracion,
  detectarZonaIncertidumbre: detectarZonaIncertidumbreInteligente,
  estadoExploracionDesdeMemorias,
} = require('../mia/exploration');
const { generarSaludRecomendaciones } = require('../mia/recommendationHealth');

const DEFAULT_SELECT_LIMIT = 100;
const DEFAULT_MAX_LOOPS = 1;
const MAX_PREGUNTAS_EXPLORACION_DIA = Math.max(
  1,
  Math.min(100, Number(process.env.MIA_MAX_PREGUNTAS_EXPLORACION_DIA || 20))
);
const EXPLORACION_COOLDOWN_DIAS = Math.max(
  7,
  Math.min(90, Number(process.env.MIA_EXPLORACION_COOLDOWN_DIAS || 30))
);
const EXPLORACION_DIGEST_WINDOW_DIAS = clampNumber(
  process.env.MIA_EXPLORACION_DIGEST_WINDOW_DIAS,
  7,
  1,
  30
);
function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function ejecutarExploracionDiariaAcotada({
  supabase,
  contarPreguntasFn,
  explorarUsuarioFn,
  dryRun = false,
  limit = DEFAULT_SELECT_LIMIT,
  maxDaily = MAX_PREGUNTAS_EXPLORACION_DIA,
} = {}) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('Supabase no disponible para la exploracion diaria');
  }
  if (typeof contarPreguntasFn !== 'function' || typeof explorarUsuarioFn !== 'function') {
    throw new Error('Faltan dependencias de la exploracion diaria');
  }

  const limiteDiario = clampNumber(maxDaily, MAX_PREGUNTAS_EXPLORACION_DIA, 1, 100);
  const limiteCandidatos = clampNumber(limit, DEFAULT_SELECT_LIMIT, 1, 100);
  const preguntasIniciales = Math.max(0, Number(await contarPreguntasFn()) || 0);
  const disponibles = Math.max(0, limiteDiario - preguntasIniciales);
  const resultados = [];
  let candidatosConsiderados = 0;

  const resumen = () => ({
    ok: resultados.every((item) => item.ok !== false),
    dry_run: Boolean(dryRun),
    limite_diario: limiteDiario,
    preguntas_iniciales: preguntasIniciales,
    disponibles,
    candidatos_considerados: candidatosConsiderados,
    evaluados: resultados.length,
    seleccionados: resultados.filter((item) => item.ok && !item.skipped).length,
    encoladas: resultados.filter((item) => item.encolada === true).length,
    errores: resultados.filter((item) => item.ok === false).length,
    resultados,
  });

  if (disponibles === 0) return resumen();

  const scanLimit = Math.min(
    limiteCandidatos,
    Math.max(disponibles * 5, disponibles)
  );
  const { data: candidatos, error } = await supabase
    .from('users')
    .select('id, ultima_interaccion_at')
    .in('subscription', ['corral', 'agricultor', 'cooperativa'])
    .not('phone', 'is', null)
    .neq('phone', '')
    .or('phone_verified.is.null,phone_verified.eq.true')
    .order('ultima_interaccion_at', { ascending: true, nullsFirst: true })
    .limit(scanLimit);

  if (error) throw error;
  candidatosConsiderados = (candidatos || []).length;

  for (const user of candidatos || []) {
    if (resultados.filter((item) => item.ok && !item.skipped).length >= disponibles) break;
    try {
      resultados.push(await explorarUsuarioFn(user.id, {
        dryRun: Boolean(dryRun),
        force: false,
      }));
    } catch (err) {
      resultados.push({ ok: false, user_id: user.id, error: err.message });
    }
  }

  return resumen();
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

function restarDiasFechaISO(fechaISO, dias) {
  const [year, month, day] = String(fechaISO || '').split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return fechaISO;
  return new Date(Date.UTC(year, month - 1, day - dias, 12, 0, 0))
    .toISOString()
    .slice(0, 10);
}

async function cargarUltimoDigestEntregadoParaExploracion(supabase, userId, {
  now = new Date(),
  windowDays = EXPLORACION_DIGEST_WINDOW_DIAS,
} = {}) {
  const fechaActual = getFechaMadridISO(now);
  const dias = clampNumber(windowDays, EXPLORACION_DIGEST_WINDOW_DIAS, 1, 30);
  const fechaDesde = restarDiasFechaISO(fechaActual, dias - 1);
  const { data, error } = await supabase
    .from('digests')
    .select('id, fecha, delivery_status, delivered_at, read_at, created_at')
    .eq('user_id', userId)
    .in('delivery_status', ['DELIVERED', 'READ'])
    .gte('fecha', fechaDesde)
    .lte('fecha', fechaActual)
    .order('fecha', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function digestYaExplorado(supabase, userId, digestId) {
  if (!digestId) return false;
  const { data, error } = await supabase
    .from('mia_outbox')
    .select('id')
    .eq('user_id', userId)
    .contains('metadata_json', {
      intent: 'learning_question',
      digest_id: digestId,
    })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.id);
}

async function cargarUltimoControlExploracion(supabase, userId) {
  const controles = ['active', 'paused', 'snoozed']
    .map((estado) => `${EXPLORATION_CONTROL_PREFIX}${estado}`);
  const { data, error } = await supabase
    .from('user_memory')
    .select('id, tipo, contenido, status, created_at, last_seen_at')
    .eq('user_id', userId)
    .eq('status', 'active')
    .in('contenido', controles)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
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

  async function contarPreguntasExploracionHoy() {
    const { inicio, fin } = getRangoDiaMadridUTC(getFechaMadridISO());
    const [memories, pending] = await Promise.all([
      supabase
        .from('user_memory')
        .select('id', { count: 'exact', head: true })
        .eq('tipo', 'pregunta_sistema')
        .gte('created_at', inicio)
        .lt('created_at', fin),
      supabase
        .from('mia_outbox')
        .select('id', { count: 'exact', head: true })
        .contains('metadata_json', { intent: 'learning_question' })
        .in('delivery_status', ['QUEUED', 'PROVIDER_ACCEPTED', 'SENT_TO_WHATSAPP'])
        .gte('created_at', inicio)
        .lt('created_at', fin),
    ]);

    if (memories.error) throw memories.error;
    if (pending.error) throw pending.error;
    return Number(memories.count || 0) + Number(pending.count || 0);
  }

  async function tienePreguntaExploracionReciente(userId) {
    const desde = restarDias(new Date(), EXPLORACION_COOLDOWN_DIAS).toISOString();
    const [memories, pending] = await Promise.all([
      supabase
        .from('user_memory')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('tipo', 'pregunta_sistema')
        .gte('created_at', desde),
      supabase
        .from('mia_outbox')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .contains('metadata_json', { intent: 'learning_question' })
        .in('delivery_status', ['QUEUED', 'PROVIDER_ACCEPTED', 'SENT_TO_WHATSAPP', 'DELIVERED', 'READ'])
        .gte('created_at', desde),
    ]);

    if (memories.error) throw memories.error;
    if (pending.error) throw pending.error;
    return Number(memories.count || 0) + Number(pending.count || 0) > 0;
  }

  async function explorarUsuarioMIA(userId, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const force = Boolean(options.force);

    const { data: user, error: errUser } = await supabase
      .from('users')
      .select('id, name, phone, subscription, preferences, preferencias_extra, contexto_narrativo, ultima_interaccion_at, phone_verified, organization_id')
      .eq('id', userId)
      .maybeSingle();

    if (errUser) throw errUser;
    if (!user) return { ok: false, reason: 'usuario_no_encontrado', user_id: userId };
    if (!user.phone) return { ok: false, reason: 'usuario_sin_telefono', user_id: userId };
    if (user.phone_verified === false) return { ok: false, reason: 'telefono_no_verificado', user_id: userId };

    const [memoriasResult, ultimoControlExploracion] = await Promise.all([
      supabase
        .from('user_memory')
        .select('id, tipo, contenido, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50),
      cargarUltimoControlExploracion(supabase, userId),
    ]);
    const { data: memorias, error: errMemorias } = memoriasResult;

    if (errMemorias) throw errMemorias;

    const memoriaLista = memorias || [];
    const estadoExploracion = estadoExploracionDesdeMemorias(
      ultimoControlExploracion ? [ultimoControlExploracion] : memoriaLista
    );
    if (!force && estadoExploracion === 'paused') {
      return {
        ok: true,
        skipped: true,
        reason: 'preguntas_automaticas_desactivadas_por_usuario',
        user_id: userId,
      };
    }

    const perfilOperativo = await cargarPerfilOperativoMIA(supabase, userId, { user });
    const tieneConflictos = (perfilOperativo.uncertain_topics || []).length > 0;
    const elegible = force || tieneConflictos;

    if (!elegible) {
      return {
        ok: true,
        skipped: true,
        reason: 'usuario_no_elegible',
        user_id: userId,
        detail: 'sin_contradicciones_importantes',
        memoria_total: memoriaLista.length,
        ultima_interaccion_at: user.ultima_interaccion_at,
      };
    }

    let digestElegible = null;
    if (!force) {
      digestElegible = await cargarUltimoDigestEntregadoParaExploracion(supabase, userId);
      if (!digestElegible) {
        return {
          ok: true,
          skipped: true,
          reason: 'sin_digest_entregado_reciente',
          user_id: userId,
          ventana_dias: EXPLORACION_DIGEST_WINDOW_DIAS,
        };
      }
      if (await digestYaExplorado(supabase, userId, digestElegible.id)) {
        return {
          ok: true,
          skipped: true,
          reason: 'digest_ya_explorado',
          user_id: userId,
          digest_id: digestElegible.id,
        };
      }
    }

    if (!force && await tienePreguntaExploracionReciente(userId)) {
      return {
        ok: true,
        skipped: true,
        reason: 'cooldown_exploracion_usuario',
        user_id: userId,
        cooldown_dias: EXPLORACION_COOLDOWN_DIAS,
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

    const zonaIncertidumbre = detectarZonaIncertidumbreInteligente({
      user,
      memorias: memoriaLista,
      perfil: perfilOperativo,
    });
    const pregunta = zonaIncertidumbre.topic
      ? construirPreguntaExploracion(zonaIncertidumbre)
      : await generarPreguntaExploracion(user, zonaIncertidumbre);

    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        user_id: userId,
        zona_incertidumbre: zonaIncertidumbre,
        pregunta,
        preguntas_hoy: preguntasHoy,
        digest_id: digestElegible?.id || null,
      };
    }

    const queuedQuestion = await encolarComunicacionWhatsApp(supabase, {
      source: 'mia_exploration_question',
      sourceId: digestElegible?.id
        ? `digest:${digestElegible.id}:user:${userId}`
        : `${getFechaMadridISO()}:${userId}:${zonaIncertidumbre.topic || 'general'}`,
      userId,
      toPhone: user.phone,
      body: pregunta,
      organizationId: user.organization_id || null,
      metadata: {
        intent: 'learning_question',
        topic: zonaIncertidumbre.topic || 'general',
        confidence: zonaIncertidumbre.confidence || null,
        zona_incertidumbre: zonaIncertidumbre,
        digest_id: digestElegible?.id || null,
        digest_fecha: digestElegible?.fecha || null,
      },
    });
    if (!queuedQuestion.ok || (!queuedQuestion.queued && !queuedQuestion.existing)) {
      throw new Error(queuedQuestion.error || queuedQuestion.reason || 'exploration_outbox_unavailable');
    }

    return {
      ok: true,
      user_id: userId,
      pregunta,
      outbox_id: queuedQuestion.id || null,
      encolada: Boolean(queuedQuestion.queued),
      zona_incertidumbre: zonaIncertidumbre,
      memoria_id: null,
      conversacion_id: null,
      pending_delivery: true,
      preguntas_hoy: preguntasHoy + 1,
      digest_id: digestElegible?.id || null,
    };
  }

  async function usuariosConMemoriaPendiente() {
    const { data: memoriasLegacy, error } = await supabase
      .from('user_memory')
      .select('user_id, created_at')
      .eq('incorporado_a_embedding', false)
      .order('created_at', { ascending: false })
      .limit(2000);

    if (error) throw error;

    const { data: memoriasEstructuradasData, error: structuredError } = await supabase
      .from('mia_structured_memory')
      .select('user_id, last_seen_at')
      .is('incorporated_at', null)
      .order('last_seen_at', { ascending: false })
      .limit(2000);

    if (structuredError) throw structuredError;
    const memoriasEstructuradas = memoriasEstructuradasData || [];

    return [...new Set([
      ...(memoriasLegacy || []),
      ...memoriasEstructuradas,
    ].map((m) => Number(m.user_id)).filter(Boolean))];
  }

  async function usuariosSinPerfil(limit = 25) {
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .is('perfil_embedding', null)
      .order('id', { ascending: true })
      .limit(limit);

    if (error) throw error;
    return (data || []).map((u) => Number(u.id)).filter(Boolean);
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
      const result = await actualizarPerfilUsuarioMIA(supabase, userId, {
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

        if (error) {
          candidatosSemanticos = { ok: false, error: error.message };
        } else {
          const alertasDiagnosticadas = (data || []).map((a) => {
            const diagnostico = diagnosticarAlertaUsuario(a, user);
            return {
              id: a.id,
              titulo: a.titulo,
              fuente: a.fuente,
              provincias: a.provincias,
              sectores: a.sectores,
              subsectores: a.subsectores,
              tipos_alerta: a.tipos_alerta,
              similitud: Number(a.similitud),
              pasa_filtros_duros: diagnostico.ok,
              motivo_filtro: diagnostico.motivo,
              detalle_filtro: diagnostico.detalle || null,
            };
          });

          candidatosSemanticos = {
            ok: true,
            fecha,
            total_radar_semantico: alertasDiagnosticadas.length,
            pasan_filtros_duros: alertasDiagnosticadas.filter((a) => a.pasa_filtros_duros),
            descartadas_por_filtro: alertasDiagnosticadas.filter((a) => !a.pasa_filtros_duros),
          };
        }
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

  const backfillPerfilesHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const limit = clampNumber(req.body?.limit || req.query.limit, 25, 1, 100);
    const forceMock = req.body?.forceMock || req.query.forceMock === 'true';
    const run = await iniciarPipelineRun(supabase, {
      stage: 'mia_backfill_perfiles',
      endpoint: '/cerebro/perfil/backfill',
      fechaObjetivo: getFechaMadridISO(),
    });

    try {
      const userIds = await usuariosSinPerfil(limit);
      const resultados = [];

      for (const userId of userIds) {
        try {
          resultados.push(await actualizarPerfilUsuarioMIA(supabase, userId, { forceMock }));
        } catch (err) {
          resultados.push({ ok: false, user_id: userId, error: err.message });
        }
      }

      const result = {
        ok: resultados.every((r) => r.ok),
        solicitados: userIds.length,
        actualizados: resultados.filter((r) => r.ok).length,
        errores: resultados.filter((r) => !r.ok),
        resultados,
      };

      await cerrarPipelineRun(supabase, run, {
        status: result.errores.length ? 'warning' : 'ok',
        procesadas: result.actualizados,
        errores: result.errores.length,
        response_json: result,
      });

      return res.json(result);
    } catch (err) {
      console.error('[mia] Error en /cerebro/perfil/backfill:', err.message);
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
      const dryRunExploracion = req.body?.dryRunExploracion === true || req.query.dryRunExploracion === 'true';

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
          perfiles.push(await actualizarPerfilUsuarioMIA(supabase, userId, { forceMock }));
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

      const saludRecomendaciones = await generarSaludRecomendaciones(supabase, {
        days: req.body?.healthDays || req.query.healthDays || 14,
        persist: true,
      });

      const explorar = req.body?.explorar === true || req.query.explorar === 'true';
      const exploracion = explorar
        ? await ejecutarExploracionDiariaAcotada({
          supabase,
          contarPreguntasFn: contarPreguntasExploracionHoy,
          explorarUsuarioFn: explorarUsuarioMIA,
          dryRun: dryRunExploracion,
          limit: req.body?.limit || req.query.limit || 100,
        })
        : {
          ok: true,
          dry_run: dryRunExploracion,
          evaluados: 0,
          seleccionados: 0,
          encoladas: 0,
          errores: 0,
          resultados: [],
        };

      const result = {
        ok: true,
        fecha: fechaObjetivo,
        embeddings,
        perfiles_actualizados: perfiles.filter((p) => p.ok).length,
        perfiles,
        conversaciones_expiradas: (conversacionesExpiradas || []).length,
        salud_recomendaciones: saludRecomendaciones,
        exploracion: {
          habilitada: explorar,
          ...exploracion,
        },
      };

      await cerrarPipelineRun(supabase, run, {
        status: saludRecomendaciones.status === 'critical' ? 'warning' : 'ok',
        procesadas: embeddings.actualizadas + perfiles.filter((p) => p.ok).length + exploracion.seleccionados,
        errores: perfiles.filter((p) => !p.ok).length + exploracion.errores,
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

  const exploracionDiariaHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const fechaObjetivo = getFechaMadridISO();
    const run = await iniciarPipelineRun(supabase, {
      stage: 'mia_exploracion_diaria',
      endpoint: '/cerebro/exploracion-diaria',
      fechaObjetivo,
    });

    try {
      const result = await ejecutarExploracionDiariaAcotada({
        supabase,
        contarPreguntasFn: contarPreguntasExploracionHoy,
        explorarUsuarioFn: explorarUsuarioMIA,
        dryRun: req.body?.dryRun === true || req.query.dryRun === 'true',
        limit: req.body?.limit || req.query.limit || 100,
      });
      const response = { fecha: fechaObjetivo, ...result };

      await cerrarPipelineRun(supabase, run, {
        status: result.errores > 0 ? 'warning' : 'ok',
        procesadas: result.evaluados,
        errores: result.errores,
        response_json: response,
      });

      return res.json(response);
    } catch (err) {
      console.error('[mia] Error en /cerebro/exploracion-diaria:', err.message);
      await cerrarPipelineRun(supabase, run, {
        status: 'error',
        errores: 1,
        error_msg: err.message,
        response_json: { error: err.message },
      });
      return res.status(500).json({ ok: false, error: err.message });
    }
  };

  const saludRecomendacionesHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;
    try {
      const report = await generarSaludRecomendaciones(supabase, {
        days: req.body?.days || req.query.days || 14,
        persist: req.body?.persist !== false && req.query.persist !== 'false',
      });
      return res.json({ ok: true, ...report });
    } catch (error) {
      console.error('[mia] Error en /cerebro/salud-recomendaciones:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }
  };

  app.post('/cerebro/embeddings/inicializar', inicializarEmbeddingsHandler);
  app.post('/cerebro/perfil/actualizar/:userId', actualizarPerfilHandler);
  app.post('/cerebro/perfil/backfill', backfillPerfilesHandler);
  app.get('/cerebro/diagnostico/usuario/:userId', diagnosticoUsuarioHandler);
  app.post('/cerebro/explorar/:userId', explorarUsuarioHandler);
  app.post('/cerebro/exploracion-diaria', exploracionDiariaHandler);
  app.post('/cerebro/ciclo-diario', cicloDiarioHandler);
  app.post('/cerebro/salud-recomendaciones', saludRecomendacionesHandler);
};

module.exports.ejecutarExploracionDiariaAcotada = ejecutarExploracionDiariaAcotada;
module.exports.cargarUltimoDigestEntregadoParaExploracion = cargarUltimoDigestEntregadoParaExploracion;
module.exports.digestYaExplorado = digestYaExplorado;
module.exports.cargarUltimoControlExploracion = cargarUltimoControlExploracion;
