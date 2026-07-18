const assert = require('assert');
const {
  crearPrefiltroRural,
} = require('../src/modules/boletines/scrapers/shared/ruralFilter');

const decidir = crearPrefiltroRural();

function comprobarDecision(texto, action) {
  const decision = decidir(texto);
  assert.deepStrictEqual(
    Object.keys(decision).sort(),
    ['action', 'negativeSignals', 'positiveSignals', 'reasonCode'].sort()
  );
  assert.strictEqual(decision.action, action, texto);
  assert(Array.isArray(decision.positiveSignals));
  assert(Array.isArray(decision.negativeSignals));
  assert.strictEqual(typeof decision.reasonCode, 'string');
  return decision;
}

const forestal = comprobarDecision(
  'Ayuntamiento de X. Aprobación inicial del instrumento de gestión forestal',
  'review'
);
assert(forestal.positiveSignals.includes('forest'));
assert(forestal.negativeSignals.includes('ayuntamiento'));

const ganadera = comprobarDecision(
  'Diputación provincial. Subvención para explotaciones ganaderas extensivas',
  'review'
);
assert(ganadera.positiveSignals.includes('ganader'));
assert(ganadera.negativeSignals.includes('diputacion'));

comprobarDecision(
  'Ayuntamiento de X. Convocatoria de una bolsa de empleo temporal',
  'discard'
);

const investigacion = comprobarDecision(
  'Universidad pública. Proyecto de investigación agraria aplicada al regadío',
  'review'
);
assert(investigacion.positiveSignals.includes('agrari'));
assert(investigacion.negativeSignals.includes('universidad'));

comprobarDecision(
  'Universidad pública. Convocatoria de becas de carácter general para estudiantes',
  'discard'
);

comprobarDecision(
  'Resolución de la Consejería sobre sanidad animal y bienestar ganadero',
  'review'
);

comprobarDecision(
  'Subvenciones exclusivamente deportivas para clubes de baloncesto',
  'discard'
);

const desconocido = comprobarDecision(
  'Anuncio sin materia suficiente para decidir',
  'review'
);
assert.strictEqual(desconocido.reasonCode, 'insufficient_signals');

const falsoPac = comprobarDecision(
  'Resolución sobre ordenación del espacio universitario',
  'review'
);
assert(!falsoPac.positiveSignals.includes('pac'), 'PAC no debe coincidir dentro de espacio');

const filtroConVid = crearPrefiltroRural({ incluir: ['vid'] });
assert(
  !filtroConVid('Regulación de una actividad universitaria').positiveSignals.includes('vid'),
  'vid no debe coincidir dentro de actividad'
);
assert.strictEqual(filtroConVid('Medidas para el cultivo de la vid').action, 'pass');

console.log('\nResultados ruralRoutePrefilter: 11 casos aprobados');
