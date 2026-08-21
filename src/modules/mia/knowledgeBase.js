const {
  inicializarOpenAI,
  generarEmbedding,
} = require('../../platform/ia/embeddings');
const { generarRespuestaGroundedMIA } = require('./groundedAnswer');
const { getFechaMadridISO } = require('../../shared/fechaMadrid');
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
  'hoy',
  'ayer',
  'anteayer',
  'dia',
  'dias',
  'otro',
  'otra',
  'algo',
  'salido',
  'salieron',
  'publicado',
  'publicaron',
  'buscar',
  'busca',
  'novedad',
  'novedades',
  'primera',
  'primer',
  'segunda',
  'ultimo',
  'ultimos',
  'ultima',
  'ultimas',
  'semana',
  'mes',
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

const FUENTES_ALERTAS = new Map([
  ['boe', 'BOE'],
  ['boa', 'BOA'],
  ['boja', 'BOJA'],
  ['bopa', 'BOPA'],
  ['bopz', 'BOPZ'],
  ['boph', 'BOPH'],
  ['bopte', 'BOPTE'],
  ['bopt', 'BOPT'],
  ['bopv', 'BOPV'],
  ['bocm', 'BOCM'],
  ['bocyl', 'BOCYL'],
  ['bocant', 'BOCANT'],
  ['bocan', 'BOCAN'],
  ['doe', 'DOE'],
  ['docm', 'DOCM'],
  ['dog', 'DOG'],
  ['dogc', 'DOGC'],
  ['dogv', 'DOGV'],
  ['boc', 'BOC'],
  ['bon', 'BON'],
  ['bor', 'BOR'],
  ['borm', 'BORM'],
  ['boib', 'BOIB'],
  ['bog', 'BOG'],
  ['bome', 'BOME'],
  ['botha', 'BOTHA'],
  ['fega', 'FEGA'],
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
const KNOWLEDGE_CHUNKS_RPC_NAME = 'buscar_mia_knowledge_chunks_por_embedding';
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
    if (/^\d+$/.test(term)) continue;
    if (FUENTES_ALERTAS.has(term)) continue;
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

function crearFechaISO(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return null;
  return date.toISOString().slice(0, 10);
}

function sumarDiasFechaISO(fechaISO, dias) {
  const [year, month, day] = String(fechaISO || '').split('-').map(Number);
  const base = crearFechaISO(year, month, day);
  if (!base) return null;
  const date = new Date(`${base}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(dias || 0));
  return date.toISOString().slice(0, 10);
}

function extraerAclaracionContextualMIA(texto) {
  const normalizado = normalizarTexto(texto).replace(/\s+/g, ' ').trim();
  const marker = 'aclaracion del usuario:';
  const markerIndex = normalizado.lastIndexOf(marker);
  if (markerIndex < 0) return { completo: normalizado, aclaracion: null };
  return {
    completo: normalizado,
    aclaracion: normalizado.slice(markerIndex + marker.length).trim() || null,
  };
}

function contieneReferenciaTemporalMIA(texto) {
  const mesesPattern = MESES.join('|');
  return new RegExp(
    `\\b(?:20\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}/\\d{1,2}/20\\d{2}|\\d{1,2}\\s+de\\s+(?:${mesesPattern})|hoy|ayer|anteayer|(?:dia|del|el)\\s+\\d{1,2}|ultim(?:o|os|a|as)\\s+\\d{1,2}\\s+dias?|esta semana|este mes)\\b`
  ).test(String(texto || ''));
}

function extraerFiltroTemporalConsultaMIA(texto, { now = new Date() } = {}) {
  const contexto = extraerAclaracionContextualMIA(texto);
  const normalizado = contexto.aclaracion && contieneReferenciaTemporalMIA(contexto.aclaracion)
    ? contexto.aclaracion
    : contexto.completo;
  const hoy = getFechaMadridISO(now);
  const [hoyYear, hoyMonth, hoyDay] = hoy.split('-').map(Number);
  let fecha = null;

  const iso = normalizado.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) fecha = crearFechaISO(iso[1], iso[2], iso[3]);

  if (!fecha) {
    const numerica = normalizado.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
    if (numerica) fecha = crearFechaISO(numerica[3], numerica[2], numerica[1]);
  }

  if (!fecha) {
    const mesesPattern = MESES.join('|');
    const literal = normalizado.match(new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${mesesPattern})(?:\\s+de\\s+(20\\d{2}))?\\b`));
    if (literal) {
      fecha = crearFechaISO(literal[3] || hoyYear, MESES.indexOf(literal[2]) + 1, literal[1]);
    }
  }

  if (!fecha && /\banteayer\b/.test(normalizado)) fecha = sumarDiasFechaISO(hoy, -2);
  if (!fecha && /\bayer\b/.test(normalizado)) fecha = sumarDiasFechaISO(hoy, -1);
  if (!fecha && /\bhoy\b/.test(normalizado)) fecha = hoy;

  if (!fecha && /\b(?:dia|del|el)\s+(\d{1,2})\b/.test(normalizado)) {
    const day = Number(normalizado.match(/\b(?:dia|del|el)\s+(\d{1,2})\b/)?.[1]);
    fecha = crearFechaISO(hoyYear, hoyMonth, day);
    if (fecha && day > hoyDay) {
      fecha = crearFechaISO(hoyMonth === 1 ? hoyYear - 1 : hoyYear, hoyMonth === 1 ? 12 : hoyMonth - 1, day);
    }
  }

  if (fecha) return { kind: 'day', desde: fecha, hasta: fecha, label: fecha };

  const ultimos = normalizado.match(/\bultim(?:o|os|a|as)\s+(\d{1,2})\s+dias?\b/);
  if (ultimos) {
    const total = Math.max(1, Math.min(90, Number(ultimos[1])));
    return {
      kind: 'last_days',
      desde: sumarDiasFechaISO(hoy, -(total - 1)),
      hasta: hoy,
      label: `ultimos ${total} dias`,
    };
  }

  if (/\besta semana\b/.test(normalizado)) {
    const weekday = new Date(`${hoy}T12:00:00.000Z`).getUTCDay();
    const desde = sumarDiasFechaISO(hoy, -((weekday + 6) % 7));
    return { kind: 'week', desde, hasta: hoy, label: 'esta semana' };
  }

  if (/\beste mes\b/.test(normalizado)) {
    const desde = crearFechaISO(hoyYear, hoyMonth, 1);
    return { kind: 'month', desde, hasta: hoy, label: 'este mes' };
  }

  return null;
}

function extraerFuentesConsultaMIA(texto) {
  const contexto = extraerAclaracionContextualMIA(texto);
  const fuenteEnAclaracion = contexto.aclaracion && [...FUENTES_ALERTAS.keys()]
    .some((alias) => new RegExp(`\\b${alias}\\b`).test(contexto.aclaracion));
  const normalizado = fuenteEnAclaracion ? contexto.aclaracion : contexto.completo;
  return [...new Set([...FUENTES_ALERTAS.entries()]
    .filter(([alias]) => new RegExp(`\\b${alias}\\b`).test(normalizado))
    .map(([, fuente]) => fuente))];
}

function detectarConsultaHistoricaAlertasMIA(texto) {
  const normalizado = normalizarTexto(texto);
  return /\b(ha salido|han salido|salio|salieron|publicado|publicaron|novedades|alertas? (?:de|sobre)|avisos? (?:de|sobre)|busca en (?:las )?alertas)\b/.test(normalizado);
}

function extraerFiltrosConsultaMIA(texto, options = {}) {
  const temporal = extraerFiltroTemporalConsultaMIA(texto, options);
  const fuentes = extraerFuentesConsultaMIA(texto);
  const alertsOnly = detectarConsultaHistoricaAlertasMIA(texto) || Boolean(temporal || fuentes.length);
  return {
    temporal,
    fuentes,
    alerts_only: alertsOnly,
  };
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
    alerta.snippet,
    alerta.categoria,
    alerta.region,
    alerta.fuente,
    Array.isArray(alerta.provincias) ? alerta.provincias.join(' ') : '',
    Array.isArray(alerta.sectores) ? alerta.sectores.join(' ') : '',
    Array.isArray(alerta.subsectores) ? alerta.subsectores.join(' ') : '',
    Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta.join(' ') : '',
  ].filter(Boolean).join(' ');
}

function contieneTerminoNormalizado(texto, termino) {
  const value = normalizarTexto(texto);
  const term = normalizarTexto(termino).trim();
  if (!term) return false;
  const escaped = term
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(value);
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
    return aliases.some((alias) => contieneTerminoNormalizado(texto, alias));
  });
}

function calcularDetalleScore(alerta = {}, contexto = {}) {
  const terminos = contexto.terminos || [];
  const regiones = contexto.regiones || [];
  const tipoPregunta = contexto.tipoPregunta || 'general';
  const filtros = contexto.filtros || {};
  const titulo = normalizarTexto(alerta.titulo || '');
  const resumen = normalizarTexto(`${alerta.resumen_final || ''} ${alerta.resumen || ''}`);
  const resto = normalizarTexto(textoAlerta(alerta));
  const verifiedTerms = new Set((alerta.verified_terms || []).map(limpiarTermino));
  let score = 0;

  const matchingTerms = [];
  for (const term of terminos) {
    const variants = variantesTermino(term).map(normalizarTexto);
    const hitTitulo = variants.some((variant) => contieneTerminoNormalizado(titulo, variant));
    const hitResumen = variants.some((variant) => contieneTerminoNormalizado(resumen, variant));
    const hitResto = variants.some((variant) => contieneTerminoNormalizado(resto, variant));
    const hitVerified = verifiedTerms.has(limpiarTermino(term));
    if (hitTitulo || hitResumen || hitResto || hitVerified) matchingTerms.push(term);
    if (hitTitulo) score += 4;
    if (hitResumen) score += 2;
    if (hitResto) score += 1;
    if (hitVerified && !hitResto) score += 3;
  }

  const matchingRegions = regionesEncontradas(alerta, regiones);
  if (regiones.length > 0) score += matchingRegions.length > 0 ? 5 : -4;

  if (filtros.temporal) score += 5;
  if ((filtros.fuentes || []).length > 0) score += 4;

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
    source_type: alerta.source_type || 'alerta',
    document_id: alerta.document_id || null,
    titulo: alerta.titulo || '',
    resumen: alerta.resumen_final || alerta.resumen || '',
    snippet: construirSnippet(alerta, contexto.terminos || []),
    fecha: alerta.fecha || null,
    region: alerta.region || null,
    fuente: alerta.fuente || null,
    categoria: alerta.categoria || null,
    url: alerta.url || null,
    organization_id: alerta.organization_id || null,
    score: Number((detalle.score || 0).toFixed(2)),
    matching_terms: detalle.matchingTerms || [],
    matching_regions: detalle.matchingRegions || [],
    fechas_detectadas: detalle.fechasDetectadas || [],
    semantic_similarity: Number.isFinite(Number(alerta.semantic_similarity)) ? Number(alerta.semantic_similarity) : null,
    retrieval_sources: alerta.retrieval_sources || [],
    verified_terms: alerta.verified_terms || [],
    score_breakdown: detalle.scoreBreakdown || null,
  };
}

function esRpcSemanticaNoDisponible(error) {
  return SEMANTIC_MISSING_CODES.has(error?.code) || /function .* does not exist|schema cache/i.test(error?.message || '');
}

function normalizarCandidatoAlerta(alerta = {}, source = 'unknown') {
  return {
    id: Number(alerta.id),
    source_type: alerta.source_type || 'alerta',
    document_id: alerta.document_id || null,
    titulo: alerta.titulo || '',
    resumen: alerta.resumen || '',
    resumen_final: alerta.resumen_final || '',
    snippet: alerta.snippet || '',
    url: alerta.url || null,
    fecha: alerta.fecha || null,
    region: alerta.region || null,
    fuente: alerta.fuente || null,
    categoria: alerta.categoria || null,
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
    verified_terms: alerta.verified_terms || [],
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
    porId.set(`${normalizado.source_type}:${normalizado.id}`, normalizado);
  }

  for (const item of semanticItems) {
    if (!item?.id) continue;
    const normalizado = normalizarCandidatoAlerta(item, 'semantic');
    const key = `${normalizado.source_type}:${normalizado.id}`;
    const existente = porId.get(key);
    if (existente) {
      porId.set(key, {
        ...existente,
        ...normalizado,
        retrieval_sources: [...new Set([...(existente.retrieval_sources || []), 'semantic'])],
        verified_terms: [...new Set([
          ...(existente.verified_terms || []),
          ...(normalizado.verified_terms || []),
        ])],
        semantic_similarity: normalizado.semantic_similarity ?? existente.semantic_similarity ?? null,
      });
    } else {
      porId.set(key, normalizado);
    }
  }

  return [...porId.values()]
    .map((alerta) => {
      const detalle = calcularDetalleScore(alerta, contexto);
      const semanticSimilarity = Number.isFinite(Number(alerta.semantic_similarity))
        ? Number(alerta.semantic_similarity)
        : null;
      const sourceBoost = (alerta.retrieval_sources || []).includes('semantic') ? 1.5 : 0;
      const manualBoost = alerta.source_type === 'manual' ? 1 : 0;
      const semanticPoints = semanticSimilarity === null ? 0 : semanticSimilarity * 14;
      const finalScore = detalle.score + semanticPoints + sourceBoost + manualBoost;
      return {
        ...resumirMatch(alerta, {
          ...detalle,
          score: finalScore,
          scoreBreakdown: construirScoreBreakdown({
            lexicalScore: detalle.score,
            semanticSimilarity,
            sourceBoost: sourceBoost + manualBoost,
            finalScore,
          }),
        }, contexto),
      };
    })
    .filter((item) => Number(item.score || 0) > 0)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, limit);
}

function normalizarCandidatoManualMIA(row = {}) {
  return {
    id: Number(row.id),
    source_type: 'manual',
    document_id: row.document_id || null,
    titulo: row.titulo || '',
    resumen: row.resumen || row.snippet || '',
    resumen_final: row.resumen || row.snippet || '',
    snippet: row.snippet || row.resumen || '',
    url: row.url || null,
    fecha: row.fecha || null,
    region: null,
    fuente: row.fuente || row.fuente_tipo || 'manual',
    categoria: row.categoria || null,
    provincias: [],
    sectores: [],
    subsectores: [],
    tipos_alerta: [],
    estado_ia: 'listo',
    duplicado_de: null,
    organization_id: row.organization_id || null,
    created_at: null,
    semantic_similarity: Number.isFinite(Number(row.similitud ?? row.similarity))
      ? Number(row.similitud ?? row.similarity)
      : null,
    retrieval_sources: ['manual_semantic', 'semantic'],
  };
}

function fechaAlertaISO(alerta = {}) {
  const match = String(alerta.fecha || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || null;
}

function cumpleFiltrosObjetivosAlertaMIA(alerta = {}, filtros = {}, regiones = []) {
  if (filtros.alerts_only && alerta.source_type === 'manual') return false;

  const fecha = fechaAlertaISO(alerta);
  if (filtros.temporal?.desde && (!fecha || fecha < filtros.temporal.desde)) return false;
  if (filtros.temporal?.hasta && (!fecha || fecha > filtros.temporal.hasta)) return false;

  const fuentes = Array.isArray(filtros.fuentes) ? filtros.fuentes : [];
  if (fuentes.length > 0 && !fuentes.includes(String(alerta.fuente || '').toUpperCase())) return false;

  if (regiones.length > 0 && regionesEncontradas(alerta, regiones).length === 0) return false;
  return true;
}

function aplicarFiltrosQueryMIA(query, filtros = {}) {
  let next = query;
  if (filtros.temporal?.desde) next = next.gte('fecha', filtros.temporal.desde);
  if (filtros.temporal?.hasta) next = next.lte('fecha', filtros.temporal.hasta);

  const fuentes = Array.isArray(filtros.fuentes) ? filtros.fuentes : [];
  if (fuentes.length === 1) next = next.eq('fuente', fuentes[0]);
  if (fuentes.length > 1) next = next.in('fuente', fuentes);
  return next;
}

async function buscarAlertasLexicasMIA(supabase, {
  terminos = [],
  regiones = [],
  filtros = {},
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

  const tieneFiltrosConsultables = Boolean(filtros.temporal || (filtros.fuentes || []).length);
  if (terminosBusqueda.length === 0 && !tieneFiltrosConsultables) return [];

  const perTermLimit = Math.max(15, Math.ceil(limit / Math.max(1, terminosBusqueda.length)));
  const consultas = terminosBusqueda.length > 0 ? terminosBusqueda : [null];
  const queries = consultas.map(async (term) => {
    let query = supabase
      .from('alertas')
      .select('id, titulo, resumen, resumen_final, url, fecha, region, fuente, provincias, sectores, subsectores, tipos_alerta, estado_ia, duplicado_de, organization_id, created_at')
      .order('created_at', { ascending: false })
      .limit(term ? perTermLimit : limit);

    if (term) {
      if (term === 'pac') {
        query = query.or('titulo.fts.pac,resumen_final.fts.pac,resumen.fts.pac,contenido.fts.pac');
      } else {
        const pattern = `%${term}%`;
        query = query.or(`titulo.ilike.${pattern},resumen_final.ilike.${pattern},resumen.ilike.${pattern},contenido.ilike.${pattern},region.ilike.${pattern}`);
      }
    }

    query = query.eq('estado_ia', 'listo').is('duplicado_de', null);
    query = aplicarFiltrosQueryMIA(query, filtros);
    const orgId = normalizarOrganizationId(organizationId);
    query = orgId
      ? query.or(`organization_id.is.null,organization_id.eq.${orgId}`)
      : query.is('organization_id', null);

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map((alerta) => ({
      ...alerta,
      verified_terms: term === 'pac' ? ['pac'] : [],
    }));
  });

  return (await Promise.all(queries))
    .flat()
    .filter((alerta) => cumpleFiltrosObjetivosAlertaMIA(alerta, filtros, regiones));
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

async function buscarManualesSemanticosMIA(supabase, {
  texto,
  limit = 20,
  usarMock = false,
  organizationId = null,
} = {}) {
  if (String(process.env.MIA_KNOWLEDGE_MANUALS_ENABLED || 'true').toLowerCase() === 'false') {
    return { ok: true, available: false, skipped: true, reason: 'manuals_disabled', items: [] };
  }

  if (!usarMock && !process.env.OPENAI_API_KEY) {
    return { ok: true, available: false, skipped: true, reason: 'openai_api_key_missing', items: [] };
  }

  try {
    inicializarOpenAI();
    const embedding = await generarEmbedding(String(texto || '').trim(), usarMock);
    const { data, error } = await supabase.rpc(KNOWLEDGE_CHUNKS_RPC_NAME, {
      p_query_embedding: vectorToSql(embedding),
      p_match_count: Math.max(3, Math.min(50, Number(limit) || 20)),
      p_min_similarity: Number(process.env.MIA_KNOWLEDGE_MANUAL_MIN_SIMILARITY || 0.2),
      p_organization_id: normalizarOrganizationId(organizationId),
    });

    if (error) throw error;
    return {
      ok: true,
      available: true,
      skipped: false,
      items: (data || []).map(normalizarCandidatoManualMIA).filter((item) => item.id),
    };
  } catch (error) {
    if (esRpcSemanticaNoDisponible(error)) {
      return { ok: true, available: false, skipped: true, reason: 'manuals_rpc_missing', items: [] };
    }
    console.warn('[mia:knowledge] Busqueda semantica en manuales no disponible:', error.message);
    return { ok: false, available: false, skipped: true, reason: 'manuals_error', error: error.message, items: [] };
  }
}

async function hidratarExtractosContenidoMIA(supabase, items = [], terminos = []) {
  const ids = [...new Set((items || [])
    .filter((item) => (item.verified_terms || []).length > 0)
    .map((item) => Number(item.id))
    .filter(Boolean))];
  if (ids.length === 0) return items;

  const { data, error } = await supabase
    .from('alertas')
    .select('id, contenido')
    .in('id', ids);
  if (error) throw error;

  const contenidoPorId = new Map((data || []).map((row) => [Number(row.id), row.contenido || '']));
  return (items || []).map((item) => {
    const contenido = contenidoPorId.get(Number(item.id));
    if (!contenido) return item;
    return {
      ...item,
      snippet: construirSnippet({ resumen: contenido }, item.verified_terms?.length ? item.verified_terms : terminos, 520),
    };
  });
}

async function buscarAlertasRelacionadasMIA(supabase, {
  texto,
  limit = 5,
  usarMockEmbedding = false,
  organizationId = null,
  now = new Date(),
} = {}) {
  const terminos = extraerTerminosConsultaMIA(texto);
  const regiones = extraerRegionesConsultaMIA(texto);
  const tipoPregunta = detectarTipoPreguntaMIA(texto);
  const filtros = extraerFiltrosConsultaMIA(texto, { now });
  const tieneFiltroObjetivo = Boolean(filtros.temporal || filtros.fuentes.length);
  if (terminos.length === 0 && regiones.length === 0 && !tieneFiltroObjetivo) {
    return {
      terminos,
      regiones,
      tipo_pregunta: tipoPregunta,
      filtros,
      retrieval: {
        mode: 'none',
        scope: filtros.alerts_only ? 'alertas' : 'knowledge',
        search_completed: false,
        lexical_count: 0,
        semantic_count: 0,
        semantic_available: false,
      },
      items: [],
      organization_id: normalizarOrganizationId(organizationId),
    };
  }

  const contexto = { terminos, regiones, tipoPregunta, filtros };
  const puedeBuscarSemantica = terminos.length > 0 || regiones.length > 0;
  const omitido = (reason) => ({
    ok: true,
    available: false,
    skipped: true,
    reason,
    items: [],
  });
  const [lexicalItems, semanticResult, manualResult] = await Promise.all([
    buscarAlertasLexicasMIA(supabase, {
      terminos,
      regiones,
      filtros,
      limit: 100,
      organizationId,
    }),
    puedeBuscarSemantica
      ? buscarAlertasSemanticasMIA(supabase, { texto, limit: 50, usarMock: usarMockEmbedding, organizationId })
      : Promise.resolve(omitido('objective_filters_only')),
    !filtros.alerts_only && puedeBuscarSemantica
      ? buscarManualesSemanticosMIA(supabase, { texto, limit: 30, usarMock: usarMockEmbedding, organizationId })
      : Promise.resolve(omitido(filtros.alerts_only ? 'alerts_only' : 'objective_filters_only')),
  ]);

  const semanticItems = (semanticResult.items || [])
    .filter((alerta) => cumpleFiltrosObjetivosAlertaMIA(alerta, filtros, regiones));

  const rankedItems = combinarYRankearAlertasMIA({
    lexicalItems,
    semanticItems: [
      ...semanticItems,
      ...(manualResult.items || []),
    ],
    contexto,
    limit,
  });
  const items = await hidratarExtractosContenidoMIA(supabase, rankedItems, terminos);

  return {
    terminos,
    regiones,
    tipo_pregunta: tipoPregunta,
    filtros,
    retrieval: {
      mode: filtros.alerts_only
        ? (semanticResult.available ? 'alerts_hybrid' : 'alerts_lexical')
        : ((semanticResult.available || manualResult.available) ? 'hybrid' : 'lexical'),
      scope: filtros.alerts_only ? 'alertas' : 'knowledge',
      search_completed: true,
      lexical_count: lexicalItems.length,
      semantic_count: semanticItems.length,
      manual_count: (manualResult.items || []).length,
      semantic_available: semanticResult.available === true || manualResult.available === true,
      semantic_reason: semanticResult.reason || null,
      semantic_error: semanticResult.error || null,
      manuals_available: manualResult.available === true,
      manuals_reason: manualResult.reason || null,
      manuals_error: manualResult.error || null,
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
  filtros = {},
  retrieval = {},
  items = [],
  organizationContext = null,
} = {}) {
  const branding = obtenerMiaBranding(organizationContext);
  const tieneFiltroObjetivo = Boolean(
    filtros.temporal
    || (filtros.fuentes || []).length
    || regiones.length
  );
  const minimoTerminos = terminos.length > 0
    ? Math.min(2, Math.ceil(terminos.length * 0.5))
    : 0;
  const itemsConEncajeObjetivo = (items || []).filter((item) => {
    const matchingTerms = new Set(item.matching_terms || []).size;
    const matchingRegions = new Set(item.matching_regions || []).size;
    return matchingTerms >= minimoTerminos
      || (minimoTerminos === 0 && (matchingRegions > 0 || tieneFiltroObjetivo));
  });
  const top = itemsConEncajeObjetivo[0] || null;
  if (!top || Number(top.score || 0) < 4) {
    if (filtros.alerts_only && retrieval.search_completed) {
      const ambito = [
        terminos.length > 0 ? `sobre ${terminos.join(', ')}` : null,
        filtros.fuentes?.length ? `en ${filtros.fuentes.join(', ')}` : null,
        filtros.temporal?.kind === 'day' ? `del ${filtros.temporal.desde}` : filtros.temporal?.label,
      ].filter(Boolean).join(' ');
      return {
        answered: true,
        needs_agent: false,
        confidence: 0.92,
        evidence_level: 'alta',
        reply: `No he encontrado alertas publicadas${ambito ? ` ${ambito}` : ''}.`,
        matches: [],
        search_completed: true,
        answer_source: 'alerts_search_no_results',
        answer_guardrails: ['read_only_alerts_search', 'verified_empty_result'],
      };
    }
    return {
      answered: false,
      needs_agent: true,
      confidence: 0.2,
      evidence_level: 'sin_evidencia',
      reply: `Lo revisa ${branding.agent_label} y te contestamos cuando haya una respuesta clara.`,
      matches: [],
    };
  }

  const evidenceLevel = terminos.length === 0 && tieneFiltroObjetivo
    ? 'alta'
    : clasificarEvidencia(top.score, top.matching_terms || [], terminos);
  const preguntaSensible = ['pago', 'fecha_resolucion', 'plazo'].includes(tipoPregunta);
  const tieneFechas = (top.fechas_detectadas || []).length > 0 || Boolean(top.fecha);
  const needsAgent = preguntaSensible || evidenceLevel === 'baja';
  const matches = itemsConEncajeObjetivo.slice(0, 3);
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
    search_completed: retrieval.search_completed === true,
  };
}

async function resolverPreguntaConBaseConocimientoMIA(supabase, {
  texto,
  limit = 5,
  usarMockEmbedding = false,
  organizationId = null,
  organizationContext = null,
  now = new Date(),
} = {}) {
  const {
    terminos,
    regiones,
    tipo_pregunta: tipoPregunta,
    filtros,
    retrieval,
    items,
  } = await buscarAlertasRelacionadasMIA(supabase, {
    texto,
    limit,
    usarMockEmbedding,
    organizationId,
    now,
  });
  const respuestaBase = construirRespuestaConAlertasMIA({
    texto,
    terminos,
    regiones,
    tipo_pregunta: tipoPregunta,
    filtros,
    retrieval,
    items,
    organizationContext,
  });
  const respuestaGrounded = respuestaBase.answer_source === 'alerts_search_no_results'
    ? {
        reply: respuestaBase.reply,
        answer_source: respuestaBase.answer_source,
        answer_guardrails: respuestaBase.answer_guardrails,
        evidences: [],
      }
    : await generarRespuestaGroundedMIA({
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
    filtros,
    retrieval,
    search_completed: retrieval.search_completed === true,
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
      search_completed: respuesta.search_completed === true,
      filtros: respuesta.filtros || null,
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
  extraerFiltroTemporalConsultaMIA,
  extraerFuentesConsultaMIA,
  detectarConsultaHistoricaAlertasMIA,
  extraerFiltrosConsultaMIA,
  detectarTipoPreguntaMIA,
  esPreguntaDeFecha,
  extraerFechasTexto,
  puntuarAlerta,
  cumpleFiltrosObjetivosAlertaMIA,
  buscarAlertasLexicasMIA,
  buscarAlertasSemanticasMIA,
  buscarManualesSemanticosMIA,
  combinarYRankearAlertasMIA,
  buscarAlertasRelacionadasMIA,
  construirRespuestaConAlertasMIA,
  resolverPreguntaConBaseConocimientoMIA,
  aplicarRespuestaConocimientoADecision,
};
