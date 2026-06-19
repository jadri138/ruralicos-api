const assert = require('assert');
const {
  preclassifyAlerta,
  CANDIDATE_LEVEL,
} = require('../src/modules/alertas/clasificacion/alertPreclassifier');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

console.log('\n=== TESTS: alert preclassifier ===\n');

test('ayuda agraria clara -> strong_candidate', () => {
  const result = preclassifyAlerta({
    id: 1,
    titulo: 'Convocatoria de ayudas a la mejora de explotaciones agrarias',
    contenido: 'Se aprueba la convocatoria de subvenciones para la modernizacion de explotaciones agrarias. Bases reguladoras y beneficiarios.',
  });
  assert.strictEqual(result.candidate_level, CANDIDATE_LEVEL.STRONG);
  assert.strictEqual(result.pre_status, 'keep');
  assert(result.pre_score >= 4, `pre_score deberia ser alto, fue ${result.pre_score}`);
});

test('PAC/FEGA -> strong_candidate', () => {
  const result = preclassifyAlerta({
    id: 2,
    titulo: 'Resolucion del FEGA sobre los pagos de la PAC',
    contenido: 'El FEGA publica los importes de la PAC y actualiza el SIGPAC para las ayudas directas a agricultores.',
  });
  assert.strictEqual(result.candidate_level, CANDIDATE_LEVEL.STRONG);
  assert(result.pre_reasons.some((r) => r.tag === 'pac'));
  assert(result.pre_reasons.some((r) => r.tag === 'fega'));
});

test('oposicion -> discard_rule', () => {
  const result = preclassifyAlerta({
    id: 3,
    titulo: 'Convocatoria de oposiciones para cuerpo administrativo',
    contenido: 'Se convoca proceso selectivo de oposicion libre. Tribunal calificador y bolsa de empleo. Empleo publico.',
  });
  assert.strictEqual(result.candidate_level, CANDIDATE_LEVEL.DISCARD);
  assert.strictEqual(result.pre_status, 'discard');
});

test('nombramiento -> discard_rule', () => {
  const result = preclassifyAlerta({
    id: 4,
    titulo: 'Nombramiento de personal funcionario',
    contenido: 'Se nombra a doña Fulana como jefa de servicio. Toma de posesion y cese del anterior titular. Empleo publico.',
  });
  assert.strictEqual(result.candidate_level, CANDIDATE_LEVEL.DISCARD);
});

test('sancion individual -> weak_candidate o discard_rule', () => {
  const result = preclassifyAlerta({
    id: 5,
    titulo: 'Notificacion de expediente sancionador a la persona interesada',
    contenido: 'Intentada sin efecto la notificacion del procedimiento sancionador, se notifica a la persona interesada la resolucion sancionadora.',
  });
  assert(
    [CANDIDATE_LEVEL.WEAK, CANDIDATE_LEVEL.DISCARD].includes(result.candidate_level),
    `esperaba weak o discard, fue ${result.candidate_level}`
  );
});

test('documento sin texto util -> needs_evidence', () => {
  const result = preclassifyAlerta({
    id: 6,
    titulo: '',
    contenido: '',
  });
  assert.strictEqual(result.candidate_level, CANDIDATE_LEVEL.NEEDS_EVIDENCE);
  assert.strictEqual(result.pre_status, 'needs_evidence');
});

test('normativa agraria generica -> needs_ai', () => {
  const result = preclassifyAlerta({
    id: 7,
    titulo: 'Orden por la que se regula la actividad agraria en la comunidad',
    contenido: 'Se establece el marco normativo agrario aplicable a las explotaciones agricolas de la region.',
  });
  assert.strictEqual(result.candidate_level, CANDIDATE_LEVEL.NEEDS_AI);
  assert.strictEqual(result.pre_status, 'review');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
