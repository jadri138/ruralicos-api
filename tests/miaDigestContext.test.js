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

  const digestDoble = { id: 81 };
  const alertasDobles = [
    {
      id: 901,
      titulo: 'Curso de bienestar animal para ganaderos',
      resumen_final: [
        'FICHA_IA',
        'TIPO: cursos_formacion',
        'RESUMEN_DIGEST: Curso por teleformacion dirigido a titulares de explotaciones ganaderas.',
        'ACCION: revisar inscripcion',
      ].join('\n'),
      sectores: ['ganaderia'],
      tipos_alerta: ['cursos_formacion'],
    },
    {
      id: 902,
      titulo: 'Curso basico de productos fitosanitarios',
      resumen_final: [
        'FICHA_IA',
        'TIPO: cursos_formacion',
        'RESUMEN_DIGEST: Formacion presencial en Ejea del 14 al 18 de septiembre.',
        'ACCION: revisar inscripcion',
      ].join('\n'),
      sectores: ['agricultura'],
      tipos_alerta: ['cursos_formacion'],
    },
  ];

  const resumenCompleto = await decidirMensajeMIA({
    mensajeUsuario: 'Explícame de qué va',
    usuario: { id: 5 },
    conversacionActiva: { id: 8, tipo: 'feedback_digest', digest_id: 81 },
    digest: digestDoble,
    alertasDelDigest: alertasDobles,
  });
  assert.strictEqual(resumenCompleto.knowledge_context.answer_source, 'digest_context');
  assert.strictEqual(resumenCompleto.knowledge_context.matches.length, 2);
  assert(resumenCompleto.reply_action.texto.includes('1. Curso de bienestar animal'));
  assert(resumenCompleto.reply_action.texto.includes('2. Curso basico de productos fitosanitarios'));

  const seguimientoConcreto = await decidirMensajeMIA({
    mensajeUsuario: 'el anuncio de hoy del curso de bienestar animal que me has mandado',
    usuario: { id: 5 },
    conversacionActiva: { id: 8, tipo: 'feedback_digest', digest_id: 81 },
    digest: digestDoble,
    alertasDelDigest: alertasDobles,
  });
  assert.strictEqual(seguimientoConcreto.knowledge_context.answer_source, 'digest_context');
  assert.deepStrictEqual(
    seguimientoConcreto.knowledge_context.matches.map((item) => item.id),
    [901]
  );
  assert(seguimientoConcreto.reply_action.texto.includes('teleformacion'));
  assert(!seguimientoConcreto.reply_action.texto.includes('TIPO:'));

  const referenciaAmbigua = await decidirMensajeMIA({
    mensajeUsuario: 'el curso de hoy',
    usuario: { id: 5 },
    conversacionActiva: { id: 8, tipo: 'feedback_digest', digest_id: 81 },
    digest: digestDoble,
    alertasDelDigest: alertasDobles,
  });
  assert.strictEqual(referenciaAmbigua.knowledge_context.answer_source, 'digest_context_clarification');
  assert.strictEqual(referenciaAmbigua.knowledge_context.handled, true);
  const ambiguaConPolitica = evaluarPoliticaDecisionMIA({
    texto: 'el curso de hoy',
    decision: referenciaAmbigua,
    digest: digestDoble,
    alertasDelDigest: alertasDobles,
  });
  assert.strictEqual(ambiguaConPolitica.policy.outcome, 'ask_clarification');
  assert.strictEqual(ambiguaConPolitica.policy.requires_agent, false);

  const seguimientoConHistorial = evaluarPoliticaDecisionMIA({
    texto: 'Y donde se hace?',
    digest: digestDoble,
    alertasDelDigest: alertasDobles,
    decision: {
      intent: 'pregunta_usuario',
      confidence: 0.86,
      risk_flags: [],
      feedback_actions: [],
      memory_actions: [],
      reply_action: { canal: 'whatsapp', texto: 'El curso es por teleformacion.' },
      knowledge_context: {
        handled: true,
        answered: true,
        needs_agent: false,
        answer_source: 'digest_context_conversation',
        digest_id: 81,
      },
    },
  });
  assert.strictEqual(seguimientoConHistorial.policy.outcome, 'auto_answer');
  assert.strictEqual(seguimientoConHistorial.policy.requires_agent, false);

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

  console.log('OK: MIA prioriza el digest completo, resuelve referencias y no silencia timeouts contextuales');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
