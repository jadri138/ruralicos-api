const assert = require('assert');
const { prepararAlertasFinalesDigest } = require('../src/modules/digest/digest.service');

const [alerta] = prepararAlertasFinalesDigest([
  {
    id: 91,
    titulo: 'Ayuda para inversiones ganaderas',
    url: 'https://example.test/oficial/91',
    sectores: ['ganaderia'],
    provincias: ['Huesca'],
    fact_sheet: {
      status: 'ready_for_digest',
      truth_score: 0.93,
      risk_score: 0.08,
      evidence_coverage: 0.9,
      flags: [],
      accion_codigo: { valor: 'solicitar' },
      application_deadline: { valor: '2026-09-18' },
      resumen_estructurado: {
        beneficiarios: { valor: 'Explotaciones ganaderas' },
      },
    },
  },
], { provincias: ['Huesca'], sectores: ['ganaderia'] }, { fecha: '2026-08-01' });

assert(alerta.contexto_mia_digest.fact_sheet, 'la ficha validada debe llegar al contexto del mensaje');
assert.strictEqual(alerta.contexto_mia_digest.fact_sheet.status, 'ready_for_digest');
assert.strictEqual(
  alerta.contexto_mia_digest.fact_sheet.legal_dates.application_deadline,
  '2026-09-18'
);
assert.strictEqual(alerta.contexto_mia_digest.fact_sheet.action_code, 'solicitar');

console.log('OK: el mensaje recibe la proyeccion segura de la ficha validada');
