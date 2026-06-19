const {
  DOCUMENT_TYPES,
  EVIDENCE_COVERAGE,
  FACT_SHEET_STATUS,
  NO_VERIFICADO,
  normalizarTexto,
  limpiarTexto,
  crearFact,
  crearArrayFact,
  crearEvidence,
  calcularEvidenceScore,
  coverageFromScore,
  crearFactSheetBase,
} = require('./factSheetSchema');

const TIPO_TERMS = [
  { value: DOCUMENT_TYPES.AYUDA_SUBVENCION, terms: ['subvencion', 'subvenciones', 'ayuda', 'ayudas', 'bases reguladoras', 'convocatoria'] },
  { value: DOCUMENT_TYPES.CONCESION, terms: ['concesion', 'aprovechamiento de aguas', 'comisaria de aguas'] },
  { value: DOCUMENT_TYPES.SANCION, terms: ['sancion', 'expediente sancionador', 'procedimiento sancionador'] },
  { value: DOCUMENT_TYPES.FORMACION, terms: ['curso', 'jornada', 'formacion', 'taller', 'seminario'] },
  { value: DOCUMENT_TYPES.ANUNCIO_PUBLICO, terms: ['informacion publica', 'exposicion publica', 'alegaciones', 'tramite de audiencia'] },
  { value: DOCUMENT_TYPES.NORMATIVA, terms: ['orden', 'resolucion', 'decreto', 'reglamento', 'ley'] },
];

const TEMA_TERMS = [
  { value: 'agua_riego', terms: ['agua', 'aguas', 'riego', 'regadio', 'regantes', 'hidraulica'] },
  { value: 'agricultura', terms: ['agricultura', 'agraria', 'agrario', 'cultivo', 'explotaciones agrarias', 'olivar', 'vinedo'] },
  { value: 'ganaderia', terms: ['ganaderia', 'ganadera', 'ganadero', 'bovino', 'ovino', 'caprino', 'sanidad animal'] },
  { value: 'medio_ambiente', terms: ['medio ambiente', 'impacto ambiental', 'evaluacion ambiental', 'biodiversidad'] },
  { value: 'forestal', terms: ['forestal', 'monte', 'montes', 'incendios forestales'] },
  { value: 'formacion', terms: ['curso', 'jornada', 'formacion', 'taller'] },
];

const ACCION_TERMS = [
  { value: 'presentar_solicitud', terms: ['presentar solicitud', 'plazo de solicitud', 'solicitar la ayuda', 'solicitar subvencion'] },
  { value: 'presentar_alegaciones', terms: ['presentar alegaciones', 'alegaciones', 'informacion publica', 'tramite de audiencia'] },
  { value: 'inscribirse', terms: ['inscripcion', 'inscribirse', 'matricula'] },
  { value: 'subsanar', terms: ['subsanacion', 'subsanar'] },
];

const BENEFICIARIO_TERMS = [
  'beneficiarios',
  'destinatarios',
  'titulares de explotaciones',
  'agricultores',
  'ganaderos',
  'jovenes agricultores',
  'comunidades de regantes',
  'personas fisicas o juridicas',
];

const REQUISITO_TERMS = [
  'requisitos',
  'estar al corriente',
  'acreditar',
  'cumplir',
  'inscritos en el registro',
];

const EXPEDIENTE_TERMS = [
  'expediente',
  'a favor de',
  'solicitado por',
  'a instancia de',
  'poligono',
  'parcela',
];

const TERRITORIOS = [
  'Andalucia', 'Aragon', 'Asturias', 'Cantabria', 'Castilla-La Mancha', 'Castilla y Leon',
  'Cataluna', 'Comunidad de Madrid', 'Comunidad Valenciana', 'Extremadura', 'Galicia',
  'Illes Balears', 'Canarias', 'La Rioja', 'Navarra', 'Pais Vasco', 'Murcia', 'Ceuta', 'Melilla',
  'Almeria', 'Cadiz', 'Cordoba', 'Granada', 'Huelva', 'Jaen', 'Malaga', 'Sevilla',
  'Huesca', 'Teruel', 'Zaragoza', 'Avila', 'Burgos', 'Leon', 'Palencia', 'Salamanca',
  'Segovia', 'Soria', 'Valladolid', 'Zamora', 'Albacete', 'Ciudad Real', 'Cuenca',
  'Guadalajara', 'Toledo', 'Barcelona', 'Girona', 'Lleida', 'Tarragona', 'Alicante',
  'Castellon', 'Valencia', 'Badajoz', 'Caceres', 'A Coruna', 'Lugo', 'Ourense',
  'Pontevedra', 'Bizkaia', 'Gipuzkoa', 'Alava',
];

function crearChunksFuente({ rawDocument = null, textoFuente = null } = {}) {
  const chunks = [];
  const add = (source, text) => {
    const clean = limpiarTexto(text, 12000);
    if (clean) chunks.push({ source, text: clean, normalized: normalizarTexto(clean) });
  };

  if (textoFuente) add('textoFuente', textoFuente);

  if (rawDocument) {
    add('rawDocument.titulo', rawDocument.titulo || rawDocument.title);
    add('rawDocument.texto_raw', rawDocument.texto_raw || rawDocument.texto || rawDocument.contenido);
    add('rawDocument.organismo', rawDocument.organismo);
    add('rawDocument.seccion', rawDocument.seccion);
    add('rawDocument.boletin', rawDocument.boletin);
  }

  return chunks;
}

function dividirFrases(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function quoteForTerm(chunk, normalizedNeedle) {
  const sentences = dividirFrases(chunk.text);
  const needle = normalizarTexto(normalizedNeedle);
  const found = sentences.find((sentence) => normalizarTexto(sentence).includes(needle));
  return found || chunk.text.slice(0, 500);
}

function buscarTermino(chunks, terms = []) {
  for (const chunk of chunks) {
    for (const term of terms) {
      const normalizedTerm = normalizarTexto(term);
      if (normalizedTerm && chunk.normalized.includes(normalizedTerm)) {
        return {
          source: chunk.source,
          value: term,
          quote: quoteForTerm(chunk, normalizedTerm),
        };
      }
    }
  }
  return null;
}

function buscarGrupo(chunks, groups = []) {
  for (const group of groups) {
    const hit = buscarTermino(chunks, group.terms);
    if (hit) return { ...hit, value: group.value };
  }
  return null;
}

function buscarRegexNormalizado(chunks, regex) {
  for (const chunk of chunks) {
    const match = chunk.normalized.match(regex);
    if (!match) continue;
    return {
      source: chunk.source,
      value: match[0],
      quote: quoteForTerm(chunk, match[0]),
      match,
    };
  }
  return null;
}

function addEvidenceFact(sheet, field, value, hit) {
  if (!hit || value === null || value === undefined || value === NO_VERIFICADO) return;
  const evidenceId = `E${sheet.evidences.length + 1}`;
  const evidence = crearEvidence({
    id: evidenceId,
    source: hit.source,
    quote: hit.quote,
    field,
    value,
  });
  if (!evidence) return;
  sheet.evidences.push(evidence);
  sheet.facts[field] = crearFact(value, [evidenceId]);
}

function addArrayEvidenceFact(sheet, field, values = [], hits = []) {
  const cleanValues = [];
  const evidenceRefs = [];
  for (const hit of hits) {
    const value = hit.value;
    if (!value || cleanValues.includes(value)) continue;
    const evidenceId = `E${sheet.evidences.length + 1}`;
    const evidence = crearEvidence({
      id: evidenceId,
      source: hit.source,
      quote: hit.quote,
      field,
      value,
    });
    if (!evidence) continue;
    sheet.evidences.push(evidence);
    cleanValues.push(value);
    evidenceRefs.push(evidenceId);
  }
  sheet.facts[field] = crearArrayFact(values.length ? values : cleanValues, evidenceRefs);
}

function detectarTitulo(chunks, rawDocument) {
  const rawTitle = limpiarTexto(rawDocument?.titulo || rawDocument?.title, 300);
  if (rawTitle) return { value: rawTitle, source: 'rawDocument.titulo', quote: rawTitle };

  const textChunk = chunks.find((chunk) => chunk.source === 'textoFuente') || chunks[0];
  if (!textChunk) return null;
  const firstLine = String(textChunk.text).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return null;
  return { value: firstLine.slice(0, 220), source: textChunk.source, quote: firstLine };
}

function detectarPlazo(chunks) {
  const hit = buscarRegexNormalizado(chunks, /\bplazo\s+de\s+\d{1,3}\s+dias(?:\s+habiles|\s+naturales)?\b/);
  if (hit) return hit;
  return buscarRegexNormalizado(chunks, /\bhasta\s+el\s+\d{1,2}\s+de\s+[a-z]+\s+de\s+\d{4}\b|\bhasta\s+el\s+\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/);
}

function detectarImporte(chunks) {
  const importeExplicito = buscarRegexNormalizado(chunks, /\b\d[\d .]*(?:,\d+)?\s*(?:euros|eur)\b/);
  if (importeExplicito) return importeExplicito;
  return buscarRegexNormalizado(chunks, /\b(?:importe|cuantia|dotacion)\b[^.]{0,60}?\d[\d .]*(?:,\d+)?\s*(?:euros|eur)?/);
}

function detectarTerritorio(chunks) {
  for (const territorio of TERRITORIOS) {
    const hit = buscarTermino(chunks, [territorio]);
    if (hit) return { ...hit, value: territorio };
  }
  return null;
}

function detectarRequisitos(chunks) {
  const hits = [];
  for (const term of REQUISITO_TERMS) {
    const hit = buscarTermino(chunks, [term]);
    if (hit) hits.push({ ...hit, value: term });
    if (hits.length >= 5) break;
  }
  return hits;
}

function derivarStatus(sheet) {
  if (!sheet.source.has_raw_document && !sheet.source.has_texto_fuente) return FACT_SHEET_STATUS.REVIEW_ONLY;
  if (sheet.source.relation_verified === false) return FACT_SHEET_STATUS.REVIEW_ONLY;
  if (sheet.evidence_coverage === EVIDENCE_COVERAGE.BAJO) return FACT_SHEET_STATUS.REVIEW_ONLY;
  if (sheet.evidence_coverage === EVIDENCE_COVERAGE.MEDIO) return FACT_SHEET_STATUS.PARTIAL;
  return FACT_SHEET_STATUS.READY;
}

function construirFactSheet(input = {}) {
  const alerta = input.alerta || {};
  const rawDocument = input.rawDocument || null;
  const textoFuente = input.textoFuente || null;
  const sheet = crearFactSheetBase({ alerta, rawDocument, textoFuente });
  const chunks = crearChunksFuente({ rawDocument, textoFuente });

  if (alerta.raw_document_id !== undefined) {
    sheet.warnings.push({
      code: 'alerta_raw_document_id_ignored',
      detail: 'El builder no depende de alertas.raw_document_id; usa rawDocument opcional o textoFuente.',
    });
  }

  if (sheet.source.relation_verified === false) {
    sheet.warnings.push({
      code: 'raw_document_alerta_mismatch',
      detail: 'raw_documents.inserted_alerta_id no coincide con alertas.id.',
    });
  }

  if (chunks.length === 0) {
    sheet.warnings.push({
      code: 'sin_evidencia_textual',
      detail: 'No hay rawDocument ni textoFuente; se crea ficha parcial solo para revision.',
    });
    return sheet;
  }

  const titulo = detectarTitulo(chunks, rawDocument);
  if (titulo) addEvidenceFact(sheet, 'titulo_oficial', titulo.value, titulo);

  const tipo = buscarGrupo(chunks, TIPO_TERMS);
  if (tipo) addEvidenceFact(sheet, 'tipo_documento', tipo.value, tipo);

  const tema = buscarGrupo(chunks, TEMA_TERMS);
  if (tema) addEvidenceFact(sheet, 'tema_principal', tema.value, tema);

  const territorio = detectarTerritorio(chunks);
  if (territorio) addEvidenceFact(sheet, 'territorio', territorio.value, territorio);

  const beneficiarios = buscarTermino(chunks, BENEFICIARIO_TERMS);
  if (beneficiarios) addEvidenceFact(sheet, 'beneficiarios', normalizarTexto(beneficiarios.value), beneficiarios);

  const accion = buscarGrupo(chunks, ACCION_TERMS);
  if (accion) addEvidenceFact(sheet, 'accion_requerida', accion.value, accion);

  const plazo = detectarPlazo(chunks);
  if (plazo) addEvidenceFact(sheet, 'plazo', plazo.value, plazo);

  const importe = detectarImporte(chunks);
  if (importe) addEvidenceFact(sheet, 'importe', importe.value, importe);

  const expediente = buscarTermino(chunks, EXPEDIENTE_TERMS);
  if (expediente) addEvidenceFact(sheet, 'expediente', normalizarTexto(expediente.value), expediente);

  const requisitos = detectarRequisitos(chunks);
  addArrayEvidenceFact(sheet, 'requisitos', requisitos.map((hit) => normalizarTexto(hit.value)), requisitos);

  sheet.evidence_score = calcularEvidenceScore(sheet.facts);
  sheet.evidence_coverage = coverageFromScore(sheet.evidence_score);
  sheet.status = derivarStatus(sheet);

  return sheet;
}

module.exports = {
  construirFactSheet,
  buildFactSheet: construirFactSheet,
  crearChunksFuente,
  detectarPlazo,
  detectarTerritorio,
};
