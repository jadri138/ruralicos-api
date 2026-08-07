const {
  CONTRACT_VERSIONS,
  EVIDENCE_LEVELS,
  REASON_CODES,
  TRUTH_CARD_STATES,
} = require('./contracts');
const {
  MARCADORES_NACIONALES,
  PROVINCIAS_POR_FUENTE,
} = require('../../../shared/geography');

const CRITICAL_EVIDENCE_FIELDS = Object.freeze([
  'territory',
  'beneficiaries',
  'action',
  'official_url',
]);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Comunidad autónoma -> provincias que abarca. Vive aquí porque la ficha ya
// debe distinguir el ámbito al construirse: si una comunidad se guarda como
// provincia, la expansión autonómica posterior nunca ocurre y una convocatoria
// regional queda bloqueada para las provincias que sí cubre.
const AUTONOMOUS_COMMUNITY_PROVINCES = Object.freeze({
  andalucia: ['almeria', 'cadiz', 'cordoba', 'granada', 'huelva', 'jaen', 'malaga', 'sevilla'],
  aragon: ['huesca', 'teruel', 'zaragoza'],
  asturias: ['asturias'],
  'principado de asturias': ['asturias'],
  'illes balears': ['illes balears', 'islas baleares', 'baleares'],
  baleares: ['illes balears', 'islas baleares', 'baleares'],
  canarias: ['las palmas', 'santa cruz de tenerife'],
  cantabria: ['cantabria'],
  'castilla la mancha': ['albacete', 'ciudad real', 'cuenca', 'guadalajara', 'toledo'],
  'castilla y leon': ['avila', 'burgos', 'leon', 'palencia', 'salamanca', 'segovia', 'soria', 'valladolid', 'zamora'],
  cataluna: ['barcelona', 'girona', 'lleida', 'tarragona'],
  'comunitat valenciana': ['alicante', 'castellon', 'valencia'],
  'comunidad valenciana': ['alicante', 'castellon', 'valencia'],
  extremadura: ['badajoz', 'caceres'],
  galicia: ['a coruna', 'lugo', 'ourense', 'pontevedra'],
  madrid: ['madrid'],
  'comunidad de madrid': ['madrid'],
  murcia: ['murcia'],
  'region de murcia': ['murcia'],
  navarra: ['navarra'],
  'comunidad foral de navarra': ['navarra'],
  'pais vasco': ['alava', 'araba', 'bizkaia', 'vizcaya', 'gipuzkoa', 'guipuzcoa'],
  'la rioja': ['la rioja'],
  ceuta: ['ceuta'],
  melilla: ['melilla'],
});

function isAutonomousCommunity(value) {
  return Object.prototype.hasOwnProperty.call(
    AUTONOMOUS_COMMUNITY_PROVINCES,
    normalizeText(value)
  );
}

// Separa una lista mezclada de territorios en comunidades y provincias.
// Madrid, Murcia, Navarra, Cantabria y La Rioja son ambas cosas: se conservan
// en los dos lados para que coincidan tanto por provincia como por comunidad.
function splitTerritoryScopes(values = []) {
  const regions = [];
  const provinces = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || normalized === 'nacional' || esTerritorioSinDato(value)) continue;
    if (isAutonomousCommunity(value)) {
      regions.push(value);
      const expanded = AUTONOMOUS_COMMUNITY_PROVINCES[normalized];
      if (expanded.length === 1 && expanded[0] === normalized) provinces.push(value);
    } else {
      provinces.push(value);
    }
  }
  return { regions, provinces };
}

// El extractor de fichas escribe un valor centinela cuando NO ha detectado
// territorio ("no_detectado"). Consumirlo como si fuera una provincia real
// hacía chocar toda alerta estatal contra el territorio del usuario: el
// 5-08-2026 bloqueó 53 candidatas con TERRITORY_MISMATCH y dejó cero digests.
const TERRITORIO_SIN_DATO = new Set([
  '',
  'nd',
  'n a',
  'na',
  'no detectado',
  'no detectada',
  'no detectados',
  'no determinado',
  'no consta',
  'no aplica',
  'no disponible',
  'desconocido',
  'desconocida',
  'sin determinar',
  'sin especificar',
  'sin territorio',
  'sin datos',
  'pendiente',
  'null',
  'none',
  'ninguno',
  'ninguna',
  'varios',
  'varias',
]);

function esTerritorioSinDato(value) {
  return TERRITORIO_SIN_DATO.has(normalizeText(value));
}

// Ámbito respaldado por el boletín que publica la alerta. Es la misma regla que
// aplica el motor de selección desde hace meses (`esAlertaNacional`): el BOE y
// el FEGA publican en todo el Estado y cada boletín autonómico cubre sus
// provincias. Sin ella una convocatoria estatal se queda sin territorio y
// ninguna persona la recibe.
function ambitoTerritorialDeFuente(fuente) {
  const clave = String(fuente || '').trim().toUpperCase();
  const provincias = PROVINCIAS_POR_FUENTE[clave];
  if (!Array.isArray(provincias) || provincias.length === 0) return null;
  const national = provincias.some((value) => MARCADORES_NACIONALES.has(normalizeText(value)));
  return {
    source: clave,
    national,
    provinces: national ? [] : [...provincias],
  };
}

function evidenciaTerritorialDeFuente(scope) {
  if (!scope) return null;
  const valores = scope.national ? ['nacional'] : scope.provinces;
  return {
    ref: 'truth:territory',
    field: 'territory',
    level: EVIDENCE_LEVELS.SUPPORTED,
    confidence: 0.6,
    fragments: valores.map((value) => ({
      value,
      fragment: `Publicado en ${scope.source}`,
      source: 'alert.fuente',
      confidence: 0.6,
      level: EVIDENCE_LEVELS.SUPPORTED,
    })),
  };
}

function compactText(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 3).trim()}...`;
}

function uniqueStrings(value) {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const raw = typeof item === 'object' && item !== null
      ? item.valor ?? item.value ?? item.name
      : item;
    const text = compactText(raw, 180);
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function normalizeScore(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number > 1 ? number / 100 : number));
}

function evidenceLevel(field) {
  if (field?.status === 'not_applicable') return EVIDENCE_LEVELS.NOT_APPLICABLE;
  const value = field?.valor ?? field?.value;
  const evidence = field?.evidencia ?? field?.evidence;
  if (!value && field?.status !== 'verified') return EVIDENCE_LEVELS.UNSUPPORTED;
  if (!evidence) return EVIDENCE_LEVELS.UNCERTAIN;
  if (field?.evidence_level === 'official' && field?.status === 'verified') {
    return EVIDENCE_LEVELS.VERIFIED;
  }
  return EVIDENCE_LEVELS.SUPPORTED;
}

function normalizeEvidence(fieldName, rawField) {
  const entries = Array.isArray(rawField) ? rawField : rawField == null ? [] : [rawField];
  const fragments = entries.map((entry) => {
    const object = typeof entry === 'object' && entry !== null ? entry : { valor: entry };
    return {
      value: object.valor ?? object.value ?? null,
      fragment: compactText(object.evidencia ?? object.evidence, 500),
      source: compactText(object.source ?? object.source_field, 120),
      confidence: normalizeScore(object.confidence),
      level: evidenceLevel(object),
    };
  }).filter((entry) => entry.value != null || entry.fragment);

  const order = {
    [EVIDENCE_LEVELS.VERIFIED]: 5,
    [EVIDENCE_LEVELS.SUPPORTED]: 4,
    [EVIDENCE_LEVELS.UNCERTAIN]: 3,
    [EVIDENCE_LEVELS.UNSUPPORTED]: 2,
    [EVIDENCE_LEVELS.NOT_APPLICABLE]: 1,
  };
  const best = fragments.reduce((current, item) => (
    !current || order[item.level] > order[current.level] ? item : current
  ), null);

  return {
    ref: `truth:${fieldName}`,
    field: fieldName,
    level: best?.level || EVIDENCE_LEVELS.UNSUPPORTED,
    confidence: best?.confidence || 0,
    fragments,
  };
}

function evidenceFromLegacy(fieldName, value, sourceText, options = {}) {
  const values = uniqueStrings(value);
  const source = compactText(sourceText, 500);
  const supported = values.length > 0
    && source
    && values.some((item) => normalizeText(source).includes(normalizeText(item)));
  return {
    ref: `truth:${fieldName}`,
    field: fieldName,
    level: supported ? EVIDENCE_LEVELS.SUPPORTED : (
      values.length ? EVIDENCE_LEVELS.UNCERTAIN : EVIDENCE_LEVELS.UNSUPPORTED
    ),
    confidence: supported ? 0.55 : 0.2,
    fragments: values.map((item) => ({
      value: item,
      fragment: supported ? source : null,
      source: options.source || 'legacy_alert',
      confidence: supported ? 0.55 : 0.2,
      level: supported ? EVIDENCE_LEVELS.SUPPORTED : EVIDENCE_LEVELS.UNCERTAIN,
    })),
  };
}

function firstField(...values) {
  return values.find((value) => {
    const raw = value?.valor ?? value?.value ?? value;
    return raw !== null && raw !== undefined && String(raw).trim();
  }) || null;
}

function fieldValue(field) {
  return field?.valor ?? field?.value ?? (typeof field === 'object' ? null : field) ?? null;
}

function mapCardStatus(status, flags = []) {
  const normalized = normalizeText(status).replace(/ /g, '_');
  const normalizedFlags = flags.map(normalizeText);
  if (normalizedFlags.some((flag) => flag.includes('caduc') || flag.includes('expired'))) {
    return TRUTH_CARD_STATES.EXPIRED;
  }
  if (['blocked', 'bloqueado'].includes(normalized)) return TRUTH_CARD_STATES.BLOCKED;
  if (['ready_for_digest', 'ready', 'listo'].includes(normalized)) return TRUTH_CARD_STATES.READY;
  if (['review_only', 'review', 'revision'].includes(normalized)) return TRUTH_CARD_STATES.REVIEW;
  return TRUTH_CARD_STATES.INCOMPLETE;
}

function adaptFactSheetV3(input = {}, options = {}) {
  const row = input.fact_sheet ? input : {};
  const sheet = input.fact_sheet || input;
  const legacy = options.legacyAlert || options.alerta || {};
  const deadlineField = firstField(
    sheet.application_deadline,
    sheet.allegation_deadline,
    sheet.justification_deadline,
    sheet.appeal_deadline,
    sheet.plazo
  );
  const territoryValues = uniqueStrings(sheet.territorio).filter((value) => !esTerritorioSinDato(value));
  const normalizedTerritories = territoryValues.map(normalizeText);
  const declaredNational = normalizedTerritories.some((value) => ['nacional', 'espana', 'todo el territorio nacional'].includes(value));
  const declaredRegions = uniqueStrings(
    sheet.resumen_estructurado?.comunidades
      || legacy.comunidades
      || legacy.comunidades_autonomas
      || legacy.ccaa
  );
  const municipalities = uniqueStrings(sheet.resumen_estructurado?.municipios || legacy.municipios);
  // El campo `territorio` mezcla comunidades y provincias. Clasificarlo aquí es
  // lo que permite que una convocatoria autonómica llegue a sus provincias.
  const scopes = splitTerritoryScopes(territoryValues);
  const declaredRegionScopes = uniqueStrings([...declaredRegions, ...scopes.regions]);
  // Sin ámbito declarado manda el boletín de publicación. Es la única fuente
  // que queda y es oficial: una convocatoria del BOE es estatal aunque la ficha
  // no haya sabido extraer el territorio del texto.
  const sourceScope = declaredNational
    || declaredRegionScopes.length
    || scopes.provinces.length
    || municipalities.length
    ? null
    : ambitoTerritorialDeFuente(legacy.fuente || sheet.document_trace?.source || options.source);
  const national = declaredNational || Boolean(sourceScope?.national);
  const regions = declaredRegionScopes;
  const provinces = sourceScope && !sourceScope.national ? sourceScope.provinces : scopes.provinces;
  const flags = uniqueStrings([...(sheet.flags || []), ...(row.flags || [])]);
  const reasons = uniqueStrings([...(sheet.reasons || []), ...(row.reasons || [])]);
  const contradiction = flags.some((flag) => /contradic|conflict/i.test(flag));
  const individualCase = flags.some((flag) => /individual|personal|expediente/i.test(flag))
    || Boolean(sheet.resumen_estructurado?.expediente_individual);

  const evidence = {
    title: normalizeEvidence('title', sheet.tema_principal),
    summary: normalizeEvidence('summary', sheet.resumen_neutro),
    beneficiaries: normalizeEvidence('beneficiaries', sheet.beneficiarios),
    territory: sourceScope
      ? evidenciaTerritorialDeFuente(sourceScope)
      : normalizeEvidence('territory', sheet.territorio),
    deadline: normalizeEvidence('deadline', deadlineField),
    action: normalizeEvidence('action', firstField(sheet.accion_codigo, sheet.accion_requerida)),
    amount: normalizeEvidence('amount', sheet.importe),
    official_url: normalizeEvidence('official_url', sheet.url_oficial),
  };

  return {
    contract_version: CONTRACT_VERSIONS.truthCard,
    source_schema_version: sheet.schema_version || row.schema_version || 'fact_sheet_v3',
    builder_version: sheet.builder_version || row.builder_version || null,
    generated_at: sheet.generated_at || row.generated_at || null,
    identity: {
      alert_id: sheet.alerta_id ?? row.alerta_id ?? legacy.id ?? legacy.alerta_id ?? null,
      source: compactText(legacy.fuente || sheet.document_trace?.source || options.source, 100),
      document_id: sheet.raw_document_id || sheet.document_trace?.official_id || null,
      content_hash: sheet.content_hash || null,
      published_at: fieldValue(sheet.publication_date) || legacy.fecha || null,
      official_url: fieldValue(sheet.url_oficial) || legacy.url || null,
    },
    nature: {
      type: fieldValue(sheet.tipo_documento) || uniqueStrings(legacy.tipos_alerta)[0] || null,
      topic: fieldValue(sheet.tema_principal) || null,
      title: compactText(fieldValue(sheet.tema_principal) || legacy.titulo, 220),
      summary: compactText(fieldValue(sheet.resumen_neutro) || legacy.resumen_final, 800),
    },
    beneficiaries: {
      description: fieldValue(sheet.beneficiarios),
      included: uniqueStrings(sheet.resumen_estructurado?.beneficiarios_incluidos),
      excluded: uniqueStrings(sheet.resumen_estructurado?.beneficiarios_excluidos),
      conditions: uniqueStrings(sheet.requisitos).map((item) => compactText(item, 240)),
    },
    activity: {
      sectors: uniqueStrings(sheet.sectores),
      subsectors: uniqueStrings(sheet.subsectores),
      crops: uniqueStrings(sheet.resumen_estructurado?.cultivos || legacy.cultivos),
      species: uniqueStrings(sheet.resumen_estructurado?.especies || legacy.especies),
      legal_forms: uniqueStrings(sheet.resumen_estructurado?.figuras_juridicas),
    },
    territory: {
      level: national ? 'national' : municipalities.length ? 'municipal' : regions.length ? 'regional' : 'provincial',
      national,
      regions,
      provinces,
      municipalities,
      individual_case: individualCase,
    },
    action: {
      code: fieldValue(sheet.accion_codigo),
      label: fieldValue(sheet.accion_requerida),
    },
    time: {
      published_at: fieldValue(sheet.publication_date) || legacy.fecha || null,
      opens_at: fieldValue(sheet.effective_date),
      deadline: fieldValue(deadlineField),
      expired: mapCardStatus(sheet.status || row.status, flags) === TRUTH_CARD_STATES.EXPIRED,
    },
    value: {
      amount: fieldValue(sheet.importe),
      benefit: compactText(sheet.resumen_estructurado?.beneficio, 300),
      consequence: compactText(sheet.resumen_estructurado?.consecuencia, 300),
    },
    evidence,
    risk: {
      individual_case: individualCase,
      personal_data: flags.some((flag) => /dato personal|personal_data/i.test(flag)),
      incomplete_text: flags.some((flag) => /incomplet|truncad/i.test(flag)),
      contradiction,
      flags,
    },
    quality: {
      truth: normalizeScore(sheet.truth_score ?? row.truth_score),
      risk: normalizeScore(sheet.risk_score ?? row.risk_score),
      coverage: normalizeScore(sheet.evidence_coverage ?? row.evidence_coverage),
    },
    status: mapCardStatus(sheet.status || row.status, flags),
    reasons,
    compatibility: {
      legacy: false,
      source_supported: sheet.schema_version === 'fact_sheet_v3' || row.schema_version === 'fact_sheet_v3',
    },
  };
}

function adaptLegacyAlert(alert = {}) {
  const sourceText = [alert.titulo, alert.contenido, alert.resumen_final].filter(Boolean).join(' ');
  const territoryValues = uniqueStrings(alert.provincias).filter((value) => !esTerritorioSinDato(value));
  const declaredNational = territoryValues.some(
    (province) => MARCADORES_NACIONALES.has(normalizeText(province))
  );
  // `provincias` trae también comunidades autónomas ("Andalucía", "Aragón").
  // Sin separarlas, la barrera territorial bloqueaba una convocatoria regional
  // para los usuarios de sus propias provincias.
  const legacyScopes = splitTerritoryScopes(territoryValues);
  const declaredMunicipalities = uniqueStrings(alert.municipios);
  const declaredRegionsLegacy = uniqueStrings([
    ...uniqueStrings(alert.comunidades || alert.ccaa),
    ...legacyScopes.regions,
  ]);
  // Igual que en la ficha v3: si la alerta no declara territorio, el boletín
  // que la publica es la evidencia territorial que queda.
  const sourceScope = declaredNational
    || declaredRegionsLegacy.length
    || legacyScopes.provinces.length
    || declaredMunicipalities.length
    ? null
    : ambitoTerritorialDeFuente(alert.fuente);
  const national = declaredNational || Boolean(sourceScope?.national);
  const provinces = sourceScope && !sourceScope.national
    ? sourceScope.provinces
    : legacyScopes.provinces;
  const action = alert.accion || alert.accion_requerida || null;
  const deadline = alert.plazo || alert.fecha_limite || null;
  const beneficiaries = alert.beneficiarios || null;
  const officialUrl = alert.url || null;
  const evidence = {
    title: evidenceFromLegacy('title', alert.titulo, sourceText),
    summary: evidenceFromLegacy('summary', alert.resumen_final || alert.contenido, sourceText),
    beneficiaries: evidenceFromLegacy('beneficiaries', beneficiaries, sourceText),
    // La evidencia cubre todo el ámbito declarado, comunidades incluidas: si
    // sólo mirara `provinces`, una convocatoria autonómica se quedaría sin
    // respaldo territorial y caería por falta de evidencia.
    territory: sourceScope
      ? evidenciaTerritorialDeFuente(sourceScope)
      : evidenceFromLegacy('territory', territoryValues, sourceText),
    deadline: evidenceFromLegacy('deadline', deadline, sourceText),
    action: evidenceFromLegacy('action', action, sourceText),
    amount: evidenceFromLegacy('amount', alert.importe, sourceText),
    official_url: {
      ref: 'truth:official_url',
      field: 'official_url',
      level: officialUrl ? EVIDENCE_LEVELS.SUPPORTED : EVIDENCE_LEVELS.UNSUPPORTED,
      confidence: officialUrl ? 0.6 : 0,
      fragments: officialUrl ? [{
        value: officialUrl,
        fragment: officialUrl,
        source: 'legacy_alert.url',
        confidence: 0.6,
        level: EVIDENCE_LEVELS.SUPPORTED,
      }] : [],
    },
  };

  return {
    contract_version: CONTRACT_VERSIONS.truthCard,
    source_schema_version: 'legacy_alert_v1',
    builder_version: null,
    generated_at: null,
    identity: {
      alert_id: alert.id ?? alert.alerta_id ?? null,
      source: compactText(alert.fuente, 100),
      document_id: null,
      content_hash: alert.content_hash || null,
      published_at: alert.fecha || null,
      official_url: officialUrl,
    },
    nature: {
      type: uniqueStrings(alert.tipos_alerta)[0] || null,
      topic: compactText(alert.tema_principal, 180),
      title: compactText(alert.titulo, 220),
      summary: compactText(alert.resumen_final || alert.contenido, 800),
    },
    beneficiaries: {
      description: beneficiaries,
      included: [],
      excluded: [],
      conditions: uniqueStrings(alert.requisitos),
    },
    activity: {
      sectors: uniqueStrings(alert.sectores),
      subsectors: uniqueStrings(alert.subsectores),
      crops: uniqueStrings(alert.cultivos),
      species: uniqueStrings(alert.especies),
      legal_forms: [],
    },
    territory: {
      level: national
        ? 'national'
        : declaredMunicipalities.length
          ? 'municipal'
          : declaredRegionsLegacy.length && !provinces.length
            ? 'regional'
            : 'provincial',
      national,
      regions: declaredRegionsLegacy,
      provinces,
      municipalities: declaredMunicipalities,
      individual_case: Boolean(alert.expediente_individual),
    },
    action: { code: null, label: action },
    time: { published_at: alert.fecha || null, opens_at: null, deadline, expired: false },
    value: { amount: alert.importe || null, benefit: null, consequence: null },
    evidence,
    risk: {
      individual_case: Boolean(alert.expediente_individual),
      personal_data: false,
      incomplete_text: true,
      contradiction: false,
      flags: ['legacy_compatibility'],
    },
    quality: { truth: 0.5, risk: 0.5, coverage: 0.35 },
    status: TRUTH_CARD_STATES.REVIEW,
    reasons: ['legacy_compatibility'],
    compatibility: { legacy: true, source_supported: true },
  };
}

function adaptAlertTruthCard(input, options = {}) {
  if (input?.contract_version === CONTRACT_VERSIONS.truthCard) return input;
  const sheet = input?.fact_sheet || input;
  const schema = sheet?.schema_version || input?.schema_version;
  if (schema === 'fact_sheet_v3' || input?.fact_sheet) return adaptFactSheetV3(input, options);
  return adaptLegacyAlert(options.legacyAlert || options.alerta || input || {});
}

function evidenceIsUsable(evidence) {
  return [EVIDENCE_LEVELS.VERIFIED, EVIDENCE_LEVELS.SUPPORTED].includes(evidence?.level);
}

function getCriticalEvidenceGaps(card, options = {}) {
  const fields = [...CRITICAL_EVIDENCE_FIELDS];
  if (options.forUrgency) fields.push('deadline');
  if (options.requireAmount) fields.push('amount');
  return fields.filter((field) => !evidenceIsUsable(card?.evidence?.[field]));
}

function validateAlertTruthCard(card) {
  const errors = [];
  if (!card || typeof card !== 'object') errors.push('card_not_object');
  if (card?.contract_version !== CONTRACT_VERSIONS.truthCard) errors.push('unsupported_contract_version');
  if (card?.source_schema_version !== 'fact_sheet_v3' && card?.source_schema_version !== 'legacy_alert_v1') {
    errors.push('unsupported_source_schema_version');
  }
  if (card?.identity?.alert_id === null || card?.identity?.alert_id === undefined) errors.push('missing_alert_id');
  if (!Object.values(TRUTH_CARD_STATES).includes(card?.status)) errors.push('invalid_status');
  for (const field of CRITICAL_EVIDENCE_FIELDS) {
    if (!card?.evidence?.[field]?.ref) errors.push(`missing_evidence_contract:${field}`);
  }
  return {
    valid: errors.length === 0,
    errors,
    missing_critical: card ? getCriticalEvidenceGaps(card) : [...CRITICAL_EVIDENCE_FIELDS],
  };
}

function evidenceGapReason(field) {
  return {
    territory: REASON_CODES.TERRITORY_EVIDENCE_MISSING,
    beneficiaries: REASON_CODES.BENEFICIARY_EVIDENCE_MISSING,
    action: REASON_CODES.ACTION_EVIDENCE_MISSING,
    deadline: REASON_CODES.DEADLINE_EVIDENCE_MISSING,
    official_url: REASON_CODES.OFFICIAL_URL_MISSING,
  }[field] || REASON_CODES.INSUFFICIENT_EVIDENCE;
}

module.exports = {
  CRITICAL_EVIDENCE_FIELDS,
  AUTONOMOUS_COMMUNITY_PROVINCES,
  TERRITORIO_SIN_DATO,
  ambitoTerritorialDeFuente,
  esTerritorioSinDato,
  isAutonomousCommunity,
  splitTerritoryScopes,
  normalizeText,
  compactText,
  uniqueStrings,
  normalizeScore,
  adaptFactSheetV3,
  adaptLegacyAlert,
  adaptAlertTruthCard,
  evidenceIsUsable,
  getCriticalEvidenceGaps,
  validateAlertTruthCard,
  evidenceGapReason,
};
