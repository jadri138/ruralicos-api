const {
  construirPerfilOperativoMIA,
  aplicarPerfilOperativoAUsuario,
  ordenarAlertasConPerfilOperativoMIA,
  puntuarAlertaConPerfilOperativoMIA,
  extraerExclusiones,
} = require('../src/modules/mia/userProfile');

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

console.log('\n=== TESTS: mia user profile ===\n');

const user = {
  id: 141,
  subscription: 'agricultor',
  preferences: {
    perfil: 'agricultor',
    provincias: ['Extremadura'],
    sectores: ['agricultura'],
    subsectores: ['cereal'],
    tipos_alerta: { ayudas: true, cursos: false },
  },
  preferencias_extra: 'Quiero PAC y tractores. No me interesa vino ni cursos.',
  contexto_narrativo: 'Usuario interesado en ayudas agrarias.',
};

const profile = construirPerfilOperativoMIA({
  user,
  interestRows: [
    { tag: 'sector:agricultura', score: 5 },
    { tag: 'tema:tractor', score: 8 },
    { tag: 'tema:agua', score: -4 },
  ],
  structuredMemories: [
    {
      memory_type: 'interes_detectado',
      topic: 'pac',
      detail: 'Le interesa la PAC',
      polarity: 'positive',
      confidence: 0.9,
      duplicate_count: 1,
      last_seen_at: new Date().toISOString(),
    },
    {
      memory_type: 'desinteres_detectado',
      topic: 'agua_riego',
      detail: 'No le interesan concesiones de agua',
      polarity: 'negative',
      confidence: 0.8,
      duplicate_count: 0,
      last_seen_at: new Date().toISOString(),
    },
  ],
  legacyMemories: [
    { tipo: 'interes_detectado', contenido: 'Le interesan ayudas para tractores', peso_inicial: 0.8, created_at: new Date().toISOString() },
  ],
});

assert(profile.version === 'mia_user_profile_v1', 'Construye perfil con version estable');
assert(profile.declared.provincias.includes('Extremadura'), 'Conserva zonas declaradas');
assert(profile.hard_filters.exclusiones_texto.includes('vino'), 'Extrae exclusiones de texto libre');
assert(profile.interests.some((item) => item.topic === 'pac'), 'Incluye PAC como interes aprendido');
assert(profile.dislikes.some((item) => item.topic === 'agua_riego'), 'Incluye agua/riego como senal negativa');
assert(profile.prompt_block.includes('PERFIL OPERATIVO MIA'), 'Genera bloque compacto para prompts');

const userEnriquecido = aplicarPerfilOperativoAUsuario(user, profile);
assert(userEnriquecido.contexto_narrativo.includes('PERFIL OPERATIVO MIA'), 'Anade perfil operativo al contexto narrativo');
assert(userEnriquecido.mia_operational_profile.version === profile.version, 'Adjunta perfil operativo al usuario');

const alertaTractores = {
  id: 1,
  titulo: 'Ayudas para tractores y maquinaria agricola',
  resumen_final: 'Convocatoria para modernizacion de explotaciones.',
  sectores: ['agricultura'],
  provincias: ['Extremadura'],
  tipos_alerta: ['ayudas'],
};

const alertaAgua = {
  id: 2,
  titulo: 'Concesion de aguas para regadio',
  resumen_final: 'Expediente de concesion de aguas.',
  sectores: ['agricultura'],
  provincias: ['Extremadura'],
};

const alertaVino = {
  id: 3,
  titulo: 'Curso de vino y cata',
  resumen_final: 'Formacion sobre vino.',
  sectores: ['agricultura'],
};

const scoreTractores = puntuarAlertaConPerfilOperativoMIA(alertaTractores, profile);
const scoreAgua = puntuarAlertaConPerfilOperativoMIA(alertaAgua, profile);
const scoreVino = puntuarAlertaConPerfilOperativoMIA(alertaVino, profile);

assert(scoreTractores.score > scoreAgua.score, 'Prioriza alerta alineada con intereses');
assert(scoreAgua.reasons.some((reason) => reason.includes('dislike:agua_riego')), 'Explica penalizacion por desinteres');
assert(scoreVino.excluded === true, 'Marca exclusiones duras por texto libre');

const ordenadas = ordenarAlertasConPerfilOperativoMIA([alertaAgua, alertaVino, alertaTractores], profile);
assert(ordenadas.length === 2, 'Filtra exclusiones duras al ordenar');
assert(ordenadas[0].id === alertaTractores.id, 'Ordena primero la alerta mas alineada');
assert(extraerExclusiones('No quiero porcino ni cursos').includes('porcino'), 'Extrae exclusiones con no quiero');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
