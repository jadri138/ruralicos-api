const {
  construirMemoriasEstructuradas,
  hashDetalle,
  inferirPolarity,
  inferirTopic,
} = require('../src/modules/mia/structuredMemory');

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

console.log('\n=== TESTS: mia structured memory ===\n');

assert(inferirTopic('Le interesa la PAC') === 'pac', 'Detecta topic PAC');
assert(inferirTopic('Le interesan ayudas para tractores') === 'ayudas_maquinaria', 'Detecta topic maquinaria');
assert(inferirPolarity('interes_detectado') === 'positive', 'Detecta memoria positiva');
assert(inferirPolarity('desinteres_detectado') === 'negative', 'Detecta memoria negativa');
assert(hashDetalle('  PAC  ') === hashDetalle('pac'), 'Hash de memoria normaliza texto equivalente');

const rows = construirMemoriasEstructuradas({
  userId: 141,
  digestId: 1097,
  inboundId: 72,
  organizationId: 12,
  textoOriginal: 'Me gustaria recibir avisos sobre la PAC y ayudas para tractores',
  decision: {
    version: 'mia_decision_v1',
    intent: 'actualizar_preferencias',
    confidence: 0.9,
    summary: 'Preferencia futura',
    memory_actions: [
      { tipo: 'interes_detectado', contenido: 'Le interesa la PAC', peso_inicial: 0.9 },
      { tipo: 'interes_detectado', contenido: 'Le interesan ayudas para tractores', peso_inicial: 0.8 },
    ],
  },
});

assert(rows.length === 2, 'Construye memoria estructurada desde memory_actions');
assert(rows[0].user_id === 141, 'Conserva user_id');
assert(rows[0].organization_id === 12, 'Propaga organization_id a memoria estructurada');
assert(rows[0].source === 'whatsapp', 'Marca source whatsapp por defecto');
assert(rows.some((row) => row.topic === 'pac'), 'Incluye topic pac');
assert(rows.some((row) => row.topic === 'ayudas_maquinaria'), 'Incluye topic ayudas maquinaria');
assert(rows.every((row) => row.polarity === 'positive'), 'Marca polaridad positiva');
assert(rows.every((row) => row.evidence.includes('PAC')), 'Conserva evidencia original');
assert(rows.every((row) => row.detail_hash), 'Genera hash de deduplicacion');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
