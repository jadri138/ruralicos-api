const assert = require('assert');
const corpus = require('./fixtures/shadow-v2/corpus.json');
const {
  SEND_GATE_VERSION,
  evidenceFragments,
  evaluateSendGate,
} = require('../src/modules/alertas/shadow-v2/sendGate');

function snapshot(overrides = {}) {
  return {
    title: 'Convocatoria rural abierta',
    official_url: 'https://example.test/oficial',
    official_content: 'Los titulares de explotaciones agrarias podran solicitar la ayuda.',
    ...overrides,
  };
}

function card(overrides = {}) {
  return {
    relevant: true,
    actionable: true,
    status: 'active',
    content_type: 'aid',
    action: 'solicitar la ayuda',
    deadline: null,
    evidence: ['titulares de explotaciones agrarias'],
    ...overrides,
  };
}

assert.strictEqual(SEND_GATE_VERSION, 'shadow-v2-send-gate-1');

for (const item of corpus.accepted_by_ai1) {
  const result = evaluateSendGate({
    officialSnapshot: snapshot({
      title: item.title,
      official_content: item.official_content,
    }),
    card: item.ai1,
    workflowDate: '2026-08-12',
  });
  assert.strictEqual(result.allowed, true, `${item.title}: ${result.reasons.join(', ')}`);
}

const convenio = evaluateSendGate({
  officialSnapshot: snapshot({
    title: 'Resolucion por la que se publica el Convenio entre MAPA, ICO y SAECA',
    official_content: [
      'Se publica el Convenio entre MAPA, ICO y SAECA.',
      'La finalidad es la gestion de la linea de financiacion para explotaciones agrarias.',
    ].join(' '),
  }),
  card: card({
    content_type: 'information',
    action: 'modificar o gestionar la linea mediante el convenio',
    evidence: ['Se publica el Convenio entre MAPA, ICO y SAECA'],
  }),
});
assert.strictEqual(convenio.allowed, false);
assert(convenio.reasons.includes('administrative_agreement'));
assert(convenio.reasons.includes('user_action_not_supported'));

const grantedAuthorization = evaluateSendGate({
  officialSnapshot: snapshot({
    title: 'Resolucion por la que se otorgan las autorizaciones administrativas de construccion',
    official_content: [
      'Se otorga autorizacion administrativa a la empresa solicitante.',
      'El peticionario debera solicitar la autorizacion de explotacion definitiva.',
    ].join(' '),
  }),
  card: card({
    content_type: 'information',
    action: 'solicitar autorizaciones y seguir el proceso',
    evidence: ['El peticionario debera solicitar la autorizacion de explotacion definitiva'],
  }),
});
assert.strictEqual(grantedAuthorization.allowed, false);
assert(grantedAuthorization.reasons.includes('granted_authorization'));

const completedAward = evaluateSendGate({
  officialSnapshot: snapshot({
    title: 'Resolucion por la que se concede la ayuda destinada a actividades de voluntariado',
    official_content: 'Se concede la ayuda a las entidades incluidas en el anexo.',
  }),
  card: card({
    action: 'consultar la ayuda concedida',
    evidence: ['Se concede la ayuda a las entidades incluidas'],
  }),
});
assert.strictEqual(completedAward.allowed, false);
assert(completedAward.reasons.includes('completed_award'));

const resolved = evaluateSendGate({
  officialSnapshot: snapshot({
    title: 'Resolucion por la que se resuelve favorablemente la modificacion de una DOP',
    official_content: 'Contra la resolucion se puede interponer recurso de alzada.',
  }),
  card: card({
    content_type: 'information',
    action: 'interponer recurso de alzada',
    evidence: ['se puede interponer recurso de alzada'],
  }),
});
assert.strictEqual(resolved.allowed, false);
assert(resolved.reasons.includes('resolved_procedure'));

const course = evaluateSendGate({
  officialSnapshot: snapshot({
    title: 'Curso de bienestar animal en explotaciones ganaderas',
    official_content: [
      'Curso de bienestar animal en explotaciones ganaderas.',
      'Solicitudes: dirigidas a la entidad organizadora.',
      'Plazo de presentacion hasta la fecha previa al inicio.',
    ].join(' '),
  }),
  card: card({
    content_type: 'opportunity',
    action: 'Solicitar plaza en el curso',
    evidence: ['"Curso de bienestar animal en explotaciones ganaderas","Solicitudes: dirigidas a la entidad organizadora"'],
  }),
});
assert.strictEqual(course.allowed, true, course.reasons.join(', '));
assert(course.diagnostics.literal_evidence_count > 0);

const insurance = evaluateSendGate({
  officialSnapshot: snapshot({
    title: 'Orden del seguro de explotaciones de frutales',
    official_content: 'El agricultor que lo suscriba debera asegurar todas las producciones de la misma clase.',
  }),
  card: card({
    content_type: 'information',
    action: 'Revisar las condiciones y suscribir el seguro',
    evidence: ['El agricultor que lo suscriba debera asegurar todas las producciones'],
  }),
});
assert.strictEqual(insurance.allowed, true, insurance.reasons.join(', '));

const nonLiteral = evaluateSendGate({
  officialSnapshot: snapshot(),
  card: card({ evidence: ['frase inventada que no figura en el documento'] }),
});
assert.strictEqual(nonLiteral.allowed, false);
assert(nonLiteral.reasons.includes('literal_evidence_missing'));

const genericAction = evaluateSendGate({
  officialSnapshot: snapshot(),
  card: card({ action: 'informar sobre la publicacion' }),
});
assert.strictEqual(genericAction.allowed, false);
assert(genericAction.reasons.includes('user_action_not_supported'));

const expired = evaluateSendGate({
  officialSnapshot: snapshot(),
  card: card({ deadline: '2026-08-11' }),
  workflowDate: '2026-08-12',
});
assert.strictEqual(expired.allowed, false);
assert(expired.reasons.includes('deadline_expired'));

assert(evidenceFragments('"Curso ganadero","Solicitudes abiertas"').includes('solicitudes abiertas'));

console.log('OK: gate V2 exige evidencia y accion real y bloquea documentos administrativos cerrados');
