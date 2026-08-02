const assert = require('assert');
const {
  renderDecisionAlertBlock,
  renderDecisionDigestMessage,
} = require('../src/modules/digest/decisionMessage');

function approvedAlert(id = 1) {
  return {
    id,
    personal_decision: {
      message_projection: {
        allowed: true,
        user_reason: 'Coincide con tu actividad en Aragón.',
        facts: [
          { field: 'title', value: `Ayuda verificada ${id}` },
          { field: 'summary', value: 'Convocatoria para modernizar explotaciones.' },
          { field: 'beneficiaries', value: 'Titulares de explotaciones agrarias' },
          { field: 'territory', value: 'Aragón' },
          { field: 'action', value: 'Revisar los requisitos y presentar la solicitud' },
          { field: 'deadline', value: '2026-09-15' },
          { field: 'official_url', value: `https://example.test/oficial/${id}` },
        ],
      },
    },
  };
}

const block = renderDecisionAlertBlock(approvedAlert(), 0);
assert(block.includes('Por qué te puede interesar'));
assert(block.includes('Plazo oficial: 2026-09-15'));
assert(block.includes('Fuente oficial: https://example.test/oficial/1'));
assert(!/juez|score|evidence|HOLD_FOR_EVIDENCE/i.test(block));

const rendered = renderDecisionDigestMessage({
  user: { first_name: 'Ana' },
  alertas: [approvedAlert(1), approvedAlert(2)],
  fecha: '2026-08-01',
  maxChars: 1600,
});
assert.strictEqual(rendered.alertas.length, 2);
assert(rendered.message.length <= 1600);
assert(rendered.message.includes('*Tus alertas rurales del 01/08/2026*'));
assert(!/responde|ninguna/i.test(rendered.message), 'el digest no añade una pregunta universal');

const unsafe = renderDecisionDigestMessage({
  alertas: [{ personal_decision: { message_projection: { allowed: true, facts: [] } } }],
  fecha: '2026-08-01',
});
assert.strictEqual(unsafe.message, null);

console.log('OK: el mensaje del digest usa solo hechos autorizados y longitud acotada.');
