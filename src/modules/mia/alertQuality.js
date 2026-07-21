const CRITICAL_ALERT_FLAGS = new Set([
  'duplicada',
  'descartada',
  'sin_titulo',
  'sin_url',
  'url_invalida',
  'sin_resumen_util',
  'listo_sin_resumen_final',
  'titulo_boletin_raw',
  'proceso_personal_publico',
  'pesca_maritimo_no_agrario',
  'administracion_general_no_agraria',
  'notificacion_individual',
  'personal_investigador_beca',
  'resumen_boilerplate_portal',
  'fact_sheet_blocked',
  'taxonomy_conflict',
  'empty_taxonomy_ready',
  'cross_sector_match',
  'decision_digest_missing',
  'review_only_sent',
]);

const FUENTES_SCRAPER_ESPERADAS = [
  'BOE',
  'BOA',
  'BOJA',
  'BOIB',
  'BOCM',
  'BOCYL',
  'BOCANT',
  'BOCAN',
  'DOGV',
  'DOGC',
  'DOG',
  'DOE',
  'DOCM',
  'BOPA',
  'BOPV',
  'BOR',
  'BON',
  'BORM',
  'BOCCE',
  'BOME',
  'FEGA',
  'BOTHA',
];

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function redondear(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function porcentaje(part, total) {
  if (!total) return 0;
  return redondear((Number(part || 0) / Number(total || 1)) * 100, 2);
}

function normalizarTextoCalidad(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function limpiarTexto(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function palabras(value) {
  const cleaned = limpiarTexto(value);
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).length;
}

function parseArray(value) {
  if (Array.isArray(value)) return value.map((item) => limpiarTexto(item)).filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parseArray(parsed);
    } catch {
      return trimmed.split(',').map((item) => limpiarTexto(item)).filter(Boolean);
    }
  }
  return [];
}

function numeroOpcional(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function textoOpcional(...values) {
  for (const value of values) {
    const text = limpiarTexto(value);
    if (text) return text;
  }
  return '';
}

function extraerFactSheetCalidad(alerta = {}) {
  const factSheet = alerta.fact_sheet || alerta.factSheet || alerta.factSheetJson || alerta.fact_sheet_json || null;
  const status = textoOpcional(
    alerta.fact_sheet_status,
    alerta.factSheetStatus,
    factSheet?.status,
    factSheet?.fact_sheet?.status
  );
  const truthScore = numeroOpcional(
    alerta.truth_score,
    alerta.fact_sheet_truth_score,
    alerta.factSheetTruthScore,
    factSheet?.truth_score,
    factSheet?.fact_sheet?.truth_score
  );
  const riskScore = numeroOpcional(
    alerta.risk_score,
    alerta.fact_sheet_risk_score,
    alerta.factSheetRiskScore,
    factSheet?.risk_score,
    factSheet?.fact_sheet?.risk_score
  );
  const evidenceCoverage = numeroOpcional(
    alerta.evidence_coverage,
    alerta.fact_sheet_evidence_coverage,
    alerta.factSheetEvidenceCoverage,
    factSheet?.evidence_coverage,
    factSheet?.fact_sheet?.evidence_coverage
  );
  const hasFactSheet = Boolean(
    status ||
    truthScore !== null ||
    riskScore !== null ||
    evidenceCoverage !== null ||
    (factSheet && typeof factSheet === 'object')
  );

  return {
    has_fact_sheet: hasFactSheet,
    status: status || null,
    truth_score: truthScore,
    risk_score: riskScore,
    evidence_coverage: evidenceCoverage,
    flags: parseArray(factSheet?.flags || factSheet?.fact_sheet?.flags),
  };
}

function contarPor(items = [], fn) {
  return (Array.isArray(items) ? items : []).reduce((acc, item) => {
    const key = fn(item) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function sumarFlag(acc, flag) {
  acc[flag] = (acc[flag] || 0) + 1;
}

function calidadPorScoreOperativo(score) {
  if (score >= 90) return 'enterprise_ready';
  if (score >= 78) return 'production_ready';
  if (score >= 65) return 'needs_review';
  return 'blocked';
}

function contieneAlguno(textoNormalizado, terms) {
  return terms.some((term) => textoNormalizado.includes(normalizarTextoCalidad(term)));
}

function tituloPareceRawBoletin(titulo) {
  const text = normalizarTextoCalidad(titulo);
  if (!text) return false;
  if (/^(boa|bop|dog|docm|doe|bon|bor|borm|boc|boib|bopv|botha|bog)\b/.test(text) && text.includes('boletin oficial')) return true;
  const markers = [
    'boletin oficial',
    'csv:',
    'v. anuncios',
    'departamento de',
    'numero ',
  ];
  const hits = markers.filter((marker) => text.includes(marker)).length;
  return hits >= 3 || (text.length > 180 && hits >= 2);
}

function detectarExpedienteIndividual(alerta = {}) {
  const text = normalizarTextoCalidad([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen_borrador,
    alerta.resumen,
    alerta.contenido,
  ].filter(Boolean).join('\n'));

  if (!text) return false;

  const individual = contieneAlguno(text, [
    'solicitud de concesion',
    'aprovechamiento de aguas',
    'informacion publica de una solicitud',
    'competencia de proyectos',
    'expediente ',
    'termino municipal de',
    'comisaria de aguas',
    'autorizacion administrativa previa',
    'solicitud de licencia ambiental',
    'licencia ambiental de actividad clasificada',
    'actividad clasificada ganadera',
    'autorizacion ambiental concedida',
    'procedimiento sancionador',
    'expediente de aguas',
  ]);

  const broad = contieneAlguno(text, [
    'convocatoria',
    'extracto',
    'bases reguladoras',
    'subvenciones',
    'ayudas',
    'beneficiarios',
    'normativa',
    'reglamento',
  ]);

  return individual && !broad;
}

function detectarProcesoPersonalPublico(alerta = {}) {
  const text = normalizarTextoCalidad([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen_borrador,
    alerta.resumen,
    alerta.contenido,
  ].filter(Boolean).join('\n'));

  if (!text) return false;
  return contieneAlguno(text, [
    'concurso especifico de meritos',
    'concurso de meritos y capacidades',
    'provision de un puesto',
    'provision de puestos',
    'puesto singular',
    'puesto de trabajo',
    'relacion de puestos de trabajo',
    'personal funcionario',
    'personal laboral',
    'funcionarios de carrera',
    'empleo publico',
    'oferta publica de empleo',
    'bolsa de trabajo',
    'proceso selectivo',
    'oposicion',
  ]);
}

function detectarPescaOMaritimoNoAgrario(alerta = {}) {
  const text = normalizarTextoCalidad([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen_borrador,
    alerta.resumen,
    alerta.contenido,
  ].filter(Boolean).join('\n'));

  if (!text) return false;
  const pescaOMaritimo = contieneAlguno(text, [
    'politica maritima',
    'pesca maritima',
    'sector pesquero',
    'actividad pesquera',
    'flota pesquera',
    'acuicultura',
    'marisqueo',
    'maritimo',
  ]);
  if (!pescaOMaritimo) return false;

  return !contieneAlguno(text, [
    'agrario',
    'agraria',
    'agricola',
    'ganaderia',
    'agricultor',
    'ganadero',
    'explotacion agraria',
    'explotacion ganadera',
    'regadio',
    'regante',
    'pac',
    'fega',
    'sigpac',
  ]);
}

function detectarAdministracionGeneralNoAgraria(alerta = {}) {
  const text = normalizarTextoCalidad([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen_borrador,
    alerta.resumen,
    alerta.contenido,
  ].filter(Boolean).join('\n'));

  if (!text) return false;
  const administrativo = contieneAlguno(text, [
    'beca universitaria',
    'beca de formacion de personal investigador',
    'comision de valoracion de la beca',
    'universidad',
    'notario',
    'registrador',
    'registro de la propiedad',
    'convenio colectivo',
    'urbanismo',
    'planeamiento urbanistico',
    'licencia urbanistica',
  ]);
  if (!administrativo) return false;

  return !contieneAlguno(text, [
    'agrario',
    'agraria',
    'agricola',
    'ganaderia',
    'agricultor',
    'ganadero',
    'explotacion agraria',
    'explotacion ganadera',
    'regadio',
    'regante',
    'camino rural',
    'via pecuaria',
    'monte publico',
    'fega',
    'pac',
    'sigpac',
  ]);
}

function detectarNotificacionIndividual(alerta = {}) {
  const text = normalizarTextoCalidad([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen_borrador,
    alerta.resumen,
    alerta.contenido,
  ].filter(Boolean).join('\n'));

  if (!text) return false;

  const marcasNotificacion = contieneAlguno(text, [
    'notificacion de ',
    'notifica al interesado',
    'notifica a la persona interesada',
    'intentada sin efecto la notificacion',
    'intentada, sin efecto, la notificacion',
    'no ha sido posible la notificacion',
    'podran comparecer',
    'para cuyo conocimiento integro podra comparecer',
    'procedimiento administrativo sancionador',
    'tramite de audiencia relativo a procedimiento',
    'resolucion desfavorable',
    'inactivacion de explotacion',
  ]);

  if (!marcasNotificacion) return false;

  const convocatoriaGeneral = contieneAlguno(text, [
    'convocatoria de ayudas',
    'extracto de la resolucion',
    'bases reguladoras',
    'subvenciones',
    'ayudas para',
    'se aprueba la convocatoria',
  ]);

  return !convocatoriaGeneral;
}

function detectarBecaInvestigacionPersonal(alerta = {}) {
  const text = normalizarTextoCalidad([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen_borrador,
    alerta.resumen,
    alerta.contenido,
  ].filter(Boolean).join('\n'));

  if (!text) return false;
  return contieneAlguno(text, [
    'beca de formacion de personal investigador',
    'comision de valoracion de la beca',
    'entrevista personal de los aspirantes',
    'personal investigador en materia de',
  ]);
}

function detectarBoilerplatePortal(texto) {
  const text = normalizarTextoCalidad(texto);
  if (!text) return false;
  const erroresDocumento = [
    'no se ha podido obener la disposicion solicitada',
    'no se ha podido obtener la disposicion solicitada',
    'no se ha podido obtener el documento solicitado',
    'intentelo mas tarde o vuelva a realizar la busqueda',
  ];
  if (erroresDocumento.some((marca) => text.includes(marca))) return true;
  const marcas = [
    'cargando',
    'datos del documento',
    'descriptores relacionados',
    'autenticidad e integridad',
    'portal juridic',
    'acciones guardar',
    'inicio sede electronica',
    'web institucional',
    'bop del dia',
    'busquedas buscar',
    'boletines historicos',
    'consultar una disposicion',
    'regresar al sumario',
    'disposicion anterior',
    'disposicion siguiente',
    'acceder al pdf',
    'saltar al contenido',
    'busqueda avanzada',
    'verificacion de documentos',
    'recibir avisos de publicacion',
    'buscador bor',
  ];
  return marcas.filter((marca) => text.includes(marca)).length >= 2;
}

function detectarTonoRaro(texto) {
  const text = normalizarTextoCalidad(texto);
  if (!text) return false;
  return contieneAlguno(text, [
    'que tengas un buen dia',
    'tu granja',
    'tus vacas',
    'estimado ',
    'querido ',
    'hola ',
  ]);
}

function restar(issueList, flag, points, detail) {
  issueList.push({
    flag,
    points,
    detail,
  });
  return Number(points || 0);
}

function evaluarCalidadAlerta(alerta = {}, { now = new Date(), staleHours = 24 } = {}) {
  const issues = [];
  const recommendations = [];
  const titulo = limpiarTexto(alerta.titulo);
  const url = limpiarTexto(alerta.url);
  const estado = limpiarTexto(alerta.estado_ia || 'sin_estado');
  const resumenFinal = limpiarTexto(alerta.resumen_final);
  const resumenBorrador = limpiarTexto(alerta.resumen_borrador);
  const resumenLegacy = limpiarTexto(alerta.resumen || alerta.resumenfree);
  const resumenUtil = resumenFinal || resumenBorrador || resumenLegacy;
  const contenido = limpiarTexto(alerta.contenido);
  const provincias = parseArray(alerta.provincias);
  const sectores = parseArray(alerta.sectores);
  const subsectores = parseArray(alerta.subsectores);
  const tiposAlerta = parseArray(alerta.tipos_alerta);
  const factSheet = extraerFactSheetCalidad(alerta);
  const createdAt = alerta.created_at ? new Date(alerta.created_at) : null;
  const ageHours = createdAt && !Number.isNaN(createdAt.getTime())
    ? (now.getTime() - createdAt.getTime()) / (60 * 60 * 1000)
    : null;

  let penalty = 0;

  if (alerta.duplicado_de) {
    penalty += restar(issues, 'duplicada', 45, 'La alerta apunta a otra alerta como duplicado.');
    recommendations.push('No enviarla ni usarla como evidencia principal; usar la original.');
  }

  if (estado === 'descartado') {
    penalty += restar(issues, 'descartada', 40, 'La IA ya marco la alerta como descartada.');
    recommendations.push('Excluirla del digest y del retrieval de MIA salvo auditoria.');
  }

  if (!titulo) {
    penalty += restar(issues, 'sin_titulo', 25, 'No tiene titulo usable.');
  } else {
    if (titulo.length > 240) {
      penalty += restar(issues, 'titulo_demasiado_largo', 8, 'El titulo es demasiado largo para digest y panel.');
      recommendations.push('Extraer un titulo editorial corto desde el contenido oficial.');
    }
    if (tituloPareceRawBoletin(titulo)) {
      penalty += restar(issues, 'titulo_boletin_raw', 12, 'El titulo parece texto bruto del boletin, no un titular editorial.');
      recommendations.push('Crear titulo editorial: organismo + actuacion + territorio.');
    }
  }

  if (!url) {
    penalty += restar(issues, 'sin_url', 15, 'No hay URL fuente.');
  } else if (!/^https?:\/\//i.test(url)) {
    penalty += restar(issues, 'url_invalida', 12, 'La URL no parece HTTP/HTTPS.');
  }

  if (!alerta.fuente) {
    penalty += restar(issues, 'sin_fuente', 7, 'No hay fuente normalizada.');
  }

  if (!alerta.fecha) {
    penalty += restar(issues, 'sin_fecha', 6, 'No hay fecha oficial de la alerta.');
  }

  if (!resumenUtil) {
    penalty += restar(issues, 'sin_resumen_util', 22, 'No hay resumen util para digest ni MIA.');
    recommendations.push('Generar ficha/resumen antes de exponerla a MIA.');
  } else {
    if (palabras(resumenUtil) < 18) {
      penalty += restar(issues, 'resumen_demasiado_corto', 8, 'El resumen tiene poca informacion accionable.');
      recommendations.push('Ampliar resumen con hecho, destinatario, territorio, plazo y accion.');
    }
    if (detectarTonoRaro(resumenUtil)) {
      penalty += restar(issues, 'resumen_tono_raro', 10, 'El resumen contiene tono conversacional impropio de una ficha tecnica.');
      recommendations.push('Regenerar resumen en tono sobrio, sin saludos ni personalizacion.');
    }
    if (detectarBoilerplatePortal(resumenUtil)) {
      penalty += restar(issues, 'resumen_boilerplate_portal', 35, 'El resumen contiene texto de interfaz del portal, no contenido oficial util.');
      recommendations.push('Regenerar la ficha usando contenido limpio del boletin.');
    }
  }

  if (estado === 'listo' && !resumenFinal) {
    penalty += restar(issues, 'listo_sin_resumen_final', 16, 'Esta en listo pero no tiene resumen_final.');
    recommendations.push('No marcar como lista sin ficha final normalizada.');
  }

  if (!contenido && !resumenUtil) {
    penalty += restar(issues, 'sin_contenido_fuente', 12, 'No hay contenido ni resumen para auditar.');
  }

  if (!provincias.length && !alerta.region) {
    penalty += restar(issues, 'sin_territorio', 8, 'No hay region/provincia normalizada.');
  }

  if (!sectores.length && estado !== 'descartado') {
    penalty += restar(issues, 'sin_sector', 10, 'No hay sector normalizado.');
  }

  if (!tiposAlerta.length && estado !== 'descartado') {
    penalty += restar(issues, 'sin_tipo_alerta', 8, 'No hay tipo de alerta normalizado.');
  }

  const taxonomyValidation = alerta.taxonomy_validation || {};
  const topicValidation = taxonomyValidation.topic_validation || {};
  if (
    ['blocked', 'incoherent'].includes(taxonomyValidation.status) ||
    ['blocked', 'incoherent'].includes(topicValidation.status)
  ) {
    penalty += restar(issues, 'taxonomy_conflict', 55, 'La taxonomia conserva una incoherencia sin reparar.');
    recommendations.push('Retener la alerta y revisar su taxonomia antes del matching.');
  }

  if (estado === 'listo' && !sectores.length && !subsectores.length && !tiposAlerta.length) {
    penalty += restar(issues, 'empty_taxonomy_ready', 60, 'La alerta esta lista con taxonomia completamente vacia.');
    recommendations.push('Devolverla a revision; nunca tratar la taxonomia vacia como comodin.');
  }

  if (factSheet.flags.includes('unsupported_taxonomy_tag')) {
    penalty += restar(issues, 'unsupported_taxonomy_tag', 18, 'La ficha detecta etiquetas taxonomicas sin evidencia.');
    recommendations.push('Eliminar las etiquetas no respaldadas o pasar la alerta a revision.');
  }

  if ((alerta.audience_reach?.flags || []).includes('cross_sector_mass_match')) {
    penalty += restar(issues, 'cross_sector_match', 60, 'La audiencia incluye perfiles de un sector incompatible.');
    recommendations.push('Bloquear el envio y revisar barreras sectoriales y taxonomia.');
  }

  if (alerta.require_decision_digest === true && !alerta.decision_digest?.action) {
    penalty += restar(issues, 'decision_digest_missing', 60, 'Falta una decision_digest auditable en una candidata de envio.');
  }

  if (
    (alerta.whatsapp_enviado === true || alerta.sent === true) &&
    alerta.decision_digest?.action === 'review_only'
  ) {
    penalty += restar(issues, 'review_only_sent', 70, 'Una alerta review_only figura como enviada.');
  }

  if (estado !== 'listo' && estado !== 'descartado') {
    penalty += restar(issues, 'ia_no_lista', 12, `Estado IA actual: ${estado || 'sin_estado'}.`);
    if (ageHours !== null && ageHours > staleHours) {
      penalty += restar(issues, 'ia_atascada', 14, `Lleva mas de ${staleHours}h sin llegar a listo/descartado.`);
      recommendations.push('Reprocesar clasificacion/resumen/revision o revisar error de pipeline.');
    }
  }

  if (estado === 'listo' && !alerta.embedding_generated_at) {
    penalty += restar(issues, 'sin_embedding', 8, 'Lista para usuario pero sin embedding registrado.');
    recommendations.push('Generar embedding para que MIA pueda recuperarla en preguntas.');
  }

  if (detectarProcesoPersonalPublico(alerta)) {
    penalty += restar(issues, 'proceso_personal_publico', 55, 'La alerta trata de empleo publico, provision de puestos o concurso de meritos.');
    recommendations.push('Descartarla del pipeline agrario aunque el organismo sea de agricultura.');
  }

  if (detectarPescaOMaritimoNoAgrario(alerta)) {
    penalty += restar(issues, 'pesca_maritimo_no_agrario', 45, 'La alerta trata de pesca, acuicultura o politica maritima sin relacion agraria.');
    recommendations.push('Excluirla del digest agrario.');
  }

  if (detectarAdministracionGeneralNoAgraria(alerta)) {
    penalty += restar(issues, 'administracion_general_no_agraria', 45, 'La alerta es administracion general sin impacto agrario directo.');
    recommendations.push('Excluirla salvo que mencione explotaciones, regadio, PAC o actividad agraria concreta.');
  }

  if (detectarBecaInvestigacionPersonal(alerta)) {
    penalty += restar(issues, 'personal_investigador_beca', 45, 'La alerta trata de becas o seleccion de personal investigador, no de una obligacion o ayuda para explotaciones.');
    recommendations.push('Excluirla del digest agrario salvo producto especifico para investigacion.');
  }

  if (detectarNotificacionIndividual(alerta)) {
    penalty += restar(issues, 'notificacion_individual', 50, 'La alerta parece una notificacion edictal o expediente individual para un interesado concreto.');
    recommendations.push('Excluirla del digest general; solo mostrarla si se coteja contra el titular/expediente del usuario.');
  }

  if (detectarExpedienteIndividual(alerta)) {
    penalty += restar(issues, 'expediente_individual', 10, 'Parece expediente particular, no alerta general de alto valor.');
    recommendations.push('Bajar prioridad o exigir coincidencia territorial/interes muy fuerte antes de enviarla.');
  }

  if (factSheet.has_fact_sheet) {
    if (factSheet.status === 'blocked') {
      penalty += restar(issues, 'fact_sheet_blocked', 45, 'La ficha evidence-first bloquea la alerta.');
      recommendations.push('Excluirla del digest automatico y enviarla solo a revision interna.');
    }

    if (factSheet.truth_score !== null && factSheet.truth_score < 85) {
      penalty += restar(issues, 'truth_score_bajo', 12, `Truth score evidence-first ${factSheet.truth_score}.`);
      recommendations.push('Revisar evidencias de la ficha antes de usarla en digest.');
    }

    if (factSheet.risk_score !== null && factSheet.risk_score > 35) {
      penalty += restar(issues, 'risk_score_alto', 12, `Risk score evidence-first ${factSheet.risk_score}.`);
      recommendations.push('No afirmar plazos, importes o afectacion sin validacion final.');
    }

    if (factSheet.evidence_coverage !== null && factSheet.evidence_coverage < 0.6) {
      penalty += restar(issues, 'evidencia_insuficiente', 14, `Cobertura de evidencia ${factSheet.evidence_coverage}.`);
      recommendations.push('Completar evidencia documental antes de enviarla automaticamente.');
    }
  }

  const flags = issues.map((issue) => issue.flag);
  const score = clamp(100 - penalty);
  const critical = flags.some((flag) => CRITICAL_ALERT_FLAGS.has(flag));
  const factSheetReady = !factSheet.has_fact_sheet || factSheet.status === 'ready_for_digest';
  const readyForDigest = score >= 72 && estado === 'listo' && !critical && factSheetReady;
  const readyForMia = score >= 78 && estado === 'listo' && !critical && Boolean(resumenUtil);

  return {
    id: alerta.id,
    titulo,
    fuente: alerta.fuente || null,
    estado_ia: estado,
    score,
    grade: calidadPorScoreOperativo(score),
    ready_for_digest: readyForDigest,
    ready_for_mia: readyForMia,
    critical,
    flags,
    issues,
    recommendations: [...new Set(recommendations)].slice(0, 6),
    metadata: {
      tiene_resumen_final: Boolean(resumenFinal),
      tiene_embedding: Boolean(alerta.embedding_generated_at),
      provincias_count: provincias.length,
      sectores_count: sectores.length,
      subsectores_count: subsectores.length,
      tipos_alerta_count: tiposAlerta.length,
      age_hours: ageHours === null ? null : redondear(ageHours, 1),
      fact_sheet: factSheet,
    },
  };
}

function construirRecomendacionesAlertas(metrics, flagCounts) {
  const recommendations = [];

  if ((flagCounts.titulo_boletin_raw || 0) > 0) {
    recommendations.push({
      priority: 'alta',
      area: 'titulos',
      title: 'Editorializar titulos brutos de boletin',
      detail: 'Los titulos tipo BOA/BOE con CSV consumen atencion y empeoran el digest. Hay que generar titulares cortos y accionables.',
    });
  }

  if ((flagCounts.listo_sin_resumen_final || 0) > 0 || (flagCounts.sin_resumen_util || 0) > 0) {
    recommendations.push({
      priority: 'alta',
      area: 'resumenes',
      title: 'Bloquear alertas listas sin resumen final',
      detail: 'MIA necesita ficha breve y normalizada para responder y personalizar sin gastar tokens ni inventar.',
    });
  }

  if ((flagCounts.sin_embedding || 0) > 0) {
    recommendations.push({
      priority: 'media',
      area: 'retrieval',
      title: 'Completar embeddings de alertas listas',
      detail: 'Sin embedding, MIA no recupera bien las alertas historicas aunque esten resumidas.',
    });
  }

  if ((flagCounts.expediente_individual || 0) > 0) {
    recommendations.push({
      priority: 'media',
      area: 'relevancia',
      title: 'Reducir ruido de expedientes particulares',
      detail: 'Concesiones o expedientes individuales deben entrar solo si coinciden con zona/interes del usuario.',
    });
  }

  if (metrics.ready_for_mia_rate < 80 && metrics.total_alertas >= 10) {
    recommendations.push({
      priority: 'alta',
      area: 'calidad',
      title: 'Subir porcentaje de alertas utilizables por MIA',
      detail: 'Menos del 80% de las alertas recientes estan listas para retrieval fiable. Conviene corregir pipeline antes de escalar ventas.',
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'baja',
      area: 'calidad',
      title: 'Calidad operativa estable',
      detail: 'No se ven bloqueos importantes en alertas recientes. Revisar muestras manuales para calibrar tono y relevancia.',
    });
  }

  return recommendations;
}

function resumirCalidadAlertas(alertas = [], options = {}) {
  const evaluaciones = (alertas || []).map((alerta) => evaluarCalidadAlerta(alerta, options));
  const flagCounts = {};
  for (const evaluation of evaluaciones) {
    for (const flag of evaluation.flags) sumarFlag(flagCounts, flag);
  }

  const total = evaluaciones.length;
  const listas = evaluaciones.filter((item) => item.estado_ia === 'listo').length;
  const descartadas = evaluaciones.filter((item) => item.estado_ia === 'descartado').length;
  const critical = evaluaciones.filter((item) => item.critical).length;
  const readyDigest = evaluaciones.filter((item) => item.ready_for_digest).length;
  const readyMia = evaluaciones.filter((item) => item.ready_for_mia).length;
  const scoreAvg = total ? redondear(evaluaciones.reduce((sum, item) => sum + item.score, 0) / total, 1) : 0;

  const metrics = {
    total_alertas: total,
    listas,
    descartadas,
    critical,
    ready_for_digest: readyDigest,
    ready_for_mia: readyMia,
    ready_for_digest_rate: porcentaje(readyDigest, total),
    ready_for_mia_rate: porcentaje(readyMia, total),
    score_promedio: scoreAvg,
  };

  const problematicas = [...evaluaciones]
    .filter((item) => item.flags.length > 0)
    .sort((a, b) => a.score - b.score || String(a.titulo || '').localeCompare(String(b.titulo || '')))
    .slice(0, 25)
    .map((item) => ({
      id: item.id,
      titulo: item.titulo,
      fuente: item.fuente,
      estado_ia: item.estado_ia,
      score: item.score,
      grade: item.grade,
      flags: item.flags,
      recommendations: item.recommendations,
    }));

  return {
    score: scoreAvg,
    grade: calidadPorScoreOperativo(scoreAvg),
    metrics,
    breakdown: {
      by_estado_ia: contarPor(evaluaciones, (item) => item.estado_ia),
      by_fuente: contarPor(evaluaciones, (item) => item.fuente),
      flags: flagCounts,
    },
    problematicas,
    recommendations: construirRecomendacionesAlertas(metrics, flagCounts),
  };
}

function evaluarCalidadScraperRuns(runs = [], {
  now = new Date(),
  expectedFreshHours = 36,
  expectedSources = [],
} = {}) {
  const porFuente = new Map();

  for (const run of runs || []) {
    const fuente = run.fuente || run.endpoint || 'desconocida';
    if (!porFuente.has(fuente)) {
      porFuente.set(fuente, {
        fuente,
        runs: 0,
        ok: 0,
        warnings: 0,
        errors: 0,
        nuevas: 0,
        duplicadas: 0,
        errores_reportados: 0,
        relevantes: 0,
        relevantes_null: 0,
        duracion_total_ms: 0,
        ultimo_run_at: null,
        ultimo_ok_at: null,
        ultimo_error: null,
      });
    }

    const item = porFuente.get(fuente);
    item.runs += 1;
    item.nuevas += Number(run.nuevas || 0);
    item.duplicadas += Number(run.duplicadas || 0);
    item.errores_reportados += Number(run.errores || 0);
    if (run.relevantes === null || run.relevantes === undefined) item.relevantes_null += 1;
    else item.relevantes += Number(run.relevantes || 0);
    item.duracion_total_ms += Number(run.duration_ms || 0);

    if (!item.ultimo_run_at || String(run.started_at || '') > String(item.ultimo_run_at || '')) {
      item.ultimo_run_at = run.started_at || null;
    }

    if (run.status === 'ok') {
      item.ok += 1;
      if (!item.ultimo_ok_at || String(run.started_at || '') > String(item.ultimo_ok_at || '')) {
        item.ultimo_ok_at = run.started_at || null;
      }
    } else if (run.status === 'warning') {
      item.warnings += 1;
    } else if (run.status === 'error') {
      item.errors += 1;
      if (!item.ultimo_error) {
        item.ultimo_error = run.error_msg || `HTTP ${run.http_status || 'desconocido'}`;
      }
    }
  }

  for (const fuente of expectedSources || []) {
    const nombre = limpiarTexto(fuente);
    if (!nombre || porFuente.has(nombre)) continue;
    porFuente.set(nombre, {
      fuente: nombre,
      runs: 0,
      ok: 0,
      warnings: 0,
      errors: 0,
      nuevas: 0,
      duplicadas: 0,
      errores_reportados: 0,
      relevantes: 0,
      relevantes_null: 0,
      duracion_total_ms: 0,
      ultimo_run_at: null,
      ultimo_ok_at: null,
      ultimo_error: null,
    });
  }

  const fuentes = [...porFuente.values()].map((item) => {
    const flags = [];
    const recommendations = [];
    let score = 100;
    const totalItems = item.nuevas + item.duplicadas;
    const duplicateRate = porcentaje(item.duplicadas, totalItems);
    const errorRate = porcentaje(item.errors, item.runs);
    const warningRate = porcentaje(item.warnings, item.runs);
    const avgDuration = item.runs ? Math.round(item.duracion_total_ms / item.runs) : 0;
    const lastRun = item.ultimo_run_at ? new Date(item.ultimo_run_at) : null;
    const hoursSinceRun = lastRun && !Number.isNaN(lastRun.getTime())
      ? (now.getTime() - lastRun.getTime()) / (60 * 60 * 1000)
      : null;

    if (item.runs === 0) {
      flags.push('sin_runs');
      score = 30;
      recommendations.push('No hay ejecuciones registradas para esta fuente en la ventana analizada.');
    }
    if (item.ok === 0) {
      flags.push('sin_ok_reciente');
      score -= item.runs === 0 ? 0 : 28;
      recommendations.push('Revisar endpoint, parseo y credenciales: no hay ejecuciones OK.');
    }
    if (item.errors > 0) {
      flags.push('errores_recientes');
      score -= Math.min(24, 8 + item.errors * 4);
      recommendations.push('Revisar ultimo_error y logs de scraper_runs.');
    }
    if (item.errores_reportados > 0) {
      flags.push('errores_en_respuesta');
      score -= Math.min(20, item.errores_reportados * 4);
    }
    if (item.runs >= 2 && totalItems === 0) {
      flags.push('sin_volumen');
      score -= 16;
      recommendations.push('Comprobar si el boletin no publico nada o si el selector dejo de extraer.');
    }
    if (duplicateRate >= 85 && item.duplicadas >= 20) {
      flags.push('duplicados_altos');
      score -= 14;
      recommendations.push('Revisar deduplicacion o ventana de scraping para no gastar ciclo en ruido.');
    }
    if (item.relevantes_null === item.runs && item.runs > 0) {
      flags.push('sin_metrica_relevantes');
      score -= 5;
    }
    if (avgDuration > 180000) {
      flags.push('scraper_lento');
      score -= 8;
    }
    if (hoursSinceRun !== null && hoursSinceRun > expectedFreshHours) {
      flags.push('fuente_desactualizada');
      score -= 14;
      recommendations.push('Confirmar que la fuente entra en el ciclo diario.');
    }

    return {
      fuente: item.fuente,
      score: clamp(score),
      grade: calidadPorScoreOperativo(score),
      flags,
      runs: item.runs,
      ok: item.ok,
      warnings: item.warnings,
      errors: item.errors,
      nuevas: item.nuevas,
      duplicadas: item.duplicadas,
      relevantes: item.relevantes,
      errores_reportados: item.errores_reportados,
      duplicate_rate: duplicateRate,
      error_rate: errorRate,
      warning_rate: warningRate,
      duracion_media_ms: avgDuration,
      ultimo_run_at: item.ultimo_run_at,
      ultimo_ok_at: item.ultimo_ok_at,
      ultimo_error: item.ultimo_error,
      recommendations: [...new Set(recommendations)].slice(0, 5),
    };
  }).sort((a, b) => a.score - b.score || a.fuente.localeCompare(b.fuente));

  const scoreAvg = fuentes.length
    ? redondear(fuentes.reduce((sum, item) => sum + item.score, 0) / fuentes.length, 1)
    : 0;
  const flagCounts = {};
  for (const fuente of fuentes) {
    for (const flag of fuente.flags) sumarFlag(flagCounts, flag);
  }

  return {
    score: scoreAvg,
    grade: calidadPorScoreOperativo(scoreAvg),
    metrics: {
      total_runs: (runs || []).length,
      fuentes: fuentes.length,
      fuentes_con_flags: fuentes.filter((item) => item.flags.length > 0).length,
      total_nuevas: fuentes.reduce((sum, item) => sum + item.nuevas, 0),
      total_duplicadas: fuentes.reduce((sum, item) => sum + item.duplicadas, 0),
      total_errors: fuentes.reduce((sum, item) => sum + item.errors, 0),
    },
    breakdown: {
      flags: flagCounts,
      by_status: contarPor(runs, (item) => item.status),
    },
    fuentes,
  };
}

function evaluarCalidadPipelineRuns(runs = [], { now = new Date(), runningStaleMinutes = 90 } = {}) {
  const stages = [];
  const porStage = new Map();

  for (const run of runs || []) {
    const stage = run.stage || run.endpoint || 'desconocida';
    if (!porStage.has(stage)) {
      porStage.set(stage, {
        stage,
        runs: 0,
        ok: 0,
        warnings: 0,
        errors: 0,
        running: 0,
        procesadas: 0,
        errores_reportados: 0,
        last_run_at: null,
        last_error: null,
        duration_total_ms: 0,
      });
    }

    const item = porStage.get(stage);
    item.runs += 1;
    item.procesadas += Number(run.procesadas || 0);
    item.errores_reportados += Number(run.errores || 0);
    item.duration_total_ms += Number(run.duration_ms || 0);
    if (!item.last_run_at || String(run.started_at || '') > String(item.last_run_at || '')) {
      item.last_run_at = run.started_at || null;
    }
    if (run.status === 'ok') item.ok += 1;
    else if (run.status === 'warning') item.warnings += 1;
    else if (run.status === 'error') {
      item.errors += 1;
      if (!item.last_error) item.last_error = run.error_msg || 'error';
    } else if (run.status === 'running') {
      item.running += 1;
    }
  }

  for (const item of porStage.values()) {
    const flags = [];
    let score = 100;
    const avgDuration = item.runs ? Math.round(item.duration_total_ms / item.runs) : 0;
    if (item.errors > 0) {
      flags.push('pipeline_errors');
      score -= Math.min(28, 10 + item.errors * 6);
    }
    if (item.warnings > 0) {
      flags.push('pipeline_warnings');
      score -= Math.min(14, item.warnings * 4);
    }
    if (item.errores_reportados > 0) {
      flags.push('pipeline_errores_reportados');
      score -= Math.min(18, item.errores_reportados * 3);
    }
    if (item.running > 0) {
      const lastRun = item.last_run_at ? new Date(item.last_run_at) : null;
      const minutes = lastRun && !Number.isNaN(lastRun.getTime())
        ? (now.getTime() - lastRun.getTime()) / (60 * 1000)
        : null;
      if (minutes === null || minutes > runningStaleMinutes) {
        flags.push('pipeline_running_stale');
        score -= 18;
      }
    }

    stages.push({
      stage: item.stage,
      score: clamp(score),
      grade: calidadPorScoreOperativo(score),
      flags,
      runs: item.runs,
      ok: item.ok,
      warnings: item.warnings,
      errors: item.errors,
      running: item.running,
      procesadas: item.procesadas,
      errores_reportados: item.errores_reportados,
      duracion_media_ms: avgDuration,
      last_run_at: item.last_run_at,
      last_error: item.last_error,
    });
  }

  stages.sort((a, b) => a.score - b.score || a.stage.localeCompare(b.stage));

  const scoreAvg = stages.length
    ? redondear(stages.reduce((sum, item) => sum + item.score, 0) / stages.length, 1)
    : 0;
  const flagCounts = {};
  for (const stage of stages) {
    for (const flag of stage.flags) sumarFlag(flagCounts, flag);
  }

  return {
    score: scoreAvg,
    grade: calidadPorScoreOperativo(scoreAvg),
    metrics: {
      total_runs: (runs || []).length,
      stages: stages.length,
      stages_con_flags: stages.filter((item) => item.flags.length > 0).length,
      total_errors: stages.reduce((sum, item) => sum + item.errors, 0),
      total_running: stages.reduce((sum, item) => sum + item.running, 0),
    },
    breakdown: {
      flags: flagCounts,
      by_status: contarPor(runs, (item) => item.status),
    },
    stages,
  };
}

function calcularMetricasCalidadPlan({
  alertas = [],
  digestItems = [],
  candidateDecisions = [],
  reviews = [],
  cutoff = null,
} = {}) {
  const cutoffDate = cutoff ? new Date(cutoff) : null;
  const discarded = alertas.filter((alerta) => alerta.estado_ia === 'descartado');
  const structuredDiscards = discarded.filter((alerta) =>
    Boolean(alerta.discard_reason_code && alerta.discard_reason && alerta.discard_stage) &&
    Number.isFinite(Number(alerta.discard_confidence))
  );
  const readyWithoutTaxonomy = alertas.filter((alerta) =>
    alerta.estado_ia === 'listo' &&
    parseArray(alerta.sectores).length === 0 &&
    parseArray(alerta.subsectores).length === 0 &&
    parseArray(alerta.tipos_alerta).length === 0
  ).length;
  const unsupportedTaxonomyTags = alertas.reduce((sum, alerta) => {
    const sheet = alerta.fact_sheet || alerta.fact_sheet_json || {};
    return sum + parseArray(sheet.unsupported_taxonomy_tags).length;
  }, 0);
  const crossSectorMatchesFromPreview = alertas.filter((alerta) =>
    (alerta.audience_reach?.flags || []).includes('cross_sector_mass_match')
  ).length;
  const crossSectorMatchesFromDecisions = candidateDecisions.filter((decision) => {
    const audit = decision.decision_json || {};
    const trace = audit.match_trace || audit.diagnostico?.match_trace || {};
    const included = decision.action === 'include' || trace.decision === 'include';
    if (!included) return false;
    if ((audit.flags || []).includes('cross_sector_match')) return true;
    return (trace.type_match === 'sanidad_animal' && trace.sector_match === 'agricultura') ||
      (trace.type_match === 'sanidad_vegetal' && trace.sector_match === 'ganaderia');
  }).length;
  const crossSectorMatches = crossSectorMatchesFromDecisions || crossSectorMatchesFromPreview;
  const missingDecisionFromAlerts = alertas.filter((alerta) => {
    if (alerta.estado_ia !== 'listo' || alerta.decision_digest?.action) return false;
    if (!cutoffDate || Number.isNaN(cutoffDate.getTime())) return true;
    const created = new Date(alerta.created_at || 0);
    return !Number.isNaN(created.getTime()) && created >= cutoffDate;
  }).length;
  const missingDecisionFromGate = candidateDecisions.filter((decision) =>
    decision.reason === 'decision_digest_missing' ||
    decision.decision_json?.motivo === 'decision_digest_missing'
  ).length;
  const missingDecision = candidateDecisions.length > 0
    ? missingDecisionFromGate
    : missingDecisionFromAlerts;
  const reviewOnlySent = digestItems.filter((item) =>
    item.sent === true &&
    (item.selection_action === 'review_only' || item.selection_decision?.action === 'review_only')
  ).length;
  const falsePositiveConfirmed = reviews.filter((review) =>
    review.verdict === 'ruido' || review.feedback_category === 'false_positive_confirmed'
  ).length;
  const falseNegativeConfirmed = reviews.filter((review) =>
    review.feedback_category === 'false_negative_confirmed' ||
    (review.expected_action === 'incluir' && ['exclude', 'blocked'].includes(review.decision_json?.action))
  ).length;
  const discardReasonCoverage = discarded.length
    ? porcentaje(structuredDiscards.length, discarded.length)
    : 100;

  return {
    discard_reason_coverage: discardReasonCoverage,
    ready_alerts_without_taxonomy: readyWithoutTaxonomy,
    unsupported_taxonomy_tags: unsupportedTaxonomyTags,
    cross_sector_matches: crossSectorMatches,
    decision_digest_missing: missingDecision,
    review_only_sent: reviewOnlySent,
    false_positive_confirmed: falsePositiveConfirmed,
    false_negative_confirmed: falseNegativeConfirmed,
    objectives: {
      discard_reason_coverage: discardReasonCoverage === 100,
      ready_alerts_without_taxonomy: readyWithoutTaxonomy === 0,
      review_only_sent: reviewOnlySent === 0,
      decision_digest_missing: missingDecision === 0,
    },
  };
}

function construirReporteCalidadOperativa({
  generatedAt = new Date().toISOString(),
  since = null,
  until = null,
  alertas = [],
  scraperRuns = [],
  pipelineRuns = [],
  expectedSources = [],
  availability = {},
  digestItems = [],
  candidateDecisions = [],
  reviews = [],
  decisionDigestCutoff = null,
} = {}) {
  const alertQuality = resumirCalidadAlertas(alertas);
  const scraperQuality = evaluarCalidadScraperRuns(scraperRuns, { expectedSources });
  const pipelineQuality = evaluarCalidadPipelineRuns(pipelineRuns);
  const scoreParts = [
    alertQuality.score ? { value: alertQuality.score, weight: 0.5 } : null,
    scraperQuality.score ? { value: scraperQuality.score, weight: 0.3 } : null,
    pipelineQuality.score ? { value: pipelineQuality.score, weight: 0.2 } : null,
  ].filter(Boolean);
  const score = scoreParts.length
    ? redondear(scoreParts.reduce((sum, item) => sum + item.value * item.weight, 0) / scoreParts.reduce((sum, item) => sum + item.weight, 0), 1)
    : 0;

  const recommendations = [
    ...alertQuality.recommendations,
    ...scraperQuality.fuentes
      .filter((item) => item.flags.length > 0)
      .slice(0, 5)
      .map((item) => ({
        priority: item.score < 65 ? 'alta' : 'media',
        area: 'scrapers',
        title: `Revisar scraper ${item.fuente}`,
        detail: item.flags.join(', '),
      })),
    ...pipelineQuality.stages
      .filter((item) => item.flags.length > 0)
      .slice(0, 5)
      .map((item) => ({
        priority: item.score < 65 ? 'alta' : 'media',
        area: 'pipeline',
        title: `Revisar pipeline ${item.stage}`,
        detail: item.flags.join(', '),
      })),
  ].slice(0, 20);

  return {
    ok: score >= 78 && alertQuality.metrics.critical === 0,
    available: Object.values(availability).every((value) => value !== false),
    generated_at: generatedAt,
    since,
    until,
    score,
    grade: calidadPorScoreOperativo(score),
    availability,
    alertas: alertQuality,
    scrapers: scraperQuality,
    pipeline: pipelineQuality,
    plan_metrics: calcularMetricasCalidadPlan({
      alertas,
      digestItems,
      candidateDecisions,
      reviews,
      cutoff: decisionDigestCutoff,
    }),
    recommendations,
  };
}

async function selectSeguro(supabase, table, select, {
  since = null,
  timeColumn = 'created_at',
  orderColumn = 'created_at',
  limit = 1000,
  fecha = null,
  fechaColumn = null,
} = {}) {
  let query = supabase
    .from(table)
    .select(select)
    .order(orderColumn, { ascending: false })
    .limit(limit);

  if (fecha && (fechaColumn || table === 'alertas')) query = query.eq(fechaColumn || 'fecha', fecha);
  else if (since) query = query.gte(timeColumn, since);

  const { data, error } = await query;
  if (error) throw error;
  return { available: true, data: data || [] };
}

async function generarReporteCalidadOperativaMIA(supabase, {
  days = 7,
  fecha = null,
  limit = 1000,
} = {}) {
  const safeDays = Math.max(1, Math.min(60, Number(days) || 7));
  const safeLimit = Math.max(100, Math.min(5000, Number(limit) || 1000));
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();

  const [alertas, scraperRuns, pipelineRuns, factSheets, candidateDecisions, digestItems, reviews] = await Promise.all([
    selectSeguro(
      supabase,
      'alertas',
      'id, titulo, resumen, resumenfree, resumen_borrador, resumen_final, url, fecha, region, created_at, contenido, provincias, sectores, subsectores, tipos_alerta, fuente, estado_ia, duplicado_de, embedding_generated_at, discard_reason_code, discard_reason, discard_stage, discard_confidence',
      { since, fecha, limit: safeLimit }
    ),
    selectSeguro(
      supabase,
      'scraper_runs',
      'id, fuente, endpoint, fecha_objetivo, started_at, finished_at, duration_ms, status, http_status, nuevas, duplicadas, errores, relevantes, error_msg',
      { since, timeColumn: 'started_at', orderColumn: 'started_at', limit: safeLimit }
    ),
    selectSeguro(
      supabase,
      'pipeline_runs',
      'id, stage, endpoint, fecha_objetivo, started_at, finished_at, duration_ms, status, loops, procesadas, errores, error_msg',
      { since, timeColumn: 'started_at', orderColumn: 'started_at', limit: safeLimit }
    ),
    selectSeguro(
      supabase,
      'alert_fact_sheets',
      'alerta_id, fact_sheet, flags, generated_at',
      { since, timeColumn: 'generated_at', orderColumn: 'generated_at', limit: safeLimit }
    ),
    selectSeguro(
      supabase,
      'digest_candidate_decisions',
      'alerta_id, user_id, fecha, stage, action, reason, decision_json, digest_id, created_at',
      { since, fecha, fechaColumn: 'fecha', limit: safeLimit }
    ),
    selectSeguro(
      supabase,
      'digest_items',
      'alerta_id, selection_action, selection_decision, created_at, digests(enviado)',
      { since, limit: safeLimit }
    ),
    selectSeguro(
      supabase,
      'mia_alert_reviews',
      'alerta_id, verdict, expected_action, expert_verdict, decision_json, reviewed_at',
      { since, timeColumn: 'reviewed_at', orderColumn: 'reviewed_at', limit: safeLimit }
    ),
  ]);

  const factSheetByAlert = new Map();
  for (const row of factSheets.data) {
    if (!factSheetByAlert.has(String(row.alerta_id))) {
      factSheetByAlert.set(String(row.alerta_id), row.fact_sheet || { flags: row.flags || [] });
    }
  }
  const alertasConFactSheet = alertas.data.map((alerta) => ({
    ...alerta,
    fact_sheet: factSheetByAlert.get(String(alerta.id)) || null,
  }));
  const digestItemsConEstado = digestItems.data.map((item) => ({
    ...item,
    sent: item.digests?.enviado === true || item.digests?.[0]?.enviado === true,
  }));

  return construirReporteCalidadOperativa({
    generatedAt: until,
    since: fecha ? null : since,
    until,
    alertas: alertasConFactSheet,
    scraperRuns: scraperRuns.data,
    pipelineRuns: pipelineRuns.data,
    digestItems: digestItemsConEstado,
    candidateDecisions: candidateDecisions.data,
    reviews: reviews.data,
    decisionDigestCutoff: process.env.DIGEST_DECISION_REQUIRED_FROM || '2026-07-21T00:00:00+02:00',
    expectedSources: FUENTES_SCRAPER_ESPERADAS,
    availability: {
      alertas: alertas.available,
      scraper_runs: scraperRuns.available,
      pipeline_runs: pipelineRuns.available,
      alert_fact_sheets: factSheets.available,
      digest_candidate_decisions: candidateDecisions.available,
      digest_items: digestItems.available,
      mia_alert_reviews: reviews.available,
    },
  });
}

module.exports = {
  evaluarCalidadAlerta,
  resumirCalidadAlertas,
  evaluarCalidadScraperRuns,
  evaluarCalidadPipelineRuns,
  calcularMetricasCalidadPlan,
  construirReporteCalidadOperativa,
  generarReporteCalidadOperativaMIA,
  calidadPorScoreOperativo,
  normalizarTextoCalidad,
  FUENTES_SCRAPER_ESPERADAS,
};
