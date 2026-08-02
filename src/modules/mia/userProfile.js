const {
  construirPerfilIntereses,
  tagsAlerta,
} = require('../aprendizaje/userInterestProfile');
const { construirPreferenciasDesdeTexto } = require('../aprendizaje/taxonomiaRuralicos');
const {
  aplicarDecayMemoria,
  inferirTopic,
  inferirPolarity,
} = require('../aprendizaje/atomicMemory');

const PROFILE_VERSION = 'mia_user_profile_v1';
const DURABLE_EXPLICIT_MEMORY_SOURCES = Object.freeze(['response', 'preference_edit']);
const DURABLE_EXPLICIT_MEMORY_SCOPES = Object.freeze([
  'topic',
  'subsector',
  'territory',
  'frequency',
  'channel',
  'activity',
]);
const DURABLE_EXPLICIT_MEMORY_LIMIT = 1000;
const USER_MEMORY_SELECT = [
  'id',
  'memory_key',
  'tipo',
  'contenido',
  'scope_type',
  'scope_value',
  'polarity',
  'source',
  'strength',
  'confidence',
  'status',
  'expires_at',
  'duplicate_count',
  'peso_inicial',
  'created_at',
  'last_seen_at',
  'updated_at',
].join(', ');

const TOPIC_ALIASES = {
  pac: ['pac', 'politica agraria comun', 'fega', 'feaga', 'feader', 'sigpac', 'ecoregimen'],
  ayudas_maquinaria: ['tractor', 'tractores', 'maquinaria', 'apero', 'aperos', 'modernizacion'],
  ayudas_subvenciones: ['ayuda', 'ayudas', 'subvencion', 'subvenciones', 'convocatoria', 'prima', 'indemnizacion'],
  agua_riego: ['agua', 'riego', 'regadio', 'pozo', 'pozos', 'concesion de aguas', 'regantes'],
  olivar: ['olivar', 'olivo', 'olivos', 'aceituna', 'aceitunas'],
  porcino: ['porcino', 'cerdo', 'cerdos'],
  vacuno: ['vacuno', 'vaca', 'vacas', 'bovino', 'bovinos'],
  ovino: ['ovino', 'oveja', 'ovejas', 'cordero', 'corderos'],
  caprino: ['caprino', 'cabra', 'cabras'],
  apicultura: ['apicultura', 'abejas', 'colmenas'],
  cereal: ['cereal', 'cereales', 'trigo', 'cebada', 'maiz'],
  frutales: ['frutales', 'fruta', 'frutal'],
  vinedo: ['vinedo', 'vinedo', 'vina', 'vina', 'uva', 'vitivinicola'],
  formacion: ['curso', 'cursos', 'formacion', 'jornada', 'jornadas'],
  medio_ambiente: ['medio ambiente', 'ambiental', 'forestal', 'monte', 'biodiversidad'],
  plazos: ['plazo', 'plazos', 'fecha limite', 'dias habiles', 'presentacion de solicitudes'],
  normativa_general: ['normativa', 'norma', 'orden', 'decreto', 'resolucion'],
  general: [],
};

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function limpiarLista(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function pesoTemporal(fecha) {
  const date = new Date(fecha || Date.now());
  if (Number.isNaN(date.getTime())) return 0.7;
  const dias = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
  if (dias <= 30) return 1;
  if (dias <= 90) return 0.7;
  if (dias <= 180) return 0.45;
  return 0.22;
}

function extraerExclusiones(texto = '') {
  const value = normalizar(texto);
  if (!value) return [];

  const patrones = [
    /no me interesa ([^.!,;\n]+)/g,
    /no quiero ([^.!,;\n]+)/g,
    /evitar ([^.!,;\n]+)/g,
    /no enviar ([^.!,;\n]+)/g,
    /no mand(?:es|ar) ([^.!,;\n]+)/g,
  ];

  const exclusiones = [];
  for (const regex of patrones) {
    for (const match of value.matchAll(regex)) {
      String(match[1] || '')
        .split(/,| y | e | o | u | ni /g)
        .map((item) => item.trim())
        .filter((item) => item.length >= 3)
        .forEach((item) => exclusiones.push(item));
    }
  }

  return [...new Set(exclusiones)].slice(0, 20);
}

function preferenciasDeclaradas(user = {}) {
  const prefs = user.preferences || {};
  const tiposActivos = Object.entries(prefs.tipos_alerta || {})
    .filter(([, activo]) => activo === true)
    .map(([tipo]) => tipo);
  const textoTaxonomia = [
    prefs.perfil,
    user.preferencias_extra,
    ...(Array.isArray(prefs.provincias) ? prefs.provincias : []),
    ...(Array.isArray(prefs.sectores) ? prefs.sectores : []),
    ...(Array.isArray(prefs.subsectores) ? prefs.subsectores : []),
    ...tiposActivos,
  ].filter(Boolean).join(' ');
  const taxonomia = construirPreferenciasDesdeTexto(textoTaxonomia, { minScore: 0 });
  const exclusionesTaxonomia = [
    ...(taxonomia.exclusiones?.temas || []),
    ...(taxonomia.exclusiones?.tags || []),
  ]
    .map((item) => String(item || '').replace(/^[^:]+:/, '').replace(/_/g, ' ').trim())
    .filter((item) => item.length >= 3);

  return {
    provincias: limpiarLista(prefs.provincias),
    sectores: limpiarLista(prefs.sectores),
    subsectores: limpiarLista(prefs.subsectores),
    tipos_alerta: limpiarLista(tiposActivos),
    perfil: String(prefs.perfil || '').trim() || null,
    texto_libre: String(user.preferencias_extra || '').trim() || null,
    exclusiones_texto: [...new Set([
      ...extraerExclusiones(user.preferencias_extra),
      ...exclusionesTaxonomia,
    ])].slice(0, 30),
    taxonomia: {
      confidence: taxonomia.confidence || 0,
      intereses: limpiarLista(taxonomia.intereses || []),
      conceptos: limpiarLista(taxonomia.conceptos || []),
      entidades: limpiarLista(taxonomia.entidades || []),
      acciones: limpiarLista(taxonomia.acciones || []),
      tramites: limpiarLista(taxonomia.tramites || []),
      conflictos: (taxonomia.conflictos || []).map((item) => item.id).filter(Boolean).slice(0, 12),
    },
  };
}

function sumarTema(map, topic, delta, source, evidence = null) {
  const key = topic || 'general';
  const actual = map.get(key) || {
    topic: key,
    score: 0,
    positive: 0,
    negative: 0,
    evidence_count: 0,
    sources: new Set(),
    examples: [],
  };

  actual.score += Number(delta) || 0;
  if (delta > 0) actual.positive += Math.abs(delta);
  if (delta < 0) actual.negative += Math.abs(delta);
  actual.evidence_count += 1;
  if (source) actual.sources.add(source);
  if (evidence && actual.examples.length < 3) actual.examples.push(String(evidence).slice(0, 180));
  map.set(key, actual);
}

function temaDesdeTag(tag = '') {
  const limpio = normalizar(tag);
  if (limpio.includes('pac') || limpio.includes('fega')) return 'pac';
  if (/(tractor|maquinaria|apero)/.test(limpio)) return 'ayudas_maquinaria';
  if (/(ayuda|subvencion|convocatoria|pago|indemnizacion)/.test(limpio)) return 'ayudas_subvenciones';
  if (/(plazo|fecha limite|dias habiles|presentacion de solicitudes)/.test(limpio)) return 'plazos';
  if (/(agua|riego|regadio|pozo|regantes)/.test(limpio)) return 'agua_riego';
  if (/oliv/.test(limpio)) return 'olivar';
  if (/porcino|cerdo/.test(limpio)) return 'porcino';
  if (/vacuno|bovino|vaca/.test(limpio)) return 'vacuno';
  if (/ovino|oveja|cordero/.test(limpio)) return 'ovino';
  if (/caprino|cabra/.test(limpio)) return 'caprino';
  if (/apicultura|abeja|colmena/.test(limpio)) return 'apicultura';
  if (/cereal|trigo|cebada|maiz/.test(limpio)) return 'cereal';
  if (/frutal|fruta/.test(limpio)) return 'frutales';
  if (/vinedo|vina|uva|vitivin/.test(limpio)) return 'vinedo';
  if (/formacion|curso|jornada/.test(limpio)) return 'formacion';
  if (/medio ambiente|ambiental|forestal|monte|biodiversidad/.test(limpio)) return 'medio_ambiente';
  if (/normativa|norma|orden|decreto|resolucion/.test(limpio)) return 'normativa_general';
  return limpio || 'general';
}

function sumarPreferenciasDeclaradas(temas, declared = {}) {
  const add = (items, delta, source) => {
    for (const item of items || []) {
      const topic = temaDesdeTag(item);
      if (topic && topic !== 'general') sumarTema(temas, topic, delta, source, item);
    }
  };

  add(declared.sectores, 0.45, 'declared_preferences');
  add(declared.subsectores, 0.9, 'declared_preferences');
  add(declared.tipos_alerta, 0.65, 'declared_preferences');
  add(declared.taxonomia?.intereses, 0.85, 'declared_text_taxonomy');
  add(declared.taxonomia?.conceptos, 0.75, 'declared_text_taxonomy');
  add(declared.taxonomia?.entidades, 0.7, 'declared_text_taxonomy');
  add(declared.taxonomia?.acciones, 0.45, 'declared_text_taxonomy');
  add(declared.taxonomia?.tramites, 0.45, 'declared_text_taxonomy');
}

function normalizarTemaEntry(entry) {
  const positive = Number(entry.positive || 0);
  const negative = Number(entry.negative || 0);
  const conflictRatio = positive > 0 && negative > 0
    ? Math.min(positive, negative) / Math.max(positive, negative)
    : 0;
  const conflicted = positive >= 0.35 && negative >= 0.35 && conflictRatio >= 0.3;
  const declared = entry.sources.has('declared_preferences') ||
    entry.sources.has('declared_text_taxonomy');
  return {
    ...entry,
    score: Number(entry.score.toFixed(3)),
    confidence: conflicted
      ? clamp((Math.abs(entry.score) / 4) * (1 - conflictRatio), 0.05, 0.45)
      : clamp(Math.abs(entry.score) / 4, 0.15, 1),
    polarity: conflicted ? 'mixed' : (entry.score >= 0 ? 'positive' : 'negative'),
    conflicted,
    conflict_ratio: Number(conflictRatio.toFixed(3)),
    declared,
    declared_conflict: declared && negative >= 0.35,
    sources: [...entry.sources],
  };
}

function construirPerfilOperativoMIA({
  user = {},
  interestRows = [],
  legacyMemories = [],
  structuredMemories = [],
} = {}) {
  const declared = preferenciasDeclaradas(user);
  const temas = new Map();
  const rawTagScores = {};
  const facts = [];

  sumarPreferenciasDeclaradas(temas, declared);

  for (const row of interestRows || []) {
    const tag = String(row.tag || '').trim();
    if (!tag) continue;
    const score = clamp(Number(row.score || 0) / 4, -4, 4);
    rawTagScores[normalizar(tag)] = score;
    sumarTema(temas, temaDesdeTag(tag), score, 'user_interest_profile', tag);
  }

  for (const memory of structuredMemories || []) {
    const topic = memory.topic || inferirTopic(memory.detail);
    const polarity = memory.polarity || inferirPolarity(memory.memory_type);
    const sign = polarity === 'negative' ? -1 : polarity === 'positive' ? 1 : 0.35;
    const duplicateBoost = 1 + Math.min(5, Number(memory.duplicate_count || 0)) * 0.08;
    const confidence = clamp(memory.confidence || 0.5, 0.1, 1);
    const delta = sign * confidence * pesoTemporal(memory.last_seen_at || memory.created_at) * duplicateBoost;
    sumarTema(temas, topic, delta, 'mia_structured_memory', memory.detail);

    if (['dato_explotacion', 'evento_estacional'].includes(memory.memory_type) && facts.length < 8) {
      facts.push({
        topic,
        detail: String(memory.detail || '').slice(0, 220),
        confidence,
        source: 'mia_structured_memory',
      });
    }
  }

  for (const memory of legacyMemories || []) {
    if (memory.status && memory.status !== 'active') continue;

    const canonical = Boolean(memory.memory_key || memory.scope_type);
    const decayed = aplicarDecayMemoria(memory);
    if (decayed.expired || decayed.effective_strength <= 0.01) continue;

    const topic = ['topic', 'subsector', 'activity'].includes(memory.scope_type)
      ? memory.scope_value
      : inferirTopic(memory.contenido);
    const polarity = memory.polarity || inferirPolarity(memory.tipo);
    const sign = polarity === 'negative' ? -1 : polarity === 'positive' ? 1 : 0.25;
    const confidence = clamp(memory.confidence || memory.peso_inicial || 0.5, 0.1, 1);
    const strength = canonical
      ? decayed.effective_strength
      : pesoTemporal(memory.created_at);
    const duplicateBoost = 1 + Math.min(3, Number(memory.duplicate_count || 0)) * 0.05;
    const delta = sign * confidence * strength * duplicateBoost;

    // Una respuesta sobre una alerta concreta solo gobierna esa alerta. Para
    // aprender el tema hace falta otra memoria con scope topic/subsector.
    if (memory.scope_type !== 'alert') {
      sumarTema(temas, topic, delta, `user_memory:${memory.source || 'legacy'}`, memory.contenido);
    }

    if (memory.tipo === 'dato_explotacion' && facts.length < 8) {
      facts.push({
        topic,
        detail: String(memory.contenido || '').slice(0, 220),
        confidence,
        source: 'user_memory',
      });
    }
  }

  const temasOrdenados = [...temas.values()]
    .map(normalizarTemaEntry)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  const interests = temasOrdenados
    .filter((item) => !item.conflicted && item.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const dislikes = temasOrdenados
    .filter((item) => !item.conflicted && !item.declared && item.score < -0.25)
    .sort((a, b) => a.score - b.score)
    .slice(0, 10);

  const uncertainTopics = temasOrdenados
    .filter((item) => item.conflicted || item.declared_conflict)
    .sort((a, b) => b.conflict_ratio - a.conflict_ratio)
    .slice(0, 10);

  const hardFilters = {
    provincias: declared.provincias,
    sectores: declared.sectores,
    subsectores: declared.subsectores,
    tipos_alerta: declared.tipos_alerta,
    exclusiones_texto: declared.exclusiones_texto,
  };

  const promptBlock = construirBloquePerfilOperativoMIA({
    declared,
    interests,
    dislikes,
    uncertainTopics,
    facts,
  });

  return {
    version: PROFILE_VERSION,
    generated_at: new Date().toISOString(),
    user_id: user.id || null,
    organization_id: user.organization_id || user.mia_organization_context?.organization_id || null,
    subscription: user.subscription || null,
    organization: user.mia_organization_context || null,
    declared,
    hard_filters: hardFilters,
    interests,
    dislikes,
    uncertain_topics: uncertainTopics,
    facts,
    raw_tag_scores: rawTagScores,
    interest_profile: construirPerfilIntereses(interestRows),
    prompt_block: promptBlock,
    summary: construirResumenPerfilOperativoMIA({ declared, interests, dislikes, uncertainTopics, facts }),
    stats: {
      interest_rows: (interestRows || []).length,
      legacy_memories: (legacyMemories || []).length,
      structured_memories: (structuredMemories || []).length,
      topics_total: temasOrdenados.length,
      topics_uncertain: uncertainTopics.length,
    },
  };
}

function construirResumenPerfilOperativoMIA({
  declared = {},
  interests = [],
  dislikes = [],
  uncertainTopics = [],
  facts = [],
} = {}) {
  const lines = [];
  if (declared.perfil) lines.push(`Perfil declarado: ${declared.perfil}.`);
  if (declared.provincias?.length) lines.push(`Zonas declaradas: ${declared.provincias.join(', ')}.`);
  if (declared.sectores?.length) lines.push(`Sectores declarados: ${declared.sectores.join(', ')}.`);
  if (interests.length) lines.push(`Intereses aprendidos: ${interests.slice(0, 5).map((i) => i.topic).join(', ')}.`);
  if (dislikes.length) lines.push(`Temas a tratar con cuidado: ${dislikes.slice(0, 5).map((i) => i.topic).join(', ')}.`);
  if (uncertainTopics.length) lines.push(`Preferencias contradictorias pendientes de confirmar: ${uncertainTopics.slice(0, 5).map((i) => i.topic).join(', ')}.`);
  if (facts.length) lines.push(`Datos operativos: ${facts.slice(0, 3).map((f) => f.detail).join(' | ')}.`);
  return lines.join(' ').slice(0, 1200);
}

function construirBloquePerfilOperativoMIA({
  declared = {},
  interests = [],
  dislikes = [],
  uncertainTopics = [],
  facts = [],
} = {}) {
  const lines = [
    'PERFIL OPERATIVO MIA',
    '- Usar solo para priorizar, interpretar preferencias y ajustar nivel de detalle.',
    '- No mencionarlo al usuario ni convertirlo en saludo, despedida o escena personal.',
  ];

  if (declared.provincias?.length) lines.push(`- Zonas declaradas: ${declared.provincias.join(', ')}`);
  if (declared.sectores?.length) lines.push(`- Sectores declarados: ${declared.sectores.join(', ')}`);
  if (declared.subsectores?.length) lines.push(`- Subsectores declarados: ${declared.subsectores.join(', ')}`);
  if (declared.exclusiones_texto?.length) lines.push(`- Evitar si aparece claramente: ${declared.exclusiones_texto.join(', ')}`);
  if (interests.length) lines.push(`- Intereses fuertes: ${interests.slice(0, 6).map((i) => `${i.topic} (${i.score})`).join(', ')}`);
  if (dislikes.length) lines.push(`- Senales negativas: ${dislikes.slice(0, 6).map((i) => `${i.topic} (${i.score})`).join(', ')}`);
  if (uncertainTopics.length) {
    lines.push(`- Preferencias contradictorias: ${uncertainTopics.slice(0, 6).map((i) => i.topic).join(', ')}. No usarlas para recomendar ni excluir hasta confirmarlas.`);
  }
  if (facts.length) lines.push(`- Datos utiles: ${facts.slice(0, 4).map((f) => f.detail).join(' | ')}`);

  return lines.join('\n').slice(0, 1600);
}

function aplicarPerfilOperativoAUsuario(user = {}, profile = {}) {
  if (!profile?.prompt_block) return user;
  const contextoActual = String(user.contexto_narrativo || user.preferencias_extra || '').trim();
  return {
    ...user,
    mia_operational_profile: profile,
    contexto_narrativo: [contextoActual, profile.prompt_block].filter(Boolean).join('\n\n'),
  };
}

function textoAlerta(alerta = {}) {
  return [
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen,
    alerta.contenido,
    alerta.fuente,
    ...(Array.isArray(alerta.provincias) ? alerta.provincias : []),
    ...(Array.isArray(alerta.sectores) ? alerta.sectores : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
    ...(Array.isArray(alerta.taxonomy_tags) ? alerta.taxonomy_tags : []),
  ].filter(Boolean).map(normalizar).join(' ');
}

function topicMatch(topic, texto) {
  const aliases = TOPIC_ALIASES[topic] || [topic];
  return aliases.some((alias) => alias && texto.includes(normalizar(alias)));
}

function puntuarAlertaConPerfilOperativoMIA(alerta = {}, profile = {}) {
  const texto = textoAlerta(alerta);
  const reasons = [];
  let score = 0;
  let excluded = false;

  for (const exclusion of profile.hard_filters?.exclusiones_texto || []) {
    if (exclusion && texto.includes(normalizar(exclusion))) {
      excluded = true;
      reasons.push(`exclusion:${exclusion}`);
      score -= 100;
    }
  }

  const tags = tagsAlerta(alerta).map(normalizar);
  for (const tag of tags) {
    const tagScore = Number(profile.raw_tag_scores?.[tag] || 0);
    if (tagScore) {
      score += tagScore;
      reasons.push(`tag:${tag}:${tagScore.toFixed(2)}`);
    }
  }

  for (const interest of profile.interests || []) {
    if (topicMatch(interest.topic, texto)) {
      const delta = Math.min(6, Number(interest.score || 0));
      score += delta;
      reasons.push(`interest:${interest.topic}:${delta.toFixed(2)}`);
    }
  }

  for (const dislike of profile.dislikes || []) {
    if (topicMatch(dislike.topic, texto)) {
      const delta = Math.min(8, Math.abs(Number(dislike.score || 0)));
      score -= delta;
      reasons.push(`dislike:${dislike.topic}:${delta.toFixed(2)}`);
    }
  }

  return {
    score: Number(score.toFixed(3)),
    excluded,
    reasons,
  };
}

function ordenarAlertasConPerfilOperativoMIA(alertas = [], profile = {}, { excludeHard = true } = {}) {
  return (Array.isArray(alertas) ? alertas : [])
    .map((alerta, index) => {
      const profileScore = puntuarAlertaConPerfilOperativoMIA(alerta, profile);
      return {
        ...alerta,
        mia_profile_score: profileScore.score,
        mia_profile_reasons: profileScore.reasons,
        mia_profile_excluded: profileScore.excluded,
        __mia_original_index: index,
      };
    })
    .filter((alerta) => !(excludeHard && alerta.mia_profile_excluded))
    .sort((a, b) => {
      const diff = Number(b.mia_profile_score || 0) - Number(a.mia_profile_score || 0);
      return diff || a.__mia_original_index - b.__mia_original_index;
    })
    .map(({ __mia_original_index, ...alerta }) => alerta);
}

async function selectOptional(supabase, table, select, userId, { limit = 100, order = 'created_at' } = {}) {
  try {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .eq('user_id', userId)
      .order(order, { ascending: false })
      .limit(limit);

    if (error) throw error;
    return { available: true, data: data || [] };
  } catch (error) {
    console.warn(`[mia:user_profile] No se pudo leer ${table}:`, error.message);
    return { available: false, data: [], error: error.message };
  }
}

function memoryIdentity(memory = {}) {
  if (memory.memory_key) return `key:${memory.memory_key}`;
  if (memory.id !== null && memory.id !== undefined) return `id:${memory.id}`;
  return [
    memory.scope_type,
    memory.scope_value,
    memory.polarity,
    memory.source,
    memory.created_at,
    memory.contenido,
  ].map((value) => String(value || '')).join('|');
}

function mergeAtomicMemories(recent = [], explicit = []) {
  const merged = new Map();
  for (const memory of [...(recent || []), ...(explicit || [])]) {
    const key = memoryIdentity(memory);
    if (!merged.has(key)) merged.set(key, memory);
  }
  return [...merged.values()];
}

async function selectDurableExplicitMemories(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('user_memory')
      .select(USER_MEMORY_SELECT)
      .eq('user_id', userId)
      .eq('status', 'active')
      .in('source', DURABLE_EXPLICIT_MEMORY_SOURCES)
      // Las respuestas ligadas a una alerta concreta permanecen en la ventana
      // reciente. La lectura durable se reserva para preferencias globales,
      // evitando que miles de votos de items oculten una exclusión vigente.
      .in('scope_type', DURABLE_EXPLICIT_MEMORY_SCOPES)
      .order('last_seen_at', { ascending: false })
      .limit(DURABLE_EXPLICIT_MEMORY_LIMIT);

    if (error) throw error;
    return { available: true, data: data || [] };
  } catch (error) {
    console.warn('[mia:user_profile] No se pudieron leer memorias explicitas durables:', error.message);
    return { available: false, data: [], error: error.message };
  }
}

async function cargarPerfilOperativoMIA(supabase, userId, { user = null, limit = 120 } = {}) {
  let userRow = user;
  if (!userRow) {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, first_name, subscription, preferences, preferencias_extra, contexto_narrativo, organization_id')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    userRow = data;
  }

  if (!userRow?.id) {
    return construirPerfilOperativoMIA({ user: { id: userId } });
  }

  const [interestRows, recentMemories, explicitMemories, structuredMemories] = await Promise.all([
    selectOptional(supabase, 'user_interest_profile', 'tag, score, positivos, negativos, updated_at', userRow.id, { limit, order: 'updated_at' }),
    selectOptional(supabase, 'user_memory', USER_MEMORY_SELECT, userRow.id, { limit, order: 'last_seen_at' }),
    selectDurableExplicitMemories(supabase, userRow.id),
    selectOptional(supabase, 'mia_structured_memory', 'memory_type, topic, detail, polarity, confidence, duplicate_count, created_at, last_seen_at', userRow.id, { limit, order: 'last_seen_at' }),
  ]);
  const atomicMemories = mergeAtomicMemories(recentMemories.data, explicitMemories.data);

  const profile = construirPerfilOperativoMIA({
    user: userRow,
    interestRows: interestRows.data,
    legacyMemories: atomicMemories,
    structuredMemories: structuredMemories.data,
  });

  return {
    ...profile,
    atomic_memories: atomicMemories,
    availability: {
      user_interest_profile: interestRows.available,
      user_memory: recentMemories.available || explicitMemories.available,
      explicit_user_memory: explicitMemories.available,
      mia_structured_memory: structuredMemories.available,
    },
  };
}

module.exports = {
  PROFILE_VERSION,
  DURABLE_EXPLICIT_MEMORY_SOURCES,
  DURABLE_EXPLICIT_MEMORY_SCOPES,
  mergeAtomicMemories,
  selectDurableExplicitMemories,
  construirPerfilOperativoMIA,
  cargarPerfilOperativoMIA,
  aplicarPerfilOperativoAUsuario,
  construirBloquePerfilOperativoMIA,
  construirResumenPerfilOperativoMIA,
  puntuarAlertaConPerfilOperativoMIA,
  ordenarAlertasConPerfilOperativoMIA,
  preferenciasDeclaradas,
  extraerExclusiones,
};
