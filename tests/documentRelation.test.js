const assert = require('assert');
const {
  DOCUMENT_RELATION,
  clasificarRelacionDocumental,
  esRelacionDuplicada,
} = require('../src/modules/alertas/intelligence/documentRelation');

const dogc = {
  fuente: 'DOGC',
  fecha: '2026-07-10',
  organismo: 'Parlament de Catalunya',
  titulo: 'Ley 5/2026, de medidas para las explotaciones agrarias',
  contenido: 'Texto autonómico de la Ley 5/2026 sobre explotaciones agrarias.',
};

const boe = {
  fuente: 'BOE',
  fecha: '2026-07-18',
  organismo: 'Parlament de Catalunya',
  titulo: 'Ley 5/2026, de medidas para las explotaciones agrarias',
  contenido: 'Publicación estatal de la Ley 5/2026 sobre explotaciones agrarias.',
};

assert.strictEqual(
  clasificarRelacionDocumental(dogc, boe).relation,
  DOCUMENT_RELATION.CROSS_SOURCE_REPUBLICATION
);

assert.strictEqual(
  clasificarRelacionDocumental(dogc, {
    fuente: 'BOE',
    titulo: 'Corrección de errores de la Ley 5/2026, de medidas para las explotaciones agrarias',
    contenido: 'Corrección de errores de la Ley 5/2026.',
  }).relation,
  DOCUMENT_RELATION.LEGAL_CORRECTION
);

assert.strictEqual(
  clasificarRelacionDocumental(dogc, {
    fuente: 'DOGC',
    titulo: 'Modificación de la Ley 5/2026, de medidas para las explotaciones agrarias',
    contenido: 'Se modifica la Ley 5/2026 y se da nueva redacción a su artículo 4.',
  }).relation,
  DOCUMENT_RELATION.LEGAL_UPDATE
);

const duplicate = clasificarRelacionDocumental(
  { fuente: 'BOE', titulo: 'Orden 1/2026', contenido: 'Mismo contenido legal' },
  { fuente: 'BOE', titulo: 'Orden 1/2026', contenido: 'Mismo contenido legal' }
);
assert.strictEqual(duplicate.relation, DOCUMENT_RELATION.EXACT_DUPLICATE);
assert.strictEqual(esRelacionDuplicada(duplicate.relation), true);
assert.strictEqual(esRelacionDuplicada(DOCUMENT_RELATION.LEGAL_CORRECTION), false);

assert.strictEqual(
  clasificarRelacionDocumental(
    { fuente: 'BOE', organismo: 'Ministerio de Agricultura', titulo: 'Resolucion sobre ayudas agrarias 2026' },
    { fuente: 'BOE', organismo: 'Ministerio de Agricultura', titulo: 'Resolucion sobre ayudas agrarias 2026 - nuevo plazo' }
  ).relation,
  DOCUMENT_RELATION.SAME_SUBJECT_NEW_PROCEDURE
);

assert.strictEqual(
  clasificarRelacionDocumental(
    { fuente: 'BOE', organismo: 'Ministerio de Agricultura', titulo: 'Resolucion sobre ayudas agrarias 2026' },
    { fuente: 'BOE', organismo: 'Ministerio de Cultura', titulo: 'Resolucion sobre ayudas agrarias 2026 - nuevo plazo' }
  ).relation,
  DOCUMENT_RELATION.NEW
);

console.log('OK: relaciones documentales distinguen duplicados, republicaciones, correcciones y actualizaciones');
