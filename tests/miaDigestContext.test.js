process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  decidirMensajeMIA,
  interpretarValoracionGlobalDigestMIA,
} = require('../src/modules/mia/decisionCore');
const { evaluarPoliticaDecisionMIA } = require('../src/modules/mia/policy');

async function main() {
  const digest = { id: 81 };
  const alertasDelDigest = [
    {
      id: 901,
      titulo: 'Curso de bienestar animal para ganaderos',
      resumen_final: 'Curso online de 20 horas con 35 plazas.',
      contenido: 'Solicitudes por orden de recepcion.',
      url: 'https://example.com/bienestar',
    },
    {
      id: 902,
      titulo: 'Curso basico de productos fitosanitarios',
      resumen_final: 'Formacion presencial del 14 al 18 de septiembre.',
      url: 'https://example.com/fitosanitarios',
    },
  ];
  const interpretarPregunta = async ({ mensajeUsuario }) => ({
    feedbacks: [],
    memoria: [{ tipo: 'pregunta_usuario', contenido: mensajeUsuario, peso_inicial: 0.3 }],
    requiere_respuesta: false,
    respuesta: '',
    intencion: 'pregunta',
    resumen_para_log: 'Pregunta comprendida por la IA',
  });

  const preguntaDigest = await decidirMensajeMIA({
    mensajeUsuario: 'Explicame el curso de bienestar animal',
    usuario: { id: 5 },
    conversacionActiva: { id: 8, tipo: 'feedback_digest', digest_id: 81 },
    digest,
    alertasDelDigest,
    interpretarMensajeFn: interpretarPregunta,
  });
  assert.strictEqual(preguntaDigest.intent, 'pregunta_usuario');
  assert.strictEqual(preguntaDigest.reply_action, null);
  assert.strictEqual(preguntaDigest.memory_actions[0].tipo, 'pregunta_usuario');
  assert.strictEqual(preguntaDigest.memory_actions[0].peso_inicial, 0.3);
  assert.notStrictEqual(preguntaDigest.knowledge_context?.handled, true);

  const repregunta = await decidirMensajeMIA({
    mensajeUsuario: 'Y cuantas plazas hay y como me apunto?',
    usuario: { id: 5 },
    conversacionActiva: { id: 8, tipo: 'feedback_digest', digest_id: 81 },
    digest,
    alertasDelDigest,
    contextoReciente: [{
      direccion: 'ruralicos',
      texto: 'Es un curso online para obtener el certificado.',
      alerta_ids: [901],
    }],
    interpretarMensajeFn: interpretarPregunta,
  });
  assert.strictEqual(repregunta.intent, 'pregunta_usuario');
  assert.strictEqual(repregunta.reply_action, null);
  assert.notStrictEqual(repregunta.knowledge_context?.handled, true);

  const feedbackLenguajeLibre = await decidirMensajeMIA({
    mensajeUsuario: 'La segunda muy interesante',
    usuario: { id: 5 },
    digest,
    alertasDelDigest,
    interpretarMensajeFn: async () => ({
      feedbacks: [{ item_numero: 2, valor: 1, confianza: 'alta', razon: 'Interes explicito' }],
      memoria: [],
      requiere_respuesta: false,
      respuesta: '',
      intencion: 'feedback',
      resumen_para_log: 'La IA valora positivamente la segunda alerta',
    }),
  });
  assert.strictEqual(feedbackLenguajeLibre.intent, 'feedback_digest');
  assert.strictEqual(feedbackLenguajeLibre.feedback_actions[0].item_numero, 2);
  const feedbackConAcuse = evaluarPoliticaDecisionMIA({
    texto: 'La segunda muy interesante',
    digest,
    alertasDelDigest,
    decision: feedbackLenguajeLibre,
  });
  assert.strictEqual(feedbackConAcuse.policy.outcome, 'record_feedback_with_reply');
  assert(feedbackConAcuse.reply_action.texto.includes('tendre mas en cuenta'));

  const decisionAgente = evaluarPoliticaDecisionMIA({
    texto: 'Explicame el curso de bienestar animal',
    digest,
    alertasDelDigest,
    decision: {
      ...preguntaDigest,
      confidence: 0.96,
      reply_action: {
        canal: 'whatsapp',
        texto: 'Es un curso online de 20 horas y tiene 35 plazas. [E1]',
      },
      knowledge_context: {
        handled: true,
        answered: true,
        needs_agent: false,
        evidence_level: 'alta',
        tipo_pregunta: 'requisitos',
        answer_source: 'mia_conversation_agent_digest',
        digest_id: 81,
        matches: [{ id: 901, url: 'https://example.com/bienestar' }],
        grounded_evidences: [{ ref: 'E1', id: 901 }],
      },
    },
  });
  assert.strictEqual(decisionAgente.policy.outcome, 'auto_answer');
  assert.strictEqual(decisionAgente.policy.requires_agent, false);

  const feedback = await decidirMensajeMIA({
    mensajeUsuario: 'Bien',
    usuario: { id: 5 },
    conversacionActiva: { id: 8, tipo: 'feedback_digest', digest_id: 81 },
    digest,
    alertasDelDigest,
    interpretarMensajeFn: interpretarPregunta,
  });
  assert.strictEqual(feedback.intent, 'trivial');
  assert.deepStrictEqual(feedback.feedback_actions, []);
  assert.strictEqual(
    interpretarValoracionGlobalDigestMIA('Bien', { totalItems: 2 }),
    null,
    'Bien no debe valorar varias alertas a la vez'
  );

  console.log('OK: las preguntas del digest usan el agente unico y conservan el feedback determinista');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
