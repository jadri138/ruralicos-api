const {
  prepararEvidenciasMIA,
  limpiarRespuestaGroundedMIA,
  validarRespuestaGroundedMIA,
  construirRespuestaFallbackGroundedMIA,
  generarRespuestaGroundedMIA,
  generarRespuestaAlertaDigestMIA,
} = require('../src/modules/mia/groundedAnswer');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

console.log('\n=== TESTS: mia grounded answer ===\n');

const matches = [{
  id: 8064,
  titulo: 'Ayudas para maquinaria agricola y tractores',
  snippet: 'Convocatoria dirigida a explotaciones agrarias para modernizar maquinaria.',
  fecha: '2026-05-22',
  url: 'https://example.com/ayudas',
  score: 12,
  matching_terms: ['tractores', 'maquinaria'],
}];

const evidencias = prepararEvidenciasMIA(matches);
assert(evidencias.length === 1 && evidencias[0].ref === 'E1', 'Prepara evidencias compactas con referencias estables');
assert(evidencias[0].titulo.includes('Ayudas para maquinaria'), 'Conserva titulo de evidencia');

const limpio = limpiarRespuestaGroundedMIA('Hola Jaime, esto te interesa. Que tengas un buen dia en tu granja con tus vacas.\nMIA encontro una referencia [E1].');
assert(!/Jaime|vacas|granja/i.test(limpio), 'Limpia persona incorrecta y despedidas raras');
assert(limpio.includes('[E1]'), 'No elimina la referencia valida al limpiar');

const validacionSinCita = validarRespuestaGroundedMIA('MIA encontro una referencia relacionada.', {
  evidencias,
  tipoPregunta: 'general',
});
assert(validacionSinCita.ok === false, 'Rechaza respuestas sin cita de evidencia');

const validacionPago = validarRespuestaGroundedMIA('Se pagara el 15 de junio [E1].', {
  evidencias,
  tipoPregunta: 'pago',
});
assert(validacionPago.ok === false, 'Rechaza afirmaciones sensibles sin cautela');

const fallbackSinEvidencia = construirRespuestaFallbackGroundedMIA({ matches: [] });
assert(fallbackSinEvidencia.reply.includes('agente de Ruralicos'), 'Escala cuando no hay evidencia suficiente');
assert(fallbackSinEvidencia.answer_guardrails.includes('no_evidence'), 'Marca guardrail de falta de evidencia');

const fallbackCooperativa = construirRespuestaFallbackGroundedMIA({
  matches: [],
  organizationContext: {
    reply_sender: 'Cooperativa Los Olivos',
    assistant_name: 'MIA',
    branding_json: {
      agent_label: 'un tecnico de Cooperativa Los Olivos',
    },
  },
});
assert(fallbackCooperativa.reply.includes('base de Cooperativa Los Olivos'), 'Adapta la base al remitente de la organizacion');
assert(fallbackCooperativa.reply.includes('tecnico de Cooperativa Los Olivos'), 'Adapta el escalado al agente de la organizacion');

(async () => {
  const aiOk = await generarRespuestaGroundedMIA({
    texto: 'Hay ayudas para tractores?',
    matches,
    tipoPregunta: 'general',
    answered: true,
    needsAgent: false,
    evidenceLevel: 'alta',
    confidence: 0.9,
    forceAI: true,
    llamarIAFn: async () => 'MIA ha encontrado una referencia sobre ayudas para maquinaria agricola [E1].',
  });

  assert(aiOk.answer_source === 'ai_grounded', 'Acepta respuesta IA con evidencia valida');
  assert(aiOk.reply.includes('[E1]'), 'Conserva cita en respuesta IA valida');

  const aiMala = await generarRespuestaGroundedMIA({
    texto: 'Cuando pagan?',
    matches,
    tipoPregunta: 'pago',
    answered: true,
    needsAgent: true,
    evidenceLevel: 'media',
    confidence: 0.7,
    forceAI: true,
    llamarIAFn: async () => 'Hola Jaime, se pagara el 15 de junio [E1]. Que tengas buen dia en tu granja.',
  });

  assert(aiMala.answer_source === 'deterministic_after_guardrail', 'Cae a fallback si la IA inventa o personaliza mal');
  assert(!/Jaime|granja/i.test(aiMala.reply), 'Fallback no arrastra texto peligroso de la IA');
  assert(aiMala.reply.includes('agente de Ruralicos'), 'Fallback sensible mantiene escalado a agente');

  let llamadaDigest = null;
  const respuestaDigest = await generarRespuestaAlertaDigestMIA({
    texto: 'Explicame de que va y como me apunto',
    alerta: {
      id: 30749,
      item_numero: 1,
      titulo: 'Curso de bienestar animal en explotaciones ganaderas',
      fuente: 'BOA',
      fecha: '2026-08-21',
      region: 'Aragon',
      url: 'https://example.com/boa-curso',
      resumen_usado: 'Curso teleformado con 35 plazas.',
      contenido: 'Curso de 20 horas del 15 de septiembre al 15 de octubre. Solicitudes dirigidas a Agropecuaria Arcoiris. Maximo 35 asistentes.',
    },
    digest: { id: 2916, mensaje: 'Hoy te enviamos el curso de bienestar animal.' },
    contextoReciente: [{ direccion: 'usuario', texto: 'Me interesa el curso', alerta_ids: [30749] }],
    usuario: { contexto_narrativo: 'Perfil ganadero en Aragon.' },
    forceAI: true,
    llamarIAFn: async (prompt, instructions, model, options) => {
      llamadaDigest = { prompt, instructions, model, options };
      return 'Es un curso online de 20 horas, del 15 de septiembre al 15 de octubre. Hay 35 plazas y debes solicitarlo a Agropecuaria Arcoiris.';
    },
  });
  assert(respuestaDigest.answer_source === 'digest_context_ai', 'Usa el LLM para explicar la alerta exacta del digest');
  assert(respuestaDigest.reply.includes('20 horas') && respuestaDigest.reply.includes('35 plazas'), 'Conserva los datos utiles de la explicacion');
  assert(llamadaDigest.prompt.includes('publicacion_oficial') && llamadaDigest.prompt.includes('Maximo 35 asistentes'), 'Entrega al LLM el contenido oficial completo de la alerta');
  assert(llamadaDigest.prompt.includes('Me interesa el curso'), 'Entrega al LLM la conversacion asociada al digest');
  assert(llamadaDigest.options.task === 'mia_digest_answer', 'Registra la llamada con una tarea especifica y auditable');

  const digestSinInventar = await generarRespuestaAlertaDigestMIA({
    texto: 'Cuanto cuesta?',
    alerta: {
      id: 30749,
      titulo: 'Curso de bienestar animal',
      resumen_usado: 'Curso teleformado con 35 plazas.',
      contenido: 'La publicacion no incluye informacion sobre el precio.',
    },
    forceAI: true,
    llamarIAFn: async () => 'La publicacion no especifica el precio.',
  });
  assert(digestSinInventar.reply.includes('no especifica el precio'), 'Permite reconocer con claridad cuando un dato no consta');

  const respuestaEspecies = await generarRespuestaAlertaDigestMIA({
    texto: 'Sirve para vacas y ovejas?',
    alerta: {
      id: 30749,
      titulo: 'Curso de bienestar animal',
      contenido: 'Incluye un modulo especifico para especies ganaderas concretas.',
    },
    forceAI: true,
    llamarIAFn: async () => 'Incluye contenidos aplicables a vacas y ovejas, pero la publicacion no limita el curso a una especie concreta.',
  });
  assert(/vacas y ovejas/i.test(respuestaEspecies.reply), 'No elimina especies ganaderas mencionadas de forma legitima');

  console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
  process.exit(failed > 0 ? 1 : 0);
})();
