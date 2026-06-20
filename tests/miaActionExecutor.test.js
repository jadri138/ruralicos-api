const {
  construirFeedbackRows,
  limpiarFeedbackRowsLegacy,
  construirMemoriaLegacyRows,
  construirCasoAgenteDesdeDecision,
  ejecutarAccionesMIA,
  registrarCasoAgenteMIA,
  abrirConversacionAgenteMIA,
  necesitaCasoAgenteMIA,
} = require('../src/modules/mia/actionExecutor');

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

function crearSupabaseMock({ existingAgentCases = [], existingConversations = [] } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const query = {
        table,
        _op: 'select',
        _rows: null,
        upsert(rows, options) {
          calls.push({ table, op: 'upsert', rows, options });
          return Promise.resolve({ error: null });
        },
        select() {
          return this;
        },
        eq() {
          return this;
        },
        in() {
          return this;
        },
        gt() {
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return this;
        },
        maybeSingle() {
          const rows = this._selectRows();
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        single() {
          if (this._op === 'insert') {
            if (table === 'mia_agent_cases') return Promise.resolve({ data: { id: 77 }, error: null });
            if (table === 'user_conversations') return Promise.resolve({ data: { id: 88 }, error: null });
          }
          return Promise.resolve({ data: this._selectRows()[0] || null, error: null });
        },
        then(resolve, reject) {
          return Promise.resolve({ data: this._selectRows(), error: null }).then(resolve, reject);
        },
        _selectRows() {
          if (table === 'mia_agent_cases') return existingAgentCases;
          if (table === 'user_conversations') return existingConversations;
          return [];
        },
        insert(rows) {
          calls.push({ table, op: 'insert', rows });
          this._op = 'insert';
          this._rows = rows;
          return this;
        },
        update(rows) {
          calls.push({ table, op: 'update', rows });
          this._op = 'update';
          this._rows = rows;
          return this;
        },
      };
      return query;
    },
  };
}

console.log('\n=== TESTS: mia action executor ===\n');

const user = { id: 141, organization_id: 12 };
const digest = { id: 1097, organization_id: 12 };
const alertasOrdenadas = [
  { id: 8064, titulo: 'Ayuda de maquinaria agricola', sectores: ['agricultura'] },
  { id: 8065, titulo: 'Curso de drones', sectores: ['formacion'] },
];

const decisionFeedback = {
  intent: 'feedback_digest',
  feedback_actions: [{ item_numero: 1, valor: 1, confidence: 0.95 }],
  memory_actions: [{ tipo: 'interes_detectado', contenido: 'Le interesa maquinaria agricola', peso_inicial: 0.8 }],
  risk_flags: [],
};

const feedbackRows = construirFeedbackRows({
  user,
  digest,
  alertasOrdenadas,
  texto: 'me interesa la 1',
  decision: decisionFeedback,
});

assert(feedbackRows.length === 1, 'Construye feedback solo desde feedback_actions validadas');
assert(feedbackRows[0].alerta_id === 8064, 'Mapea item_numero al alerta exacta del digest');
assert(feedbackRows[0].valor === 1, 'Conserva valor del feedback');
assert(feedbackRows[0].organization_id === 12, 'Propaga organization_id al feedback');
assert(feedbackRows[0].feedback_category === 'useful', 'Clasifica feedback positivo como util');
assert(feedbackRows[0].feedback_detail.reasons.includes('positive_feedback'), 'Guarda detalle de clasificacion');

const negativeRows = construirFeedbackRows({
  user,
  digest,
  alertasOrdenadas,
  texto: 'la 1 no es de mi zona, es otra provincia',
  decision: { intent: 'feedback_digest', feedback_actions: [{ item_numero: 1, valor: -1 }] },
});

assert(negativeRows[0].feedback_category === 'wrong_location', 'Clasifica feedback negativo por ubicacion');
assert(limpiarFeedbackRowsLegacy(negativeRows)[0].feedback_category === undefined, 'Fallback legacy elimina columnas nuevas');

const memoryRows = construirMemoriaLegacyRows({
  user,
  digest,
  alertasOrdenadas,
  texto: 'me interesa la 1',
  decision: decisionFeedback,
});

assert(memoryRows.length === 2, 'Construye memoria legacy de feedback y memoria explicita');
assert(memoryRows.some((row) => row.tipo === 'feedback_positivo'), 'Incluye memoria de feedback positivo');
assert(memoryRows.some((row) => row.tipo === 'interes_detectado'), 'Incluye memoria declarativa');
assert(memoryRows.every((row) => row.organization_id === 12), 'Propaga organization_id a memorias legacy');

const decisionPreferencias = {
  intent: 'actualizar_preferencias',
  feedback_actions: [],
  memory_actions: [{ tipo: 'interes_detectado', contenido: 'Le interesa la PAC', peso_inicial: 0.9 }],
  risk_flags: [],
};

assert(
  construirFeedbackRows({ user, digest, alertasOrdenadas, texto: 'quiero PAC', decision: decisionPreferencias }).length === 0,
  'Una preferencia futura no crea feedback de alerta'
);

const decisionFueraDominio = {
  intent: 'mensaje_libre',
  feedback_actions: [],
  memory_actions: [{ tipo: 'mensaje_libre', contenido: 'Quiere un chiste', peso_inicial: 0.5 }],
  risk_flags: ['policy_silence_out_of_scope'],
  policy: {
    should_store_memory: false,
    requires_agent: false,
    should_reply: false,
  },
};

assert(
  construirMemoriaLegacyRows({ user, digest, alertasOrdenadas, texto: 'cuentame un chiste', decision: decisionFueraDominio }).length === 0,
  'No guarda memoria cuando policy silencia fuera de dominio'
);

const decisionPregunta = {
  intent: 'pregunta_usuario',
  confidence: 0.84,
  summary: 'Pregunta por fecha de resolucion',
  feedback_actions: [],
  memory_actions: [],
  risk_flags: [],
};

const caso = construirCasoAgenteDesdeDecision({
  user,
  inboundId: 72,
  decisionId: 9,
  digestId: digest.id,
  conversationId: 525,
  texto: 'Cuando sale la resolucion en Andalucia',
  decision: decisionPregunta,
});

assert(caso && caso.status === 'open', 'Crea caso agente para preguntas de usuario');
assert(caso.priority === 'normal', 'Prioridad normal por defecto para pregunta clara');
assert(caso.question_text.includes('resolucion'), 'Conserva texto de la pregunta para el agente');
assert(caso.organization_id === 12, 'Propaga organization_id al caso agente');
assert(necesitaCasoAgenteMIA(decisionPregunta) === true, 'Detecta necesidad de caso agente');

const casoAutoRespondido = construirCasoAgenteDesdeDecision({
  user,
  texto: 'Hay ayudas para tractores?',
  decision: {
    intent: 'pregunta_usuario',
    confidence: 0.86,
    risk_flags: ['auto_answered_from_knowledge_base'],
  },
});

assert(casoAutoRespondido === null, 'No escala preguntas auto respondidas con base de conocimiento');

const casoSinEvidencia = construirCasoAgenteDesdeDecision({
  user,
  texto: 'Hay algo sobre una ayuda rara que no aparece?',
  decision: {
    intent: 'unknown',
    confidence: 0.4,
    risk_flags: ['knowledge_no_match'],
  },
});

assert(casoSinEvidencia && casoSinEvidencia.status === 'open', 'Escala cuando no hay evidencia en la base Ruralicos');

const supabase = crearSupabaseMock();
ejecutarAccionesMIA(supabase, {
  user,
  digest,
  alertasOrdenadas,
  texto: 'me interesa la 1',
  decision: decisionFeedback,
  aplicarFeedbackAlPerfil: async () => {},
}).then(async (resultado) => {
  assert(resultado.feedbacks_guardados === 1, 'Ejecuta un feedback validado');
  assert(resultado.memorias_guardadas === 2, 'Ejecuta memorias asociadas');
  assert(supabase.calls.some((call) => call.table === 'alerta_feedback' && call.op === 'upsert'), 'Hace upsert en alerta_feedback');
  assert(supabase.calls.some((call) => call.table === 'user_memory' && call.op === 'insert'), 'Inserta user_memory');

  const casoRegistrado = await registrarCasoAgenteMIA(supabase, {
    user,
    texto: 'Cuando sale la resolucion en Andalucia',
    decision: decisionPregunta,
  });

  assert(casoRegistrado.created === true && casoRegistrado.id === 77, 'Registra caso agente cuando aplica');

  const supabaseExistente = crearSupabaseMock({
    existingAgentCases: [{
      id: 91,
      status: 'open',
      reason: 'pregunta_usuario',
      digest_id: null,
      question_text: 'Cuando sale la resolucion en Andalucia',
      metadata_json: {},
      created_at: new Date().toISOString(),
    }],
  });
  const casoExistente = await registrarCasoAgenteMIA(supabaseExistente, {
    user,
    texto: 'Cuando sale la resolución en Andalucía',
    decision: decisionPregunta,
  });
  assert(casoExistente.existing === true && casoExistente.id === 91, 'Reutiliza caso agente abierto equivalente');
  assert(!supabaseExistente.calls.some((call) => call.table === 'mia_agent_cases' && call.op === 'insert'), 'No inserta caso duplicado');

  const conversacionNueva = await abrirConversacionAgenteMIA(supabase, {
    user,
    caseId: 77,
    texto: 'Cuando sale la resolucion en Andalucia',
    decision: decisionPregunta,
  });
  assert(conversacionNueva.created === true && conversacionNueva.id === 88, 'Abre conversacion respuesta_consulta para agente');

  const supabaseConversacionExistente = crearSupabaseMock({
    existingConversations: [{ id: 99, contexto_json: { origen: 'previo' } }],
  });
  const conversacionActualizada = await abrirConversacionAgenteMIA(supabaseConversacionExistente, {
    user,
    caseId: 77,
    texto: 'Seguimos con esto',
    decision: decisionPregunta,
  });
  assert(conversacionActualizada.updated === true && conversacionActualizada.id === 99, 'Actualiza conversacion agente activa');

  console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
  process.exit(failed > 0 ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
