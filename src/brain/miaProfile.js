const {
  inicializarOpenAI,
  generarEmbedding,
  calcularCentroidePonderado,
} = require('../utils/embeddings');
const { generarContextoNarrativo } = require('../utils/cerebro');

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

function vectorValido(vector) {
  return Array.isArray(vector) && vector.length === 1536 && vector.every((n) => Number.isFinite(Number(n)));
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

function restarVector(base, resta, factor = 0.35) {
  if (!vectorValido(base)) return null;
  if (!vectorValido(resta)) return base;
  return base.map((v, i) => Number(v) - Number(resta[i]) * factor);
}

function combinarVectores(partes) {
  const validas = partes.filter((parte) => vectorValido(parte.vector) && Number(parte.peso) > 0);
  if (validas.length === 0) return null;

  const sumaPesos = validas.reduce((acc, parte) => acc + parte.peso, 0);
  const resultado = new Array(1536).fill(0);

  for (const { vector, peso } of validas) {
    const pesoNormalizado = peso / sumaPesos;
    for (let i = 0; i < 1536; i++) resultado[i] += Number(vector[i]) * pesoNormalizado;
  }

  return resultado;
}

function ajustarContextoNarrativoPorPerfil(user = {}, contexto = '') {
  const texto = String(contexto || '').trim();
  if (!texto) return texto;

  const prefs = user.preferences || {};
  const perfil = String(prefs.perfil || '').toLowerCase();
  const sectores = Array.isArray(prefs.sectores)
    ? prefs.sectores.map((s) => String(s || '').toLowerCase())
    : [];
  const soloGanaderia = (perfil === 'ganadero' || sectores.includes('ganaderia')) && !sectores.includes('agricultura');
  const soloAgricultura = (perfil === 'agricultor' || sectores.includes('agricultura')) && !sectores.includes('ganaderia');

  if (soloGanaderia) {
    return texto
      .replace(/\bes un agricultor y ganadero\b/i, 'tiene un perfil ganadero')
      .replace(/\bes una agricultora y ganadera\b/i, 'tiene un perfil ganadero')
      .replace(/\bes agricultor y ganadero\b/i, 'tiene un perfil ganadero')
      .replace(/\bes agricultora y ganadera\b/i, 'tiene un perfil ganadero')
      .replace(/\bagricultor especializado en ganaderia\b/i, 'perfil ganadero especializado')
      .replace(/\bagricultora especializada en ganaderia\b/i, 'perfil ganadero especializado');
  }

  if (soloAgricultura) {
    return texto
      .replace(/\bes un agricultor y ganadero\b/i, 'tiene un perfil agricola')
      .replace(/\bes una agricultora y ganadera\b/i, 'tiene un perfil agricola')
      .replace(/\bes agricultor y ganadero\b/i, 'tiene un perfil agricola')
      .replace(/\bes agricultora y ganadera\b/i, 'tiene un perfil agricola')
      .replace(/\bganadero especializado en agricultura\b/i, 'perfil agricola especializado')
      .replace(/\bganadera especializada en agricultura\b/i, 'perfil agricola especializado');
  }

  return texto;
}

async function actualizarPerfilUsuarioMIA(supabase, userId, options = {}) {
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

    const centroidePositivo = positivos.length > 0 ? calcularCentroidePonderado(positivos, pesosPositivos) : null;
    const centroideNegativo = negativos.length > 0 ? calcularCentroidePonderado(negativos, pesosNegativos) : null;
    perfilFeedback = centroidePositivo ? restarVector(centroidePositivo, centroideNegativo) : null;
  }

  const textoMemoria = textoMemorias(memoriasLista);
  const embeddingMemorias = textoMemoria ? await generarEmbedding(textoMemoria, usarMock) : null;
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

  if (!vectorValido(perfilFinal)) throw new Error('No se pudo calcular un perfil embedding valido');

  let contextoNarrativo = null;
  try {
    contextoNarrativo = await generarContextoNarrativo(user, memoriasLista);
    contextoNarrativo = ajustarContextoNarrativoPorPerfil(user, contextoNarrativo);
  } catch (err) {
    console.warn(`[mia:perfil] No se pudo generar contexto narrativo user ${user.id}:`, err.message);
    contextoNarrativo = user.preferencias_extra || null;
  }

  const perfilVersion = Number(user.perfil_version || 0) + 1;
  const { error: updateError } = await supabase
    .from('users')
    .update({
      perfil_embedding: vectorToSql(perfilFinal),
      perfil_version: perfilVersion,
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
    perfil_version: perfilVersion,
    memorias_usadas: memoriasLista.length,
    feedbacks_positivos_usados: feedbacksPositivosUsados,
    feedbacks_negativos_usados: feedbacksNegativosUsados,
    memorias_textuales_usadas: textoMemoria ? memoriasLista.length - memoriasConAlerta.length : 0,
    embedding_length: perfilFinal.length,
    contexto_narrativo_actualizado: Boolean(contextoNarrativo),
    source: usarMock ? 'mock' : 'openai',
  };
}

async function actualizarPerfilUsuarioMIASafe(supabase, userId, options = {}) {
  try {
    return await actualizarPerfilUsuarioMIA(supabase, userId, options);
  } catch (err) {
    console.error(`[mia:perfil] Error no bloqueante user ${userId}:`, err.message);
    return { ok: false, user_id: userId, error: err.message };
  }
}

module.exports = {
  actualizarPerfilUsuarioMIA,
  actualizarPerfilUsuarioMIASafe,
  ajustarContextoNarrativoPorPerfil,
  parseVector,
  vectorToSql,
  vectorValido,
};
