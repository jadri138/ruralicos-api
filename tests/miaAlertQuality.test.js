const {
  evaluarCalidadAlerta,
  resumirCalidadAlertas,
  evaluarCalidadScraperRuns,
  evaluarCalidadPipelineRuns,
  construirReporteCalidadOperativa,
} = require('../src/mia/alertQuality');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

console.log('\n=== TESTS: mia alert quality ===\n');

const now = new Date('2026-05-23T10:00:00Z');

const goodAlert = {
  id: 1,
  titulo: 'Convocatoria de ayudas PAC para modernizacion de explotaciones agrarias en Castilla-La Mancha',
  resumen_final: 'Convocatoria de ayudas dirigida a explotaciones agrarias de Castilla-La Mancha para modernizar maquinaria, inversiones productivas y mejoras vinculadas a actividad agricola profesional.',
  url: 'https://example.com/boletin/1',
  fecha: '2026-05-23',
  region: 'Castilla-La Mancha',
  created_at: '2026-05-23T08:00:00Z',
  provincias: ['Toledo'],
  sectores: ['agricultura'],
  subsectores: ['cereal'],
  tipos_alerta: ['ayudas_subvenciones'],
  fuente: 'DOCM',
  estado_ia: 'listo',
  embedding_generated_at: '2026-05-23T08:20:00Z',
};

const goodEval = evaluarCalidadAlerta(goodAlert, { now });
assert(goodEval.score >= 90, 'Alerta completa recibe score alto');
assert(goodEval.ready_for_digest === true, 'Alerta completa queda lista para digest');
assert(goodEval.ready_for_mia === true, 'Alerta completa queda lista para retrieval MIA');

const rawBadAlert = {
  id: 2,
  titulo: 'BOA Aragon - BOLETIN OFICIAL DE ARAGON 22 de mayo de 2026 Numero 96 csv: BOA20260522033 V. Anuncios b) Otros anuncios DEPARTAMENTO DE AGRICULTURA',
  resumen: 'Aviso corto.',
  url: '',
  fecha: '2026-05-22',
  created_at: '2026-05-22T08:00:00Z',
  provincias: [],
  sectores: [],
  tipos_alerta: [],
  fuente: 'BOA',
  estado_ia: 'listo',
};

const rawEval = evaluarCalidadAlerta(rawBadAlert, { now });
assert(rawEval.score < 70, 'Alerta con titulo bruto y sin ficha baja el score');
assert(rawEval.flags.includes('titulo_boletin_raw'), 'Detecta titulo bruto de boletin');
assert(rawEval.flags.includes('listo_sin_resumen_final'), 'Detecta listo sin resumen_final');
assert(rawEval.flags.includes('sin_url'), 'Detecta falta de URL');
assert(rawEval.flags.includes('sin_embedding'), 'Detecta falta de embedding en alerta lista');

const staleAlert = evaluarCalidadAlerta({
  ...goodAlert,
  id: 3,
  estado_ia: 'pendiente_resumir',
  created_at: '2026-05-21T08:00:00Z',
}, { now, staleHours: 24 });

assert(staleAlert.flags.includes('ia_no_lista'), 'Detecta alerta aun no lista');
assert(staleAlert.flags.includes('ia_atascada'), 'Detecta alerta atascada en pipeline IA');

const individualAlert = evaluarCalidadAlerta({
  ...goodAlert,
  id: 4,
  titulo: 'Anuncio de la Comisaria de Aguas sobre solicitud de concesion de aprovechamiento de aguas en termino municipal de Cella. Expediente 2025-A-12.',
  resumen_final: 'Solicitud particular de concesion de aguas para un aprovechamiento concreto en un termino municipal, sometida a informacion publica durante el plazo oficial.',
  tipos_alerta: ['agua_infraestructuras'],
}, { now });

assert(individualAlert.flags.includes('expediente_individual'), 'Detecta expedientes particulares de bajo valor general');

const publicEmploymentAlert = evaluarCalidadAlerta({
  ...goodAlert,
  id: 5,
  titulo: 'Resolucion ARP/1587/2026, de convocatoria de concurso especifico de meritos y capacidades para la provision de un puesto singular',
  resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nHECHO: concurso especifico de meritos y capacidades para la provision de un puesto singular\nRESUMEN_DIGEST: El boletin publica un concurso de meritos para cubrir un puesto singular de la administracion.',
  contenido: 'Convocatoria de concurso especifico de meritos y capacidades para la provision de un puesto singular. Personal funcionario.',
  sectores: ['mixto'],
  tipos_alerta: ['ayudas_subvenciones'],
}, { now });

assert(publicEmploymentAlert.flags.includes('proceso_personal_publico'), 'Detecta concursos de meritos/provision de puestos como no aptos para digest');
assert(publicEmploymentAlert.critical === true, 'Marca empleo publico como critico para bloquear digest');

const boilerplateAlert = evaluarCalidadAlerta({
  ...goodAlert,
  id: 6,
  resumen_final: 'Cargando... Datos del documento Descriptores relacionados Autenticidad e integridad Portal Juridic de Catalunya Acciones Guardar.',
}, { now });

assert(boilerplateAlert.flags.includes('resumen_boilerplate_portal'), 'Detecta resumen contaminado por texto de portal');
assert(boilerplateAlert.critical === true, 'Bloquea resumen contaminado por boilerplate de portal');

const alertSummary = resumirCalidadAlertas([goodAlert, rawBadAlert], { now });
assert(alertSummary.metrics.total_alertas === 2, 'Resume total de alertas');
assert(alertSummary.metrics.ready_for_mia === 1, 'Cuenta alertas listas para MIA');
assert(alertSummary.problematicas.some((item) => item.id === 2), 'Incluye alertas problematicas');

const scraperQuality = evaluarCalidadScraperRuns([
  { fuente: 'BOA', started_at: '2026-05-23T08:00:00Z', status: 'ok', nuevas: 0, duplicadas: 0, errores: 0, relevantes: 0, duration_ms: 1000 },
  { fuente: 'BOA', started_at: '2026-05-23T07:00:00Z', status: 'ok', nuevas: 0, duplicadas: 0, errores: 0, relevantes: 0, duration_ms: 1200 },
  { fuente: 'BOE', started_at: '2026-05-23T08:30:00Z', status: 'error', nuevas: 0, duplicadas: 0, errores: 1, relevantes: null, error_msg: 'timeout', duration_ms: 2000 },
  { fuente: 'BOCM', started_at: '2026-05-23T08:40:00Z', status: 'ok', nuevas: 1, duplicadas: 30, errores: 0, relevantes: 1, duration_ms: 2000 },
], { now });

const boa = scraperQuality.fuentes.find((item) => item.fuente === 'BOA');
const boe = scraperQuality.fuentes.find((item) => item.fuente === 'BOE');
const bocm = scraperQuality.fuentes.find((item) => item.fuente === 'BOCM');
assert(boa.flags.includes('sin_volumen'), 'Detecta scraper sin volumen tras varias ejecuciones');
assert(boe.flags.includes('sin_ok_reciente'), 'Detecta fuente sin OK reciente');
assert(boe.flags.includes('errores_recientes'), 'Detecta errores recientes de scraper');
assert(bocm.flags.includes('duplicados_altos'), 'Detecta duplicados altos');

const missingSourceQuality = evaluarCalidadScraperRuns([], {
  now,
  expectedSources: ['BOE'],
});
assert(missingSourceQuality.fuentes[0].flags.includes('sin_runs'), 'Detecta fuentes esperadas sin ejecuciones');

const pipelineQuality = evaluarCalidadPipelineRuns([
  { stage: 'clasificar', started_at: '2026-05-23T07:00:00Z', status: 'running', procesadas: 0, errores: 0, duration_ms: 0 },
  { stage: 'resumir', started_at: '2026-05-23T08:00:00Z', status: 'error', procesadas: 3, errores: 1, error_msg: 'IA fallo', duration_ms: 3000 },
], { now, runningStaleMinutes: 90 });

assert(pipelineQuality.stages.some((item) => item.flags.includes('pipeline_running_stale')), 'Detecta pipeline running atascado');
assert(pipelineQuality.stages.some((item) => item.flags.includes('pipeline_errors')), 'Detecta errores de pipeline');

const fullReport = construirReporteCalidadOperativa({
  generatedAt: now.toISOString(),
  alertas: [goodAlert, rawBadAlert],
  scraperRuns: [{ fuente: 'BOE', started_at: '2026-05-23T08:30:00Z', status: 'error', error_msg: 'timeout' }],
  pipelineRuns: [{ stage: 'resumir', started_at: '2026-05-23T08:00:00Z', status: 'error', errores: 1 }],
  availability: { alertas: true, scraper_runs: true, pipeline_runs: true },
});

assert(fullReport.score < 90, 'Reporte global penaliza problemas de datos');
assert(fullReport.recommendations.length > 0, 'Reporte global genera recomendaciones');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
