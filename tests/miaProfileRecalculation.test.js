const {
  textoMemorias,
  ajustarContextoNarrativoPorPerfil,
} = require('../src/modules/aprendizaje/miaProfile');

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

console.log('\n=== TESTS: mia profile recalculation ===\n');

const texto = textoMemorias(
  [
    { tipo: 'mensaje_libre', contenido: 'Quiere avisos sobre PAC' },
    { tipo: 'feedback_positivo', contenido: 'No debe entrar en texto libre' },
  ],
  [
    {
      memory_type: 'interes_detectado',
      topic: 'ayudas_maquinaria',
      polarity: 'positive',
      detail: 'Le interesan ayudas para tractores',
    },
    {
      memory_type: 'desinteres_detectado',
      topic: 'agua_riego',
      polarity: 'negative',
      detail: 'No quiere expedientes individuales de agua',
    },
  ]
);

assert(texto.includes('[mensaje_libre] Quiere avisos sobre PAC'), 'Incluye memoria legacy textual');
assert(!texto.includes('feedback_positivo'), 'Excluye feedback legacy crudo del texto narrativo');
assert(texto.includes('[interes_detectado/ayudas_maquinaria/positive]'), 'Incluye memoria estructurada positiva');
assert(texto.includes('[desinteres_detectado/agua_riego/negative]'), 'Incluye memoria estructurada negativa');

const contexto = ajustarContextoNarrativoPorPerfil({
  preferences: { perfil: 'ganadero', sectores: ['ganaderia'] },
}, 'Es un agricultor y ganadero interesado en ayudas.');
assert(contexto.includes('perfil ganadero'), 'Ajusta narrativa a perfil declarado');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
