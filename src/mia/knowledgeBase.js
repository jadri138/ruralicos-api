const {
  inicializarOpenAI,
  generarEmbedding,
} = require('../utils/embeddings');
const { generarRespuestaGroundedMIA } = require('./groundedAnswer');
const {
  normalizarOrganizationId,
  alertaVisibleParaOrganization,
  obtenerMiaBranding,
} = require('./organizationContext');

const STOPWORDS = new Set([
  'sobre',
  'para',
  'cuando',
  'donde',
  'como',
  'cual',
  'cuales',
  'sale',
  'salen',
  'salio',
  'saber',
  'quiero',
  'querria',
  'gustaria',
  'recibir',
  'aviso',
  'avisos',
  'alerta',
  'alertas',
  'ayuda',
  'ayudas',
  'subvencion',
  'subvenciones',
  'resolucion',
  'convocatoria',
  'fecha',
  'pago',
  'pagos',
  'plazo',
  'plazos',
  'esta',
  'este',
  'estos',
  'estas',
  'todo',
  'toda',
  'todas',
  'todos',
  'desde',
  'hasta',
  'porque',
  'gracias',
  'llegara',
  'llegan',
  'llega',
]);

const TERMINOS_TEMA = new Set([
  'pac',
  'tractor',
  'tractores',
  'maquinaria',
  'agricola',
  'agricolas',
  'agricultura',
  'ganaderia',
  'ganadero',
  'ganadera',
  'regadio',
  'sequia',
  'borrasca',
  'borrascas',
  'dana',
  'andalucia',
  'extremadura',
  'aragon',
  'castilla',
  'mancha',
  'leon',
  'galicia',
  'valencia',
  'murcia',
  'navarra',
  'rioja',
  'cataluna',
]);

const VARIANTES_QUERY = {
  agricola: ['agricola', 'agr\u00edcola'],
  agricolas: ['agricolas', 'agr\u00edcolas'],
  agricultura: ['agricultura'],
  ganaderia: ['ganaderia', 'ganader\u00eda'],
  regadio: ['regadio', 'regad\u00edo'],
  sequia: ['sequia', 'sequ\u00eda'],
  resolucion: ['resolucion', 'resoluci\u00f3n'],
  andalucia: ['andalucia', 'andaluc\u00eda'],
  aragon: ['aragon', 'arag\u00f3n'],
  cataluna: ['cataluna', 'catalu\u00f1a', 'catalunya'],
  valencia: ['valencia', 'valenciana', 'comunitat'],
  tractor: ['tractor', 'tractores'],
  tractores: ['tractores', 'tractor'],
  maquinaria: ['maquinaria', 'tractor', 'tractores'],
  borrasca: ['borrasca', 'borrascas', 'dana'],
  borrascas: ['borrascas', 'borrasca', 'dana'],
  pac: ['pac'],
};

const REGION_TERMS = new Map([
  ['andalucia', ['andalucia']],
  ['extremadura', ['extremadura']],
  ['aragon', ['aragon']],
  ['castilla-la-mancha', ['castilla', 'mancha', 'castilla la mancha']],
  ['castilla-y-leon', ['castilla', 'leon', 'castilla y leon']],
  ['galicia', ['galicia']],
  ['comunitat-valenciana', ['valencia', 'valenciana', 'comunitat']],
  ['murcia', ['murcia']],
  ['navarra', ['navarra']],
  ['la-rioja', ['rioja']],
  ['cataluna', ['cataluna', 'catalunya']],
]);

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const SEMANTIC_RPC_NAME = 'buscar_alertas_por_embedding_mia';
const SEMANTIC_MISSING_CODES = new Set(['42883', 'PGRST202', 'PGRST204']);

function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function vectorToSql(vector) {
  if (!Array.isArray(vector)) throw new Error('Vector invalido');
  return `[${vector.map((n) => Number(n)).join(',')}]`;
}

function limpiarTermino(term) {
  return normalizarTexto(term)
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function extraerTerminosConsultaMIA(texto, max = 8) {
  const crudos = normalizarTexto(texto)
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .map(limpiarTermino)
    .filter(Boolean);

  const terminos = [];
  for (const term of crudos) {
    if (term.length < 4 && term !== 'pac') continue;
    if (STOPWORDS.has(term) && !TERMINOS_TEMA.has(term)) continue;
    if (!terminos.includes(term)) terminos.push(term);
    if (terminos.length >= max) break;
  }

  return terminos;
}

function variantesTermino(term) {
  const limpio = limpiarTermino(term);
  if (!limpio) return [];
  return [...new Set([limpio, ...(VARIANTES_QUERY[limpio] || [])])].filter(Boolean);
}

function extraerRegionesConsultaMIA(texto) {
  const normalizado = normalizarTexto(texto).replace(/\s+/g, ' ');
  const regiones = [];

  for (const [region, aliases] of REGION_TERMS.entries()) {
    if (aliases.some((alias) => normalizado.includes(alias))) regiones.push(region);
  }

  return [...new Set(regiones)];
}

function detectarTipoPreguntaMIA(texto) {
  const normalizado = normalizarTexto(texto);
  if (/\b(pago|pagos|cobrar|cobro|abono|abona|ingreso|ingresan|llegara|llega)\b/.test(normalizado)) {
    return 'pago';
  }
  if (/\b(cuando|fecha|resolucion|sale|saldra|publican|publicacion)\b/.test(normalizado)) {
    return 'fecha_resolucion';
  }
  if (/\b(plazo|solicitar|solicitud|presentar|hasta cuando)\b/.test(normalizado)) {
    return 'plazo';
  }
  if (/\b(requisitos|beneficiarios|puedo|pueden|quien|quienes)\b/.test(normalizado)) {
    return 'requisitos';
  }
  return 'general';
}

function esPreguntaDeFecha(texto) {
  return ['pago', 'fecha_resolucion', 'plazo'].includes(detectarTipoPreguntaMIA(texto));
}

function escaparIlike(term) {
  return String(term || '').replace(/[%,]/g, '');
}

function textoAlerta(alerta = {}) {
  return [
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen,
    alerta.region,
    alerta.fuente,
    Array.isArray(alerta.provincias) ? alerta.provincias.join(' ') : '',
    Array.isArray(alerta.sectores) ? alerta.sectores.join(' ') : '',
    Array.isArray(alerta.subsectores) ? alerta.subsectores.join(' ') : '',
    Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta.join(' ') : '',
  ].filter(Boolean).join(' ');
}

function extraerFechasTexto(texto, max = 4) {
  const value = String(texto || '').replace(/\s+/g, ' ');
  const encontrados = [];
  const patrones = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
    new RegExp(`\\b\\d{1,2}\\s+de\\s+(?:${MESES.join('|')})\\s+de\\s+\\d{4}\\b`, 'gi'),
  ];

  for (const patron of patrones) {
    for (const match of value.matchAll(patron)) {
      const fecha = match[0].trim();
      if (!encontrados.includes(fecha)) encontrados.push(fecha);
      if (encontrados.length >= max) return encontrados;
    }
  }

  return encontrados;
}

function construirSnippet(alerta = {}, terminos = [], max = 280) {
  const base = String(alerta.resumen_final || alerta.resumen || alerta.titulo || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (base.length <= max) return base;

  const normalizado = normalizarTexto(base);
  const posiciones = terminos
    .flatMap(variantesTermino)
    .map((term) => normalizado.indexOf(term))
    .filter((index) => index >= 0);
  const start = posiciones.length ? Math.max(0, Math.min(...posiciones) - 70) : 0;
  const snippet = base.slice(start, start + max).trim();
  return `${start > 0 ? '...' : ''}${snippet}${start + max < base.length ? '...' : ''}`;
}

function regionesEncontradas(alerta = {}, regiones = []) {
  const texto = normalizarTexto(textoAlerta(alerta));
  return regiones.filter((region) => {
    const aliases = REGION_TERMS.get(region) || [region];
    return aliases.some((alias) => texto.includes(alias));
  });
}

function calcularDetalleScore(alerta = {}, contexto = {}) {
  const terminos = contexto.terminos || [];
  const regiones = contexto.regiones || [];
  const tipoPregunta = contexto.tipoPregunta || 'general';
  const titulo = normalizarTexto(alerta.titulo || '');
  const resumen = normalizarTexto(`${alerta.resumen_final || ''} ${alerta.resumen || ''}`);
  const resto = normalizarTexto(textoAlerta(alerta));
  let score = 0;

  const matchingTerms = [];
  for (const term of terminos) {
    const variants = variantesTermino(term).map(normalizarTexto);
    const hitTitulo = variants.some((variant) => titulo.includes(variant));
    const hitResumen = variants.some((variant) => resumen.includes(variant));
    const hitResto = variants.some((variant) => resto.includes(variant));
    if (hitTitulo || hitResumen || hitResto) matchingTerms.push(term);
    if (hitTitulo) score += 4;
    if (hitResumen) score += 2;
    if (hitResto) score += 1;
  }

  const matchingRegions = regionesEncontradas(alerta, regiones);
  if (regiones.length > 0) score += matchingRegions.length > 0 ? 5 : -4;

  if (tipoPregunta === 'pago' && /\b(pago|pagos|abono|abonar|ingreso|indemnizacion|compensacion)\b/.test(resto)) score += 3;
  if (tipoPregunta === 'plazo' && /\b(plazo|solicitud|presentacion|hasta|convocatoria)\b/.test(resto)) score += 3;
  if (tipoPregunta === 'fecha_resolucion' && /\b(resolucion|extracto|convocatoria|publicacion)\b/.test(resto)) score += 2;
  if (tipoPregunta === 'requisitos' && /\b(requisitos|beneficiarios|solicitantes|bases)\b/.test(resto)) score += 2;

  if (alerta.resumen_final || alerta.resumen) score += 1;
  if (alerta.url) score += 0.5;
  if (alerta.fecha) score += 0.5;
  if (alerta.estado_ia === 'listo') score += 0.5;
  if (alerta.duplicado_de) score -= 5;

  return {
    score,
    matchingTerms: [...new Set(matchingTerms)],
    matchingRegions,
    fechasDetectadas: extraerFechasTexto(`${alerta.titulo || ''} ${alerta.resumen_final || ''} ${alerta.resumen || ''}`),
  };
}

function puntuarAlerta(alerta = {}, terminos = []) {
  return calcularDetalleScore(alerta, { terminos }).score;
}

function clasificarEvidencia(score, matchingTerms = [], terminos = []) {
  const cobertura = terminos.length ? matchingTerms.length / terminos.length : 0;
  if (score >= 10 && cobertura >= 0.5) return 'alta';
  if (score >= 6 && cobertura >= 0.35) return 'media';
  return 'baja';
}

function resumirMatch(alerta = {}, detalle = {}, contexto = {}) {
  return {
    id: alerta.id,
    titulo: alerta.titulo || '',
    resumen: alerta.resumen_final || alerta.resumen || '',
    snippet: construirSnippet(alerta, contexto.terminos || []),
    fecha: alerta.fecha || null,
    region: alerta.region || null,
    fuente: alerta.fuente || null,
    url: alerta.url || null,
    organization_id: alerta.organization_id || null,
    score: Number((detalle.score || 0).toFixed(2)),
    matching_terms: detalle.matchingTerms || [],
    matching_regions: detalle.matchingRegions || [],
    fechas_detectadas: detalle.fechasDetectadas || [],
    semantic_similarity: Number.isFinite(Number(alerta.semantic_similarity)) ? Number(alerta.semantic_similarity) : null,
    retrieval_sources: alerta.retrieval_sources || [],
    score_breakdown: detalle.scoreBreakdown || null,
  };
}

function esRpcSemanticaNoDisponible(error) {
  return SEMANTIC_MISSING_CODES.has(error?.code) || /function .* does not exist|schema cache/i.test(error?.message || '');
}

function normalizarCandidatoAlerta(alerta = {}, source = 'unknown') {
  return {
    id: Number(alerta.id),
    titulo: alerta.titulo || '',
    resumen: alerta.resumen || '',
    resumen_final: alerta.resumen_final || '',
    url: alerta.url || null,
    fecha: alerta.fecha || null,
    region: alerta.region || null,
    fuente: alerta.fuente || null,
    provincias: alerta.provincias || [],
    sectores: alerta.sectores || [],
    subsectores: alerta.subsectores || [],
    tipos_alerta: alerta.tipos_alerta || [],
    estado_ia: alerta.estado_ia || null,
    duplicado_de: alerta.duplicado_de || null,
    organization_id: alerta.organization_id || null,
    created_at: alerta.created_at || null,
    semantic_similarity: Number.isFinite(Number(alerta.similitud ?? alerta.similarity))
      ? Number(alerta.similitud ?? alerta.similarity)
      : null,
    retrieval_sources: [source],
  };
}

function construirScoreBreakdown({ lexicalScore = 0, semanticSimilarity = null, sourceBoost = 0, finalScore = 0 } = {}) {
  return {
    lexical: Number((lexicalScore || 0).toFixed(2)),
    semantic: semanticSimilarity === null ? null : Number(semanticSimilarity.toFixed(4)),
    semantic_points: semanticSimilarity === null ? 0 : Number((semanticSimilarity * 14).toFixed(2)),
    source_boost: Number((sourceBoost || 0).toFixed(2)),
    final: Number((finalScore || 0).toFixed(2)),
  };
}

function combinarYRankearAlertasMIA({ lexicalItems = [], semanticItems = [], contexto = {}, limit = 5 } = {}) {
  const porId = new Map();

  for (const item of lexicalItems) {
    if (!item?.id) continue;
    const normalizado = normalizarCandidatoAlerta(item, 'lexical');
    porId.set(Number(normalizado.id), normalizado);
  }

  for (const item of semanticItems) {
    if (!item?.id) continue;
    const normalizado = normalizarCandidatoAlerta(item, 'semantic');
    const existente = porId.get(Number(normalizado.id));
    if (existente) {
      porId.set(Number(normalizado.id), {
        ...existente,
        ...normalizado,
        retrieval_sources: [...new Set([...(existente.retrieval_sources || []), 'semantic'])],
        semantic_similarity: normalizado.semantic_similarity ?? existente.semantic_similarity ?? null,
      });
    } else {
      porId.set(Number(normalizado.id), normalizado);
    }
  }

  return [...porId.values()]
    .map((alerta) => {
      const detalle = calcularDetalleScore(alerta, contexto);
      const semanticSimilarity = Number.isFinite(Number(alerta.semantic_similarity))
        ? Number(alerta.semantic_similarity)
        : null;
      const sourceBoost = (alerta.retrieval_sources || []).includes('semantic') ? 1.5 : 0;
      const semanticPoints = semanticSimilarity === null ? 0 : semanticSimilarity * 14;
      const finalScore = detalle.score + semanticPoints + sourceBoost;
      return {
        ...resumirMatch(alerta, {
          ...detalle,
          score: finalScore,
          scoreBreakdown: construirScoreBreakdown({
            lexicalScore: detalle.score,
            semanticSimilarity,
            sourceBoost,
            finalScore,
          }),
        }, contexto),
      };
    })
    .filter((item) => Number(item.score || 0) > 0)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, limit);
}

async function buscarAlertasLexicasMIA(supabase, {
  terminos = [],
  regiones = [],
  limit = 80,
  organizationId = null,
} = {}) {
  const terminosBusqueda = [...new Set([
    ...terminos.flatMap(variantesTermino),
    ...regiones.flatMap((region) => (REGION_TERMS.get(region) || [region]).flatMap(variantesTermino)),
  ])]
    .map(escaparIlike)
    .filter(Boolean)
    .slice(0, 12);

  if (terminosBusqueda.length === 0) return [];

  const perTermLimit = Math.max(15, Math.ceil(limit / Math.max(1, terminosBusqueda.length)));
  const queries = terminosBusqueda.map(async (term) => {
    const pattern = `%${term}%`;
    let query = supabase
      .from('alertas')
      .select('id, titulo, resumen, resumen_final, url, fecha, region, fuente, provincias, sectores, subsectores, tipos_alerta, estado_ia, duplicado_de, organization_id, created_at')
      .or(`titulo.ilike.${pattern},resumen_final.ilike.${pattern},resumen.ilike.${pattern},contenido.ilike.${pattern},region.ilike.${pattern}`)
      .order('created_at', { ascending: false })
      .limit(perTermLimit);

    query = query.eq('estado_ia', 'listo').is('duplicado_de', null);
    const orgId = normalizarOrganizationId(organizationId);
    query = orgId
      ? query.or(`organization_id.is.null,organization_id.eq.${orgId}`)
      : query.is('organization_id', null);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  });

  return (await Promise.all(queries)).flat();
}

async function filtrarItemsSemanticosPorOrganizationMIA(supabase, items = [], organizationId = null) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const necesitaHidratar = list.some((item) => !Object.prototype.hasOwnProperty.call(item, 'organization_id'));
  if (!necesitaHidratar) {
    return list.filter((item) => alertaVisibleParaOrganization(item, organizationId));
  }

  const ids = [...new Set(list.map((item) => Number(item.id)).filter(Boolean))];
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('alertas')
    .select('id, organization_id')
    .in('id', ids);

  if (error) throw error;

  const orgPorId = new Map((data || []).map((row) => [Number(row.id), row.organization_id || null]));
  return list
    .map((item) => ({
      ...item,
      organization_id: orgPorId.get(Number(item.id)),
      __mia_alert_exists: orgPorId.has(Number(item.id)),
    }))
    .filter((item) => item.__mia_alert_exists && alertaVisibleParaOrganization(item, organizationId))
    .map(({ __mia_alert_exists, ...item }) => item);
}

async function buscarAlertasSemanticasMIA(supabase, {
  texto,
  limit = 40,
  usarMock = false,
  organizationId = null,
} = {}) {
  if (String(process.env.MIA_KNOWLEDGE_SEMANTIC_ENABLED || 'true').toLowerCase() === 'false') {
    return { ok: true, available: false, skipped: true, reason: 'semantic_disabled', items: [] };
  }

  if (!usarMock && !process.env.OPENAI_API_KEY) {
    return { ok: true, available: false, skipped: true, reason: 'openai_api_key_missing', items: [] };
  }

  try {
    inicializarOpenAI();
    const embedding = await generarEmbedding(String(texto || '').trim(), usarMock);
    const { data, error } = await supabase.rpc(SEMANTIC_RPC_NAME, {
      p_query_embedding: vectorToSql(embedding),
      p_match_count: Math.max(5, Math.min(80, Number(limit) || 40)),
      p_min_similarity: Number(process.env.MIA_KNOWLEDGE_MIN_SEMANTIC_SIMILARITY || 0.18),
    });

    if (error) throw error;
    const items = await filtrarItemsSemanticosPorOrganizationMIA(supabase, data || [], organizationId);
    return {
      ok: true,
      available: true,
      skipped: false,
      items,
    };
  } catch (error) {
    if (esRpcSemanticaNoDisponible(error)) {
      return { ok: true, available: false, skipped: true, reason: 'semantic_rpc_missing', items: [] };
    }
    console.warn('[mia:knowledge] Busqueda semantica no disponible:', error.message);
    return { ok: false, available: false, skipped: true, reason: 'semantic_error', error: error.message, items: [] };
  }
}

async function buscarAlertasRelacionadasMIA(supabase, {
  texto,
  limit = 5,
  usarMockEmbedding = false,
  organizationId = null,
} = {}) {
  const terminos = extraerTerminosConsultaMIA(texto);
  const regiones = extraerRegionesConsultaMIA(texto);
  const tipoPregunta = detectarTipoPreguntaMIA(texto);
  if (terminos.length === 0 && regiones.length === 0) {
    return {
      terminos,
      regiones,
      tipo_pregunta: tipoPregunta,
      retrieval: { mode: 'none', lexical_count: 0, semantic_count: 0, semantic_available: false },
      items: [],
      organization_id: normalizarOrganizationId(organizationId),
    };
  }

  const contexto = { terminos, regiones, tipoPregunta };
  const [lexicalItems, semanticResult] = await Promise.all([
    buscarAlertasLexicasMIA(supabase, { terminos, regiones, limit: 100, organizationId }),
    buscarAlertasSemanticasMIA(supabase, { texto, limit: 50, usarMock: usarMockEmbedding, organizationId }),
  ]);

  const items = combinarYRankearAlertasMIA({
    lexicalItems,
    semanticItems: semanticResult.items || [],
    contexto,
    limit,
  });

  return {
    terminos,
    regiones,
    tipo_pregunta: tipoPregunta,
    retrieval: {
      mode: semanticResult.available ? 'hybrid' : 'lexical',
      lexical_count: lexicalItems.length,
      semantic_count: (semanticResult.items || []).length,
      semantic_available: semanticResult.available === true,
      semantic_reason: semanticResult.reason || null,
      semantic_error: semanticResult.error || null,
    },
    items,
    organization_id: normalizarOrganizationId(organizationId),
  };
}

function construirRespuestaConAlertasMIA({
  texto,
  terminos = [],
  regiones = [],
  tipo_pregunta: tipoPregunta = detectarTipoPreguntaMIA(texto),
  items = [],
  organizationContext = null,
} = {}) {
  const branding = obtenerMiaBranding(organizationContext);
  const top = items[0] || null;
  if (!top || Number(top.score || 0) < 4) {
    return {
      answered: false,
      needs_agent: true,
      confidence: 0.2,
      evidence_level: 'sin_evidencia',
      reply: `Lo revisa ${branding.agent_label} y te contestamos cuando haya una respuesta clara.`,
      matches: items.slice(0, 3),
    };
  }

  const evidenceLevel = clasificarEvidencia(top.score, top.matching_terms || [], terminos);
  const preguntaSensible = ['pago', 'fecha_resolucion', 'plazo'].includes(tipoPregunta);
  const tieneFechas = (top.fechas_detectadas || []).length > 0 || Boolean(top.fecha);
  const needsAgent = preguntaSensible || evidenceLevel === 'baja';
  const matches = items.slice(0, 3);
  const lineas = [];

  if (preguntaSensible) {
    lineas.push(`${branding.assistant_name} ha encontrado referencias relacionadas en la base de ${branding.reply_sender}, pero no confirma fechas o pagos sin revision.`);
  } else {
    lineas.push(`${branding.assistant_name} ha encontrado referencias relacionadas en la base de ${branding.reply_sender}.`);
  }

  lineas.push(`Referencia principal: ${top.titulo}${top.fecha ? ` (${top.fecha})` : ''}.`);

  if (top.snippet) {
    lineas.push(`Resumen: ${top.snippet.slice(0, 320)}`);
  }

  if (preguntaSensible && tieneFechas) {
    const fechas = [...new Set([top.fecha, ...(top.fechas_detectadas || [])].filter(Boolean))].slice(0, 4);
    lineas.push(`Fechas que aparecen en la referencia: ${fechas.join(', ')}.`);
  }

  if (top.url) lineas.push(top.url);

  if (needsAgent) {
    lineas.push(`Lo dejamos revisado por ${branding.agent_label} para darte una respuesta confirmada.`);
  }

  const score = Number(top.score || 0);
  const confidence = evidenceLevel === 'alta'
    ? 0.86
    : evidenceLevel === 'media'
      ? 0.68
      : Math.max(0.42, Math.min(0.55, score / 14));

  return {
    answered: true,
    needs_agent: needsAgent,
    confidence,
    evidence_level: evidenceLevel,
    reply: lineas.join('\n').slice(0, 1200),
    matches,
  };
}

async function resolverPreguntaConBaseConocimientoMIA(supabase, {
  texto,
  limit = 5,
  usarMockEmbedding = false,
  organizationId = null,
  organizationContext = null,
} = {}) {
  const {
    terminos,
    regiones,
    tipo_pregunta: tipoPregunta,
    retrieval,
    items,
  } = await buscarAlertasRelacionadasMIA(supabase, { texto, limit, usarMockEmbedding, organizationId });
  const respuestaBase = construirRespuestaConAlertasMIA({
    texto,
    terminos,
    regiones,
    tipo_pregunta: tipoPregunta,
    items,
    organizationContext,
  });
  const respuestaGrounded = await generarRespuestaGroundedMIA({
    texto,
    matches: respuestaBase.matches || [],
    tipoPregunta,
    answered: respuestaBase.answered,
    needsAgent: respuestaBase.needs_agent,
    evidenceLevel: respuestaBase.evidence_level,
    confidence: respuestaBase.confidence,
    organizationContext,
  });

  return {
    terminos,
    regiones,
    tipo_pregunta: tipoPregunta,
    retrieval,
    organization_id: normalizarOrganizationId(organizationId),
    organization_context: organizationContext || null,
    ...respuestaBase,
    reply: respuestaGrounded.reply || respuestaBase.reply,
    answer_source: respuestaGrounded.answer_source || 'deterministic_template',
    answer_guardrails: respuestaGrounded.answer_guardrails || [],
    answer_error: respuestaGrounded.answer_error || null,
    grounded_evidences: respuestaGrounded.evidences || [],
  };
}

function aplicarRespuestaConocimientoADecision(decision = {}, respuesta = {}) {
  const branding = obtenerMiaBranding(decision.organization_context || respuesta.organization_context || null);
  const riskFlags = [...(decision.risk_flags || [])];
  if (respuesta.answered) {
    riskFlags.push(respuesta.needs_agent ? 'knowledge_partial_answer' : 'auto_answered_from_knowledge_base');
    if (respuesta.evidence_level === 'baja') riskFlags.push('knowledge_evidence_weak');
  } else {
    riskFlags.push('knowledge_no_match');
  }

  return {
    ...decision,
    confidence: respuesta.answered
      ? Math.max(Number(decision.confidence || 0), respuesta.confidence || 0)
      : decision.confidence,
    reply_action: respuesta.reply
      ? { canal: 'whatsapp', texto: respuesta.reply }
      : decision.reply_action,
    risk_flags: [...new Set(riskFlags)],
    summary: respuesta.answered
      ? `${decision.summary || 'Pregunta de usuario'} Respuesta apoyada en base ${branding.reply_sender}.`
      : decision.summary,
    knowledge_context: {
      answered: Boolean(respuesta.answered),
      needs_agent: Boolean(respuesta.needs_agent),
      confidence: respuesta.confidence || 0,
      evidence_level: respuesta.evidence_level || null,
      tipo_pregunta: respuesta.tipo_pregunta || null,
      organization_id: respuesta.organization_id || null,
      retrieval: respuesta.retrieval || null,
      terminos: respuesta.terminos || [],
      regiones: respuesta.regiones || [],
      matches: respuesta.matches || [],
      answer_source: respuesta.answer_source || null,
      answer_guardrails: respuesta.answer_guardrails || [],
      grounded_evidences: respuesta.grounded_evidences || [],
    },
  };
}

module.exports = {
  extraerTerminosConsultaMIA,
  extraerRegionesConsultaMIA,
  detectarTipoPreguntaMIA,
  esPreguntaDeFecha,
  extraerFechasTexto,
  puntuarAlerta,
  buscarAlertasLexicasMIA,
  buscarAlertasSemanticasMIA,
  combinarYRankearAlertasMIA,
  buscarAlertasRelacionadasMIA,
  construirRespuestaConAlertasMIA,
  resolverPreguntaConBaseConocimientoMIA,
  aplicarRespuestaConocimientoADecision,
};
