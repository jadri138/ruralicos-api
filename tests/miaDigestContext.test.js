process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  decidirMensajeMIA,
  interpretarValoracionGlobalDigestMIA,
} = require('../src/modules/mia/decisionCore');
const { evaluarPoliticaDecisionMIA } = require('../src/modules/mia/policy');

async function main() {
  const digest = { id: 80 };
  const alertasDelDigest = [{
    id: 900,
    titulo: 'Ayudas para modernizar explotaciones agrarias',
    resumen_final: 'La convocatoria financia inversiones y fija el plazo de solicitud.',
  }];

  const explicacion = await decidirMensajeMIA({
    mensajeUsuario: 'Explícame de qué va',
    usuario: { id: 5 },
    conversacionActiva: { id: 7, tipo: 'feedback_digest', digest_id: 80 },
    digest,
    alertasDelDigest,
  });

  assert.strictEqual(explicacion.intent, 'pregunta_usuario');
  assert.strictEqual(explicacion.knowledge_context.answer_source, 'digest_context');
  assert(explicacion.reply_action.texto.includes('financia inversiones'));

  const explicacionConPolitica = evaluarPoliticaDecisionMIA({
    texto: 'Explícame de qué va',
    decision: explicacion,
    digest,
    alertasDelDigest,
  });
  assert.strictEqual(explicacionConPolitica.policy.outcome, 'auto_answer');
  assert.strictEqual(explicacionConPolitica.policy.requires_agent, false);

  const feedback = await decidirMensajeMIA({
    mensajeUsuario: 'Bien',
    usuario: { id: 5 },
    conversacionActiva: { id: 7, tipo: 'feedback_digest', digest_id: 80 },
    digest,
    alertasDelDigest,
  });
  assert.strictEqual(feedback.intent, 'feedback_digest');
  assert.deepStrictEqual(feedback.feedback_actions.map((item) => item.valor), [1]);
  assert.strictEqual(
    interpretarValoracionGlobalDigestMIA('Bien', { totalItems: 2 }),
    null,
    'Bien no debe valorar varias alertas a la vez'
  );

  const timeoutConContexto = evaluarPoliticaDecisionMIA({
    texto: '¿Cuándo termina el plazo de esta alerta?',
    digest,
    alertasDelDigest,
    decision: {
      intent: 'pregunta_usuario',
      confidence: 0.8,
      risk_flags: ['knowledge_lookup_failed'],
      feedback_actions: [],
      memory_actions: [],
      reply_action: null,
      knowledge_context: {
        answered: false,
        needs_agent: true,
        error: 'statement timeout',
        digest_id: 80,
      },
    },
  });
  assert.strictEqual(timeoutConContexto.policy.requires_agent, true);
  assert.strictEqual(timeoutConContexto.policy.should_reply, true);
  assert(timeoutConContexto.reply_action.texto.length > 0);

  console.log('OK: MIA prioriza el digest, entiende feedback corto y no silencia timeouts contextuales');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
