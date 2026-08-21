process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  decidirMensajeMIA,
  interpretarValoracionGlobalDigestMIA,
  esReferenciaAlDigestMIA,
  debeBuscarFueraDelDigestMIA,
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
      resumen_usado: 'Curso por teleformacion de bienestar animal con 35 plazas y solicitud antes del inicio.',
      resumen_final: [
        'FICHA_IA',
        'TIPO: cursos_formacion',
        'RESUMEN_DIGEST: Curso por teleformacion dirigido a titulares de explotaciones ganaderas.',
        'ACCION: revisar inscripcion',
      ].join('\n'),
      sectores: ['ganaderia'],
      tipos_alerta: ['cursos_formacion'],
      contenido: 'Curso de 20 horas, del 15 de septiembre al 15 de octubre. Maximo 35 asistentes. Solicitudes por orden de recepcion.',
      url: 'https://example.com/curso-bienestar',
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

  let alertaRecibidaPorLLM = null;
  const explicacionLLM = await decidirMensajeMIA({
    mensajeUsuario: 'explicame el curso de bienestar animal',
    usuario: { id: 5, contexto_narrativo: 'Perfil ganadero en Aragon.' },
    conversacionActiva: { id: 8, tipo: 'feedback_digest', digest_id: 81 },
    digest: { ...digestDoble, mensaje: 'Hoy te enviamos dos cursos.' },
    alertasDelDigest: alertasDobles,
    responderAlertaFn: async ({ alerta }) => {
      alertaRecibidaPorLLM = alerta;
      return {
        reply: 'Es un curso online de 20 horas para obtener el certificado de bienestar animal. Hay 35 plazas.',
        answer_source: 'digest_context_ai',
        answer_guardrails: ['exact_digest_alert', 'official_content_only'],
      };
    },
  });
  assert.strictEqual(alertaRecibidaPorLLM.id, 901);
  assert(alertaRecibidaPorLLM.contenido.includes('35 asistentes'));
  assert.strictEqual(explicacionLLM.knowledge_context.answer_source, 'digest_context_ai');
  assert(explicacionLLM.reply_action.texto.includes('20 horas'));

  let focoRepregunta = null;
  const repreguntaLLM = await decidirMensajeMIA({
    mensajeUsuario: 'Y cuantas plazas hay y como me apunto?',
    usuario: { id: 5 },
    conversacionActiva: { id: 8, tipo: 'feedback_digest', digest_id: 81 },
    digest: digestDoble,
    alertasDelDigest: alertasDobles,
    contextoReciente: [{
      direccion: 'ruralicos',
      texto: 'Es un curso online para obtener el certificado de bienestar animal.',
      alerta_ids: [901],
    }],
    responderAlertaFn: async ({ alerta, contextoReciente }) => {
      focoRepregunta = { alerta, contextoReciente };
      return {
        reply: 'Hay 35 plazas y las solicitudes se atienden por orden de recepcion.',
        answer_source: 'digest_context_ai',
        answer_guardrails: ['exact_digest_alert'],
      };
    },
  });
  assert.strictEqual(focoRepregunta.alerta.id, 901);
  assert.strictEqual(focoRepregunta.contextoReciente[0].alerta_ids[0], 901);
  assert.deepStrictEqual(repreguntaLLM.knowledge_context.matches.map((item) => item.id), [901]);
  assert(repreguntaLLM.reply_action.texto.includes('35 plazas'));

  const contextoCurso = [{
    direccion: 'ruralicos',
    texto: 'Es un curso online para obtener el certificado de bienestar animal.',
    alerta_ids: [901],
  }];
  assert.strictEqual(
    debeBuscarFueraDelDigestMIA({
      texto: 'cuando salio la PAC?',
      contextoReciente: contextoCurso,
      alertas: alertasDobles,
    }),
    true,
    'Una pregunta sobre otro tema sale del contexto del curso y busca en alertas'
  );
  assert.strictEqual(
    debeBuscarFueraDelDigestMIA({
      texto: 'pero de otro dia?',
      contextoReciente: contextoCurso,
      alertas: alertasDobles,
    }),
    true,
    'Una peticion de otro dia sale del digest actual'
  );
  assert.strictEqual(
    debeBuscarFueraDelDigestMIA({
      texto: 'quitando esta alerta, que ayudas hay abiertas?',
      contextoReciente: contextoCurso,
      alertas: alertasDobles,
    }),
    true,
    'Una exclusion explicita de la alerta activa fuerza la busqueda global'
  );
  assert.strictEqual(
    debeBuscarFueraDelDigestMIA({
      texto: 'cuando salio este curso?',
      contextoReciente: contextoCurso,
      alertas: alertasDobles,
    }),
    false,
    'Una referencia explicita al curso conserva la respuesta exacta del digest'
  );

  const referenciaAmbigua = await decidirMensajeMIA({
    mensajeUsuario: 'el curso de hoy',
    usuario: { id: 5 },
    conversacionActiva: { id: 8, tipo: 'feedback_digest', digest_id: 81 },
    digest: digestDoble,
    alertasDelDigest: alertasDobles,
  });
  assert.strictEqual(referenciaAmbigua.knowledge_context.answer_source, 'digest_context_clarification');
  assert.strictEqual(referenciaAmbigua.knowledge_context.handled, true);
  assert.strictEqual(esReferenciaAlDigestMIA('la primera', [{
    direccion: 'ruralicos',
    texto: 'He encontrado dos alertas sobre la PAC. Dime cual quieres revisar.',
    answer_source: 'ai_grounded',
  }]), false, 'No interpreta una seleccion de la busqueda global como referencia al digest');
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
