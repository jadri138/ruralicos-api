const {
  construirPerfilOperativoMIA,
  cargarPerfilOperativoMIA,
  aplicarPerfilOperativoAUsuario,
  mergeAtomicMemories,
  ordenarAlertasConPerfilOperativoMIA,
  puntuarAlertaConPerfilOperativoMIA,
  extraerExclusiones,
} = require('../src/modules/mia/userProfile');
const { buildDecisionProfile } = require('../src/modules/alertas/decision');

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
assert(profile.declared.taxonomia.conceptos.includes('pac'), 'Extrae taxonomia del texto libre declarado');
assert(profile.interests.some((item) => item.topic === 'pac'), 'Incluye PAC como interes aprendido');
assert(profile.interests.some((item) => item.topic === 'cereal'), 'Convierte subsectores declarados en intereses operativos');
assert(profile.dislikes.some((item) => item.topic === 'agua_riego'), 'Incluye agua/riego como senal negativa');
assert(profile.prompt_block.includes('PERFIL OPERATIVO MIA'), 'Genera bloque compacto para prompts');
assert(profile.interest_profile.pesos['tema:tractor'] === 8, 'Reutiliza los pesos originales sin otra consulta');
assert(profile.interest_profile.resumen.includes('tema:tractor (+8)'), 'Reutiliza el resumen de aprendizaje');
assert(
  profile.interest_profile.resumen.indexOf('tema:tractor (+8)') <
    profile.interest_profile.resumen.indexOf('sector:agricultura (+5)'),
  'Ordena el resumen aprendido por intensidad, no por fecha de lectura',
);

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

const alertaTaxonomyTags = {
  id: 4,
  titulo: 'Aviso breve',
  resumen_final: 'Publican un tramite breve.',
  taxonomy_tags: ['concepto:pac', 'concepto:maquinaria_agricola'],
};

const scoreTractores = puntuarAlertaConPerfilOperativoMIA(alertaTractores, profile);
const scoreAgua = puntuarAlertaConPerfilOperativoMIA(alertaAgua, profile);
const scoreVino = puntuarAlertaConPerfilOperativoMIA(alertaVino, profile);
const scoreTaxonomyTags = puntuarAlertaConPerfilOperativoMIA(alertaTaxonomyTags, profile);

assert(scoreTractores.score > scoreAgua.score, 'Prioriza alerta alineada con intereses');
assert(scoreAgua.reasons.some((reason) => reason.includes('dislike:agua_riego')), 'Explica penalizacion por desinteres');
assert(scoreVino.excluded === true, 'Marca exclusiones duras por texto libre');
assert(scoreTaxonomyTags.score > 0, 'Usa taxonomy_tags para puntuar aunque el texto sea corto');

const ordenadas = ordenarAlertasConPerfilOperativoMIA([alertaAgua, alertaVino, alertaTractores], profile);
assert(ordenadas.length === 2, 'Filtra exclusiones duras al ordenar');
assert(ordenadas[0].id === alertaTractores.id, 'Ordena primero la alerta mas alineada');
assert(extraerExclusiones('No quiero porcino ni cursos').includes('porcino'), 'Extrae exclusiones con no quiero');

const sparseProfile = construirPerfilOperativoMIA({
  user: {
    id: 200,
    preferences: {
      perfil: 'agricultor',
      provincias: ['Huesca'],
      sectores: ['agricultura'],
      subsectores: ['cereal'],
      tipos_alerta: { plazos: true },
    },
    preferencias_extra: 'Me interesa PAC y maquinaria agricola. No quiero licitaciones.',
  },
});
const sparseScore = puntuarAlertaConPerfilOperativoMIA({
  titulo: 'Ayudas PAC con plazo para maquinaria agricola',
  resumen_final: 'Convocatoria con plazo de solicitud para tractores.',
  sectores: ['agricultura'],
  subsectores: ['cereal'],
  tipos_alerta: ['plazos'],
}, sparseProfile);
assert(sparseScore.score > 2, 'Perfil sin memoria aprende de preferencias declaradas y texto libre');
assert(sparseProfile.hard_filters.exclusiones_texto.some((item) => /licitacion/.test(item)), 'Taxonomia convierte exclusiones declaradas en filtro duro');

const conflictedProfile = construirPerfilOperativoMIA({
  user: {
    id: 201,
    preferences: {
      provincias: ['Huesca'],
      sectores: ['agricultura'],
      subsectores: [],
      tipos_alerta: {},
    },
  },
  structuredMemories: [
    {
      memory_type: 'interes_detectado',
      topic: 'agua_riego',
      detail: 'Le interesa el regadio',
      polarity: 'positive',
      confidence: 0.9,
      last_seen_at: new Date().toISOString(),
    },
    {
      memory_type: 'desinteres_detectado',
      topic: 'agua_riego',
      detail: 'No quiere avisos de agua',
      polarity: 'negative',
      confidence: 0.9,
      last_seen_at: new Date().toISOString(),
    },
  ],
});
assert(conflictedProfile.uncertain_topics.some((item) => item.topic === 'agua_riego'), 'Detecta preferencias aprendidas contradictorias');
assert(!conflictedProfile.interests.some((item) => item.topic === 'agua_riego'), 'No recomienda usando un interes contradictorio');
assert(!conflictedProfile.dislikes.some((item) => item.topic === 'agua_riego'), 'No excluye usando un desinteres contradictorio');
assert(conflictedProfile.prompt_block.includes('No usarlas para recomendar ni excluir'), 'Explica a MIA como tratar preferencias contradictorias');

const declaredConflict = construirPerfilOperativoMIA({
  user: {
    id: 202,
    preferences: {
      provincias: ['Huesca'],
      sectores: ['agricultura'],
      subsectores: ['cereal'],
      tipos_alerta: {},
    },
  },
  structuredMemories: [
    {
      memory_type: 'desinteres_detectado',
      topic: 'cereal',
      detail: 'No quiere cereal',
      polarity: 'negative',
      confidence: 1,
      duplicate_count: 5,
      last_seen_at: new Date().toISOString(),
    },
  ],
});
assert(!declaredConflict.dislikes.some((item) => item.topic === 'cereal'), 'Una senal aprendida no convierte una preferencia declarada en exclusion');
assert(declaredConflict.uncertain_topics.some((item) => item.topic === 'cereal'), 'Marca para confirmar el conflicto con una preferencia declarada');

function crearSupabaseMemorias(seed = {}) {
  return {
    from(table) {
      const filters = [];
      let sort = null;
      const query = {
        select() { return query; },
        eq(column, value) {
          filters.push((row) => row[column] === value);
          return query;
        },
        in(column, values) {
          filters.push((row) => values.includes(row[column]));
          return query;
        },
        order(column, options = {}) {
          sort = { column, ascending: options.ascending !== false };
          return query;
        },
        limit(value) {
          let rows = (seed[table] || []).filter((row) => filters.every((filter) => filter(row)));
          if (sort) {
            const direction = sort.ascending ? 1 : -1;
            rows = [...rows].sort((left, right) => (
              String(left[sort.column] || '').localeCompare(String(right[sort.column] || '')) * direction
            ));
          }
          return Promise.resolve({ data: rows.slice(0, Number(value)), error: null });
        },
      };
      return query;
    },
  };
}

async function comprobarCargaDurable() {
  const explicita = {
    id: 1,
    user_id: 301,
    memory_key: 'explicit-old-exclusion',
    tipo: 'desinteres_detectado',
    contenido: 'No quiero cursos',
    scope_type: 'topic',
    scope_value: 'formacion',
    polarity: 'negative',
    source: 'response',
    strength: 1,
    confidence: 1,
    status: 'active',
    created_at: '2026-07-01T08:00:00.000Z',
    last_seen_at: '2026-07-01T08:00:00.000Z',
  };
  const debiles = Array.from({ length: 121 }, (_, index) => ({
    id: index + 10,
    user_id: 301,
    memory_key: `click-${index + 1}`,
    tipo: 'feedback_positivo',
    contenido: `Clic débil ${index + 1}`,
    scope_type: 'alert',
    scope_value: String(index + 1000),
    polarity: 'positive',
    source: 'click',
    strength: 0.2,
    confidence: 0.5,
    status: 'active',
    created_at: `2026-08-01T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
    last_seen_at: `2026-08-01T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
  }));
  const loaded = await cargarPerfilOperativoMIA(
    crearSupabaseMemorias({
      user_interest_profile: [],
      user_memory: [explicita, ...debiles],
      mia_structured_memory: [],
    }),
    301,
    {
      user: {
        id: 301,
        subscription: 'agricultor',
        preferences: { provincias: ['Huesca'], sectores: ['agricultura'] },
      },
      limit: 120,
    }
  );

  assert(
    loaded.atomic_memories.some((memory) => memory.memory_key === explicita.memory_key),
    'Conserva una exclusión explícita aunque quede detrás de más de 120 señales débiles'
  );
  assert(
    mergeAtomicMemories([explicita], [explicita]).length === 1,
    'Deduplica una memoria presente en las lecturas reciente y explícita'
  );

  const decisionProfile = buildDecisionProfile({
    user: { id: 301, preferences: { provincias: ['Huesca'], sectores: ['agricultura'] } },
    memories: loaded.atomic_memories,
    now: '2026-08-02T10:00:00.000Z',
    pseudonymSalt: 'test-durable-memory',
  });
  assert(
    decisionProfile.memories.negative.some((memory) => memory.key === 'formacion'),
    'La exclusión explícita durable llega al perfil canónico de decisión'
  );
}

comprobarCargaDurable()
  .then(() => {
    console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
