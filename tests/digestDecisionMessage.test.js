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

// Una alerta sin accion verificada es informacion, no una oportunidad.
function informativeAlert(id = 90) {
  const alerta = approvedAlert(id);
  alerta.personal_decision.message_projection.facts = alerta
    .personal_decision.message_projection.facts.filter((fact) => fact.field !== 'action');
  return alerta;
}

const mixto = renderDecisionDigestMessage({
  user: { first_name: 'Ana' },
  alertas: [informativeAlert(90), approvedAlert(1)],
  fecha: '2026-08-01',
});
assert(
  mixto.message.includes('*Esto pide que hagas algo*'),
  'las oportunidades quedan agrupadas'
);
assert(
  mixto.message.includes('*Esto es solo para que lo sepas*'),
  'la informacion preventiva queda separada'
);
assert(
  mixto.message.indexOf('*Esto pide que hagas algo*') < mixto.message.indexOf('*Esto es solo para que lo sepas*'),
  'primero se muestra lo que requiere accion'
);
assert.deepStrictEqual(
  mixto.alertas.map((alerta) => alerta.id),
  [1, 90],
  'las alertas guardadas siguen el mismo orden que el mensaje'
);
assert(
  mixto.message.indexOf('*1. Ayuda verificada 1*') < mixto.message.indexOf('*2. Ayuda verificada 90*'),
  'la numeracion es correlativa y coincide con el orden mostrado'
);
assert(!/preventiv|accionable|portfolio/i.test(mixto.message), 'no aparece terminologia interna');

// Si todas son del mismo tipo, los titulos de seccion sobran.
const soloAccion = renderDecisionDigestMessage({
  alertas: [approvedAlert(1), approvedAlert(2)],
  fecha: '2026-08-01',
});
assert(!soloAccion.message.includes('*Esto pide que hagas algo*'));
assert(!soloAccion.message.includes('*Esto es solo para que lo sepas*'));

// El recorte por longitud no puede dejar un titulo de seccion sin contenido.
const recortado = renderDecisionDigestMessage({
  user: { first_name: 'Ana' },
  alertas: [approvedAlert(1), approvedAlert(2), informativeAlert(90)],
  fecha: '2026-08-01',
  maxChars: 800,
});
assert(recortado.message.length <= 800, 'el mensaje respeta el limite con titulos incluidos');
for (const titulo of ['*Esto pide que hagas algo*', '*Esto es solo para que lo sepas*']) {
  if (!recortado.message.includes(titulo)) continue;
  const resto = recortado.message.slice(recortado.message.indexOf(titulo) + titulo.length);
  assert(/\*\d+\./.test(resto), `el titulo ${titulo} conserva al menos una alerta debajo`);
}

console.log('OK: el mensaje del digest usa solo hechos autorizados y longitud acotada.');
