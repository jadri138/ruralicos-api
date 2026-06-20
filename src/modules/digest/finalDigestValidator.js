const {
  FACT_SHEET_STATUS,
  campoVerificado,
  normalizarTexto,
} = require('../alertas/intelligence/factSheetSchema');

const FINAL_DIGEST_VALIDATOR_VERSION = 'final_digest_validator_v1';

const STATUS_WEIGHT = {
  send: 0,
  review_only: 1,
  blocked: 2,
};

const SPANISH_PROVINCES = [
  'alava',
  'araba',
  'albacete',
  'alicante',
  'alacant',
  'almeria',
  'asturias',
  'avila',
  'badajoz',
  'barcelona',
  'burgos',
  'caceres',
  'cadiz',
  'cantabria',
  'castellon',
  'ciudad real',
  'cordoba',
  'cuenca',
  'girona',
  'gerona',
  'granada',
  'guadalajara',
  'gipuzkoa',
  'guipuzcoa',
  'huelva',
  'huesca',
  'jaen',
  'la coruna',
  'a coruna',
  'la rioja',
  'leon',
  'lleida',
  'lerida',
  'lugo',
  'madrid',
  'malaga',
  'murcia',
  'navarra',
  'ourense',
  'orense',
  'palencia',
  'pontevedra',
  'salamanca',
  'segovia',
  'sevilla',
  'soria',
  'tarragona',
  'teruel',
  'toledo',
  'valencia',
  'valladolid',
  'bizkaia',
  'vizcaya',
  'zamora',
  'zaragoza',
];

function compactarTexto(value, max = 420) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function elevarStatus(actual, siguiente) {
  return STATUS_WEIGHT[siguiente] > STATUS_WEIGHT[actual] ? siguiente : actual;
}

function addIssue(issues, status, code, detail) {
  issues.push({ status, code, detail });
}

function valoresCampo(field) {
  if (Array.isArray(field)) return field.map((item) => item?.valor).filter(Boolean);
  return field?.valor ? [field.valor] : [];
}

function campoTextoVerificado(field) {
  return campoVerificado(field) && valoresCampo(field).length > 0;
}

function textoFactSheet(sheet = {}) {
  return normalizarTexto([
    sheet.tipo_documento?.valor,
    sheet.tema_principal?.valor,
    sheet.resumen_neutro?.valor,
    sheet.accion_requerida?.valor,
    sheet.plazo?.valor,
    sheet.beneficiarios?.valor,
    sheet.importe?.valor,
    ...(sheet.territorio || []).map((item) => item.valor),
    ...(sheet.sectores || []).map((item) => item.valor),
    ...(sheet.subsectores || []).map((item) => item.valor),
    ...(sheet.requisitos || []).map((item) => item.valor),
    ...(sheet.evidencias || []).map((item) => `${item.valor || ''} ${item.evidencia || ''}`),
  ].filter(Boolean).join(' '));
}

function textoAlerta(alerta = {}) {
  return normalizarTexto([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen,
    alerta.contenido,
    ...(Array.isArray(alerta.provincias) ? alerta.provincias : []),
    ...(Array.isArray(alerta.sectores) ? alerta.sectores : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
  ].filter(Boolean).join(' '));
}

function tieneUrl(texto) {
  return /https?:\/\/\S+/i.test(String(texto || ''));
}

function mencionaPlazo(texto) {
  const value = normalizarTexto(texto);
  return /\b(plazo|hasta el|antes del|alegaciones|subsanacion|subsanar|presentacion de solicitudes|dias habiles|fecha limite)\b/.test(value);
}

function mencionaImporte(texto) {
  const value = normalizarTexto(texto);
  return /(\bimporte\b|\bcuantia\b|\beuros?\b|€|\b\d+(?:[.,]\d+)?\s*(?:eur|euros?)\b)/i.test(value);
}

function mencionaAfectacionDirecta(texto) {
  const value = normalizarTexto(texto);
  return /\b(te afecta|afecta directamente|te aplica|para tu explotacion|tu explotacion|obligatorio para ti|tienes que|debes presentar|debes solicitar|encaja contigo)\b/.test(value);
}

function mencionaObligacion(texto) {
  const value = normalizarTexto(texto);
  return /\b(obligatorio|obligacion|debes|tienes que|queda obligado|debera|deberan)\b/.test(value);
}

function mencionaAyuda(texto, alerta = {}) {
  const value = `${normalizarTexto(texto)} ${textoAlerta(alerta)}`;
  return /\b(ayuda|ayudas|subvencion|subvenciones|convocatoria|pac|fega|sigpac|pago unico|prima)\b/.test(value);
}

function fraseGenerica(texto) {
  const value = normalizarTexto(texto);
  return /\b(publicacion oficial relevante|revisar si afecta|revisa si afecta|determinar su aplicabilidad|consulta el documento completo|revisar el documento completo|sin extracto oficial suficiente)\b/.test(value);
}

function ayudaSuficiente(sheet = {}) {
  const text = textoFactSheet(sheet);
  return campoTextoVerificado(sheet.beneficiarios) ||
    /\b(convocatoria|se convocan|bases reguladoras|beneficiarios|extracto de la resolucion|solicitudes)\b/.test(text) ||
    (
      campoTextoVerificado(sheet.tipo_documento) &&
      campoTextoVerificado(sheet.tema_principal) &&
      /\b(ayuda|subvencion|pac|fega|convocatoria)\b/.test(text)
    );
}

function actionDecision(decision = {}) {
  if (!decision || typeof decision !== 'object') return null;
  return decision.action || (decision.incluir === true ? 'include' : null);
}

function tieneMatchFuerte(decision = {}) {
  if (!decision || typeof decision !== 'object') return false;
  if (['fuerte', 'strong'].includes(String(decision.match_strength || '').toLowerCase())) return true;
  if (decision.strong_match === true) return true;

  const matches = decision.diagnostico?.policy?.matches || decision.matches || {};
  const territorio = Boolean(matches.provincia_expresa || matches.provincia_nacional || matches.territorio_expresso);
  const tema = Boolean(matches.sector_expreso || matches.subsector_expreso || matches.tipo_expreso);
  const riesgoBajo = !decision.riesgo || decision.riesgo === 'bajo';
  const score = Number(decision.score || 0);

  return actionDecision(decision) === 'include' && riesgoBajo && score >= 75 && territorio && tema;
}

const NATIONAL_SCOPE_PATTERN = /\b(nacional|estatal|espana|todo el territorio|ambito estatal|ambito nacional)\b/;

function territoriosVerificados(sheet = {}) {
  return new Set((sheet.territorio || [])
    .filter(campoVerificado)
    .map((item) => normalizarTexto(item.valor))
    .filter(Boolean));
}

// Una alerta de ambito nacional/estatal cubre cualquier provincia: nombrar provincias
// concretas en el mensaje no es un territorio inventado, es una concrecion legitima.
function esAmbitoNacionalVerificado(sheet = {}) {
  return [...territoriosVerificados(sheet)].some((territorio) => NATIONAL_SCOPE_PATTERN.test(territorio));
}

function territoriosCandidatos({ alerta = {}, user = {}, sheet = {} } = {}) {
  const prefs = user.preferences || {};
  return [
    ...(Array.isArray(alerta.provincias) ? alerta.provincias : []),
    ...(Array.isArray(alerta.territorio) ? alerta.territorio : []),
    ...(Array.isArray(prefs.provincias) ? prefs.provincias : []),
    ...(Array.isArray(prefs.municipios) ? prefs.municipios : []),
    ...(Array.isArray(prefs.localidades) ? prefs.localidades : []),
    ...valoresCampo(sheet.territorio),
    ...SPANISH_PROVINCES,
  ]
    .map(normalizarTexto)
    .filter((item) => item.length >= 3);
}

function territoriosNoVerificadosEnTexto(texto, context = {}) {
  const value = normalizarTexto(texto);
  const verified = territoriosVerificados(context.sheet);

  // Ambito nacional verificado => cualquier provincia mencionada esta cubierta.
  if (esAmbitoNacionalVerificado(context.sheet)) return [];

  const encontrados = new Set();

  for (const territorio of territoriosCandidatos(context)) {
    if (!territorio || verified.has(territorio)) continue;
    const pattern = new RegExp(`(^|\\b)${territorio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|$)`, 'i');
    if (pattern.test(value)) encontrados.add(territorio);
  }

  const reclamaZonaUsuario = /\b(en tu zona|tu zona|tu municipio|tu provincia|tu localidad|tu comarca)\b/.test(value);
  if (reclamaZonaUsuario && verified.size === 0) encontrados.add('territorio_del_usuario');

  return [...encontrados];
}

function resolverFactSheet(item = {}, factSheets = {}) {
  if (item.fact_sheet) return item.fact_sheet;
  if (item.factSheet) return item.factSheet;
  const alerta = item.alerta || item;
  if (alerta.fact_sheet) return alerta.fact_sheet;
  if (alerta.factSheet) return alerta.factSheet;

  const id = alerta.id ?? alerta.alerta_id ?? item.alerta_id;
  if (Array.isArray(factSheets)) {
    return factSheets.find((sheet) => Number(sheet.alerta_id) === Number(id)) || null;
  }
  if (factSheets && typeof factSheets === 'object') {
    return factSheets[id] || factSheets[String(id)] || null;
  }
  return null;
}

function resolverDecisionDigest(item = {}) {
  const alerta = item.alerta || item;
  return item.decision_digest ||
    item.selection_decision ||
    item.tags_json?.decision_digest ||
    item.tags_json?.selection ||
    alerta.decision_digest ||
    null;
}

function extraerBloquesItemsMensaje(mensaje = '') {
  const lines = String(mensaje || '').replace(/\r/g, '').split('\n');
  const bloques = [];
  let actual = null;

  for (const line of lines) {
    const match = line.match(/^\s*\*?\s*(\d{1,2})\.\s+/);
    if (match) {
      if (actual) bloques.push(actual);
      actual = {
        item_numero: Number(match[1]),
        texto: line,
      };
      continue;
    }

    if (actual) actual.texto += `\n${line}`;
  }

  if (actual) bloques.push(actual);
  return bloques;
}

function validarItemDigestFinal({
  item = {},
  alerta = null,
  texto = '',
  factSheet = null,
  decisionDigest = null,
  user = {},
} = {}) {
  const alert = alerta || item.alerta || item;
  const sheet = factSheet || item.fact_sheet || item.factSheet || alert.fact_sheet || null;
  const decision = decisionDigest || resolverDecisionDigest(item) || {};
  const text = String(texto || item.texto || item.mensaje || '').trim();
  const issues = [];

  if (!text) {
    addIssue(issues, 'blocked', 'item_text_missing', 'No hay bloque de texto para validar este item.');
  }

  if (!sheet || typeof sheet !== 'object') {
    addIssue(issues, 'review_only', 'fact_sheet_missing', 'No hay ficha evidence-first para validar el mensaje final.');
  } else {
    if (sheet.status === FACT_SHEET_STATUS.BLOCKED) {
      addIssue(issues, 'blocked', 'fact_sheet_blocked', 'La fact sheet esta marcada como blocked.');
    }

    if (sheet.status === FACT_SHEET_STATUS.REVIEW || sheet.status === FACT_SHEET_STATUS.INSUFFICIENT_EVIDENCE) {
      addIssue(issues, 'review_only', `fact_sheet_${sheet.status}`, `La fact sheet esta en estado ${sheet.status}.`);
    }

    if (!campoVerificado(sheet.url_oficial)) {
      addIssue(issues, 'blocked', 'official_url_missing', 'La ficha no tiene URL oficial verificada.');
    }

    if (Number(sheet.risk_score || 0) > 70) {
      addIssue(issues, 'blocked', 'fact_sheet_risk_critical', `Riesgo fact sheet ${sheet.risk_score}.`);
    } else if (Number(sheet.risk_score || 0) > 35) {
      addIssue(issues, 'review_only', 'fact_sheet_risk_high', `Riesgo fact sheet ${sheet.risk_score}.`);
    }

    if (Number(sheet.truth_score || 100) < 85) {
      addIssue(issues, 'review_only', 'truth_score_low', `Truth score ${sheet.truth_score}.`);
    }

    if (Number(sheet.evidence_coverage || 1) < 0.6) {
      addIssue(issues, 'review_only', 'evidence_coverage_low', `Cobertura ${sheet.evidence_coverage}.`);
    }
  }

  if (!tieneUrl(text)) {
    addIssue(issues, 'review_only', 'message_url_missing', 'El bloque del item no contiene ningun enlace.');
  }

  const action = actionDecision(decision);
  if (action === 'review_only') {
    addIssue(issues, 'review_only', 'selection_review_only', 'La decision de seleccion exige revision.');
  } else if (action && action !== 'include') {
    addIssue(issues, 'blocked', 'selection_not_sendable', `La decision de seleccion es ${action}.`);
  } else if (!action) {
    addIssue(issues, 'review_only', 'selection_missing', 'No hay decision de seleccion auditable.');
  }

  if (decision.riesgo_de_ruido === 'alto' || decision.riesgo === 'alto') {
    addIssue(issues, 'review_only', 'selection_noise_high', 'La decision de seleccion marca riesgo alto.');
  }

  if (mencionaPlazo(text) && !campoTextoVerificado(sheet?.plazo)) {
    addIssue(issues, 'blocked', 'deadline_claim_without_evidence', 'El mensaje menciona plazo o fecha limite sin plazo verificado.');
  }

  if (mencionaImporte(text) && !campoTextoVerificado(sheet?.importe)) {
    addIssue(issues, 'blocked', 'amount_claim_without_evidence', 'El mensaje menciona importe sin importe verificado.');
  }

  const territoriosNoVerificados = territoriosNoVerificadosEnTexto(text, { alerta: alert, user, sheet: sheet || {} });
  if (territoriosNoVerificados.length > 0) {
    addIssue(
      issues,
      'blocked',
      'territory_claim_without_evidence',
      `Territorio no verificado en el mensaje: ${territoriosNoVerificados.slice(0, 5).join(', ')}.`
    );
  }

  if (mencionaAfectacionDirecta(text) && !tieneMatchFuerte(decision)) {
    addIssue(issues, 'blocked', 'direct_impact_without_strong_match', 'El mensaje afirma afectacion directa sin match fuerte.');
  }

  if (mencionaObligacion(text) && !campoTextoVerificado(sheet?.accion_requerida)) {
    addIssue(issues, 'blocked', 'mandatory_action_without_evidence', 'El mensaje afirma una obligacion sin accion requerida verificada.');
  }

  if (mencionaAyuda(text, alert) && sheet && !ayudaSuficiente(sheet)) {
    addIssue(issues, 'review_only', 'aid_claim_weak_evidence', 'La ayuda/subvencion no demuestra convocatoria, beneficiarios o base suficiente.');
  }

  if (fraseGenerica(text)) {
    addIssue(issues, 'review_only', 'generic_digest_phrase', 'El mensaje contiene una frase generica no accionable.');
  }

  const status = issues.reduce((current, issue) => elevarStatus(current, issue.status), 'send');
  const flags = [...new Set(issues.map((issue) => issue.code))];

  return {
    version: FINAL_DIGEST_VALIDATOR_VERSION,
    ok: status === 'send',
    status,
    item_numero: item.item_numero ?? item.numero ?? null,
    alerta_id: alert?.id ?? alert?.alerta_id ?? item.alerta_id ?? null,
    flags,
    reasons: issues.map((issue) => ({
      code: issue.code,
      status: issue.status,
      detail: issue.detail,
    })),
    diagnostics: {
      text_excerpt: compactarTexto(text, 280),
      has_url: tieneUrl(text),
      selection_action: action,
      fact_sheet_status: sheet?.status || null,
      truth_score: sheet?.truth_score ?? null,
      risk_score: sheet?.risk_score ?? null,
      evidence_coverage: sheet?.evidence_coverage ?? null,
    },
  };
}

function construirItemsValidacion({ mensaje = '', items = [], alertas = [], factSheets = {} } = {}) {
  const bloques = extraerBloquesItemsMensaje(mensaje);
  const bloquePorNumero = new Map(bloques.map((bloque) => [Number(bloque.item_numero), bloque.texto]));
  const baseItems = items.length ? items : alertas.map((alerta, index) => ({
    ...alerta,
    item_numero: index + 1,
    alerta,
  }));

  if (baseItems.length === 1 && bloques.length === 0) {
    return [{
      item: baseItems[0],
      texto: mensaje,
      factSheet: resolverFactSheet(baseItems[0], factSheets),
    }];
  }

  return baseItems.map((item, index) => {
    const itemNumero = Number(item.item_numero || index + 1);
    return {
      item,
      texto: item.texto || item.mensaje || bloquePorNumero.get(itemNumero) || '',
      factSheet: resolverFactSheet(item, factSheets),
    };
  });
}

function validarDigestFinal({
  mensaje = '',
  items = [],
  alertas = [],
  factSheets = {},
  user = {},
} = {}) {
  const issues = [];
  const text = String(mensaje || '').trim();

  if (!text) {
    addIssue(issues, 'blocked', 'message_empty', 'El digest final esta vacio.');
  }

  const itemsValidacion = construirItemsValidacion({ mensaje: text, items, alertas, factSheets });
  if (itemsValidacion.length === 0) {
    addIssue(issues, 'blocked', 'items_empty', 'No hay items de digest para validar.');
  }

  const itemResults = itemsValidacion.map((entry) => validarItemDigestFinal({
    item: entry.item,
    alerta: entry.item.alerta || entry.item,
    texto: entry.texto,
    factSheet: entry.factSheet,
    decisionDigest: resolverDecisionDigest(entry.item),
    user,
  }));

  let status = issues.reduce((current, issue) => elevarStatus(current, issue.status), 'send');
  for (const result of itemResults) {
    status = elevarStatus(status, result.status);
  }

  const allReasons = [
    ...issues.map((issue) => ({ code: issue.code, status: issue.status, detail: issue.detail })),
    ...itemResults.flatMap((result) => result.reasons.map((reason) => ({
      ...reason,
      item_numero: result.item_numero,
      alerta_id: result.alerta_id,
    }))),
  ];

  return {
    version: FINAL_DIGEST_VALIDATOR_VERSION,
    ok: status === 'send',
    status,
    flags: [...new Set(allReasons.map((reason) => reason.code))],
    reasons: allReasons,
    item_results: itemResults,
    diagnostics: {
      items_total: itemResults.length,
      items_send: itemResults.filter((result) => result.status === 'send').length,
      items_review_only: itemResults.filter((result) => result.status === 'review_only').length,
      items_blocked: itemResults.filter((result) => result.status === 'blocked').length,
      message_has_url: tieneUrl(text),
    },
  };
}

module.exports = {
  FINAL_DIGEST_VALIDATOR_VERSION,
  extraerBloquesItemsMensaje,
  tieneMatchFuerte,
  validarItemDigestFinal,
  validarDigestFinal,
};
