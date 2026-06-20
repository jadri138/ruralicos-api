const {
  compactarTexto,
  normalizarTexto,
  normalizarLista,
  crearCampo,
  crearFactSheetBase,
} = require('./factSheetSchema');
const {
  crearTraceDesdeRawDocument,
  resolverDocumentTrace,
} = require('./documentTrace');
const { validarFactSheet } = require('./factSheetValidator');

const PROVINCE_ALIASES = {
  huesca: ['huesca'],
  zaragoza: ['zaragoza'],
  teruel: ['teruel'],
  nacional: ['nacional', 'espana', 'todo el territorio nacional', 'ambito estatal'],
  todas: ['nacional', 'espana', 'todo el territorio nacional', 'ambito estatal'],
};

const SECTOR_ALIASES = {
  agricultura: [
    'agricultura', 'agricola', 'agricolas', 'agrario', 'agraria', 'agrarios', 'agrarias',
    'agricultor', 'agricultores', 'agricultora', 'agricultoras',
    'agroalimentario', 'agroalimentaria', 'agropecuario', 'agropecuaria',
    'cultivo', 'cultivos', 'explotacion agraria', 'explotaciones agrarias',
    'explotacion agricola', 'explotaciones agricolas', 'cereal',
  ],
  ganaderia: [
    'ganaderia', 'ganadero', 'ganadera', 'ganaderas', 'ganaderos',
    'vacuno', 'ovino', 'caprino', 'porcino', 'avicola', 'apicola', 'apicultura',
    'bienestar animal', 'sanidad animal', 'cabaña ganadera',
  ],
  pesca: ['pesca', 'pesquero', 'pesquera', 'acuicultura', 'maritimo', 'maritima'],
};

const SUBSECTOR_ALIASES = {
  agua: ['agua', 'riego', 'regadio', 'regadios', 'regante', 'regantes', 'concesion de aguas', 'comunidad de regantes', 'goteo', 'aspersion'],
  vacuno: ['vacuno', 'bovino', 'bovinos', 'vaca', 'vacas', 'ternero', 'terneros'],
  ovino: ['ovino', 'oveja', 'ovejas', 'cordero', 'corderos'],
  caprino: ['caprino', 'cabra', 'cabras', 'cabrito'],
  porcino: ['porcino', 'cerdo', 'cerdos', 'lechon', 'cebo'],
  avicultura: ['avicultura', 'avicola', 'pollo', 'pollos', 'gallina', 'gallinas', 'huevo', 'huevos'],
  apicultura: ['apicultura', 'apicola', 'abeja', 'abejas', 'miel', 'colmena', 'colmenas'],
  equino: ['equino', 'equinos', 'caballo', 'caballos', 'yegua', 'yeguas'],
  cereal: ['cereal', 'cereales', 'trigo', 'cebada', 'maiz', 'avena', 'centeno'],
  olivar: ['olivar', 'olivares', 'olivo', 'olivos', 'aceituna', 'aceitunas', 'aceite de oliva', 'almazara'],
  vinedo: ['vinedo', 'vinedos', 'vina', 'vinas', 'vid', 'vides', 'uva', 'uvas', 'viticultura', 'bodega'],
  almendro: ['almendro', 'almendros', 'almendra', 'almendras'],
  frutos_secos: ['frutos secos', 'nuez', 'nueces', 'avellana', 'avellanas', 'pistacho', 'pistachos'],
  citricos: ['citricos', 'citrico', 'naranja', 'naranjas', 'mandarina', 'limon', 'limones'],
  hortalizas: ['hortaliza', 'hortalizas', 'huerta', 'horticola', 'horticolas', 'tomate', 'pimiento', 'lechuga', 'cebolla', 'ajo'],
  frutal: ['frutal', 'frutales', 'fruta', 'frutas', 'manzana', 'pera', 'melocoton', 'cereza', 'ciruela'],
  forestal: ['forestal', 'forestales', 'monte', 'montes', 'bosque', 'bosques', 'madera'],
  energia: ['energia', 'fotovoltaica', 'placas solares', 'autoconsumo', 'biogas', 'biomasa'],
  medio_ambiente: ['medio ambiente', 'ambiental', 'biodiversidad', 'nitratos', 'residuos', 'natura 2000'],
};

const GENERIC_PATTERNS = [
  /publicacion oficial relevante/i,
  /revisar si (afecta|aplica)/i,
  /determinar su aplicabilidad/i,
  /consulta(r)? el documento completo/i,
];

function partirFrases(texto) {
  return String(texto || '')
    .replace(/\r/g, '\n')
    .split(/\n+|(?<=[.!?])\s+/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function crearBloquesFuente(alerta = {}, trace = null) {
  const rawDocument = trace?.rawDocument || null;
  const blocks = [];

  if (rawDocument?.texto_raw) {
    blocks.push({ source: 'raw_document.texto_raw', text: rawDocument.texto_raw, official: true });
  }

  if (trace?.text_excerpt && !rawDocument?.texto_raw) {
    blocks.push({ source: 'document_trace.text_excerpt', text: trace.text_excerpt, official: true });
  }

  for (const [source, text] of [
    ['alerta.contenido', alerta.contenido],
    ['alerta.resumen_final', alerta.resumen_final],
    ['alerta.resumen_borrador', alerta.resumen_borrador],
    ['alerta.resumen', alerta.resumen || alerta.resumenfree],
    ['alerta.titulo', alerta.titulo],
  ]) {
    if (text) blocks.push({ source, text, official: false });
  }

  return blocks.flatMap((block) =>
    partirFrases(block.text).map((sentence) => ({
      ...block,
      sentence,
      normalized: normalizarTexto(sentence),
    }))
  );
}

function buscarEvidencia(blocks, patterns = []) {
  for (const block of blocks) {
    for (const pattern of patterns) {
      if (typeof pattern === 'string') {
        if (block.normalized.includes(normalizarTexto(pattern))) return block;
      } else if (pattern.test(block.sentence) || pattern.test(block.normalized)) {
        return block;
      }
    }
  }
  return null;
}

function campoDesdeBloque(valor, block, confidence = 0.75) {
  if (!block) return crearCampo();
  return crearCampo(valor, block.sentence, {
    source: block.source,
    confidence: block.official ? Math.max(confidence, 0.9) : confidence,
  });
}

function extraerValorEtiqueta(sentence, label) {
  const regex = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'i');
  const match = String(sentence || '').match(regex);
  return match ? compactarTexto(match[1], 240) : null;
}

function valorNoGenerico(value) {
  const text = String(value || '').trim();
  return text && !GENERIC_PATTERNS.some((pattern) => pattern.test(text));
}

function extraerTipoDocumento(alerta = {}, blocks = []) {
  const tipos = normalizarLista(alerta.tipos_alerta, normalizarTexto);
  const candidates = [
    {
      valor: 'ayuda_subvencion',
      patterns: [/ayudas?/i, /subvenciones?/i, /convocatoria/i, /bases reguladoras/i],
      tipos: ['ayudas_subvenciones', 'ayuda', 'subvencion'],
    },
    {
      valor: 'curso_formacion',
      patterns: [/curso/i, /jornada/i, /formacion/i],
      tipos: ['cursos_formacion', 'formacion'],
    },
    {
      valor: 'pac',
      patterns: [/\bpac\b/i, /\bfega\b/i, /\bsigpac\b/i],
      tipos: ['pac', 'plazos'],
    },
    {
      valor: 'agua_riego',
      patterns: [/agua/i, /riego/i, /regadio/i, /regantes/i],
      tipos: ['agua_infraestructuras'],
    },
    {
      valor: 'sancion_notificacion',
      patterns: [/sancion/i, /procedimiento sancionador/i, /notificacion/i],
      tipos: ['sanciones'],
    },
    {
      valor: 'licitacion',
      patterns: [/licitacion/i, /contrato/i, /adjudicacion/i, /formalizacion/i],
      tipos: ['licitaciones'],
    },
    {
      valor: 'normativa_general',
      patterns: [/orden\b/i, /decreto/i, /resolucion/i, /normativa/i, /informacion publica/i],
      tipos: ['normativa_general', 'medio_ambiente'],
    },
  ];

  for (const candidate of candidates) {
    const block = buscarEvidencia(blocks, candidate.patterns);
    if (block && (!tipos.length || candidate.tipos.some((tipo) => tipos.includes(tipo)) || candidate.valor === 'normativa_general')) {
      return campoDesdeBloque(candidate.valor, block, 0.82);
    }
  }

  return crearCampo();
}

function extraerTemaPrincipal(alerta = {}, blocks = []) {
  const title = compactarTexto(alerta.titulo, 180);
  if (!valorNoGenerico(title)) return crearCampo();
  const block = buscarEvidencia(blocks, [title]) || blocks.find((item) => item.source === 'alerta.titulo');
  return campoDesdeBloque(title, block, 0.78);
}

function extraerResumenNeutro(alerta = {}, blocks = []) {
  const labels = ['RESUMEN_DIGEST', 'HECHO', 'OBJETO'];
  for (const block of blocks) {
    for (const label of labels) {
      const value = extraerValorEtiqueta(block.sentence, label);
      if (valorNoGenerico(value)) return campoDesdeBloque(value, block, 0.78);
    }
  }

  const fallback = compactarTexto(alerta.resumen_final || alerta.resumen || alerta.contenido, 320);
  if (!valorNoGenerico(fallback)) return crearCampo();
  const block = buscarEvidencia(blocks, [fallback]) || blocks.find((item) => item.sentence.includes(fallback.slice(0, 30)));
  return campoDesdeBloque(fallback, block, 0.62);
}

function extraerValoresConEvidencia(values, aliasMap, blocks) {
  const result = [];
  const seen = new Set();

  for (const value of values) {
    const normalized = normalizarTexto(value);
    if (!normalized || seen.has(normalized)) continue;
    const aliases = aliasMap[normalized] || [normalized];
    const block = buscarEvidencia(blocks, aliases);
    if (!block) continue;
    result.push(campoDesdeBloque(normalized, block, 0.78));
    seen.add(normalized);
  }

  return result;
}

function extraerTerritorio(alerta = {}, blocks = []) {
  const declared = [
    ...normalizarLista(alerta.provincias, normalizarTexto),
    ...normalizarLista(alerta.region, normalizarTexto),
  ];
  return extraerValoresConEvidencia(declared, PROVINCE_ALIASES, blocks);
}

function extraerSectores(alerta = {}, blocks = []) {
  return extraerValoresConEvidencia(normalizarLista(alerta.sectores, normalizarTexto), SECTOR_ALIASES, blocks);
}

function extraerSubsectores(alerta = {}, blocks = []) {
  return extraerValoresConEvidencia(normalizarLista(alerta.subsectores, normalizarTexto), SUBSECTOR_ALIASES, blocks);
}

function extraerAccion(blocks = []) {
  const actionPatterns = [
    /presentar solicitud/i,
    /solicitud/i,
    /inscrip/i,
    /alegaciones?/i,
    /subsan/i,
    /revisar (requisitos|convocatoria|anexo|listado|obligaciones|inscripcion)/i,
    /comprobar (requisitos|plazo|listado|anexo)/i,
  ];
  const block = buscarEvidencia(blocks, actionPatterns);
  if (!block) return crearCampo();
  const labelValue = extraerValorEtiqueta(block.sentence, 'ACCION');
  return campoDesdeBloque(labelValue || compactarTexto(block.sentence, 220), block, 0.74);
}

function extraerPlazo(blocks = []) {
  const negativePattern = /\b(no\s+(aparece|consta|hay|permite confirmar)|sin)\s+(un\s+)?plazo\b|\bplazo\s+(no\s+)?claro\b/i;

  for (const block of blocks) {
    if (negativePattern.test(block.sentence)) continue;
    const labelValue = extraerValorEtiqueta(block.sentence, 'PLAZO');
    if (labelValue) return campoDesdeBloque(labelValue, block, 0.84);
  }

  const block = blocks.find((item) => {
    if (negativePattern.test(item.sentence)) return false;
    return Boolean(buscarEvidencia([item], [
      /\bplazo\b/i,
      /\bhasta el\b/i,
      /\bfinaliza\b/i,
      /\b\d{1,2}\s+dias?\s+(habiles|naturales)?\b/i,
      /\balegaciones?\s+durante\b/i,
      /\b\d{1,2}\s+de\s+[a-z]+(\s+de\s+\d{4})?\b/i,
    ]));
  });

  return campoDesdeBloque(block ? compactarTexto(block.sentence, 220) : null, block, 0.76);
}

function extraerBeneficiarios(blocks = []) {
  for (const block of blocks) {
    const labelValue = extraerValorEtiqueta(block.sentence, 'BENEFICIARIOS');
    if (labelValue) return campoDesdeBloque(labelValue, block, 0.84);
  }

  const block = buscarEvidencia(blocks, [
    /beneficiarios?/i,
    /dirigid[ao]s?\s+a/i,
    /titulares?\s+de/i,
    /explotaciones?\s+(agrarias|ganaderas|agricolas)/i,
    /comunidades?\s+de\s+regantes/i,
  ]);

  return campoDesdeBloque(block ? compactarTexto(block.sentence, 220) : null, block, 0.75);
}

function extraerImporte(blocks = []) {
  for (const block of blocks) {
    const labelValue = extraerValorEtiqueta(block.sentence, 'IMPORTE');
    if (labelValue) return campoDesdeBloque(labelValue, block, 0.84);
  }

  const block = buscarEvidencia(blocks, [
    /\b\d{1,3}(?:[.,]\d{3})*(?:,\d{2})?\s*euros?\b/i,
    /\bimporte\b/i,
    /\bcuantia\b/i,
  ]);

  return campoDesdeBloque(block ? compactarTexto(block.sentence, 180) : null, block, 0.76);
}

function extraerRequisitos(blocks = []) {
  const block = buscarEvidencia(blocks, [
    /requisitos?/i,
    /documentacion/i,
    /deberan/i,
    /anexo/i,
  ]);
  return block ? [campoDesdeBloque(compactarTexto(block.sentence, 220), block, 0.68)] : [];
}

function extraerUrl(alerta = {}, trace = null) {
  const url = String(trace?.source_url || alerta.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return crearCampo();
  return crearCampo(url, url, {
    source: trace?.source_url ? 'document_trace.source_url' : 'alerta.url',
    confidence: trace?.source_url ? 0.95 : 0.82,
  });
}

function crearTraceLocal(alerta, options = {}) {
  if (options.documentTrace) return options.documentTrace;
  if (options.rawDocument) {
    return crearTraceDesdeRawDocument({
      alerta,
      rawDocument: options.rawDocument,
      organizationId: options.organizationId,
    });
  }
  return {
    ok: true,
    found: false,
    available: false,
    status: 'not_loaded',
    reason: 'not_loaded',
    rawDocument: null,
    evidence_available: false,
    source_url: null,
    raw_document_id: null,
    content_hash: null,
    warnings: [],
  };
}

function construirFactSheetDesdeTrace(alerta = {}, trace = null, options = {}) {
  const sheet = crearFactSheetBase({ alerta, trace, now: options.now || new Date() });
  const blocks = crearBloquesFuente(alerta, trace);

  sheet.tipo_documento = extraerTipoDocumento(alerta, blocks);
  sheet.tema_principal = extraerTemaPrincipal(alerta, blocks);
  sheet.resumen_neutro = extraerResumenNeutro(alerta, blocks);
  sheet.territorio = extraerTerritorio(alerta, blocks);
  sheet.sectores = extraerSectores(alerta, blocks);
  sheet.subsectores = extraerSubsectores(alerta, blocks);
  sheet.accion_requerida = extraerAccion(blocks);
  sheet.plazo = extraerPlazo(blocks);
  sheet.beneficiarios = extraerBeneficiarios(blocks);
  sheet.importe = extraerImporte(blocks);
  sheet.requisitos = extraerRequisitos(blocks);
  sheet.url_oficial = extraerUrl(alerta, trace);

  return validarFactSheet(sheet, { alerta });
}

function construirFactSheetAlertaSync(alerta = {}, options = {}) {
  const trace = crearTraceLocal(alerta, options);
  return construirFactSheetDesdeTrace(alerta, trace, options);
}

async function construirFactSheetAlerta(alerta = {}, options = {}) {
  if (options.documentTrace || options.rawDocument || !options.supabase) {
    return construirFactSheetAlertaSync(alerta, options);
  }

  const trace = await resolverDocumentTrace(options.supabase, {
    alerta,
    organizationId: options.organizationId,
  }, options.traceOptions || {});
  return construirFactSheetDesdeTrace(alerta, trace, options);
}

module.exports = {
  crearBloquesFuente,
  construirFactSheetAlerta,
  construirFactSheetAlertaSync,
  construirFactSheetDesdeTrace,
};
