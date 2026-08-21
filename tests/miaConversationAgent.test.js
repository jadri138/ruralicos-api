process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  buscarAlertasHerramientaMIA,
  resolverConversacionMIAConHerramientas,
  __testing,
} = require('../src/modules/mia/conversationAgent');

function respuestaFinal(payload, id = 'resp_final') {
  return {
    id,
    status: 'completed',
    output_text: JSON.stringify(payload),
    output: [],
  };
}

function llamadaHerramienta(id, callId, name, args) {
  return {
    id,
    status: 'completed',
    output: [{
      type: 'function_call',
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    }],
  };
}

function crearSupabaseLectura(rows = []) {
  return {
    from(table) {
      assert.strictEqual(table, 'alertas');
      const filters = [];
      const query = {
        select() { return this; },
        order() { return this; },
        limit() { return this; },
        or() { return this; },
        eq(column, value) { filters.push({ column, value, op: 'eq' }); return this; },
        is(column, value) { filters.push({ column, value, op: 'is' }); return this; },
        gte(column, value) { filters.push({ column, value, op: 'gte' }); return this; },
        lte(column, value) { filters.push({ column, value, op: 'lte' }); return this; },
        then(resolve, reject) {
          const data = rows.filter((row) => filters.every((filter) => {
            if (filter.op === 'eq') return row[filter.column] === filter.value;
            if (filter.op === 'is') return row[filter.column] === filter.value;
            if (filter.op === 'gte') return String(row[filter.column]) >= String(filter.value);
            if (filter.op === 'lte') return String(row[filter.column]) <= String(filter.value);
            return true;
          }));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

async function probarRespuestaDesdeDigest() {
  const calls = [];
  let toolCalls = 0;
  const result = await resolverConversacionMIAConHerramientas(null, {
    texto: 'Y cuantas plazas hay?',
    contextoReciente: [
      { direccion: 'ruralicos', texto: 'Hoy tienes un curso.', alerta_ids: [901] },
      { direccion: 'usuario', texto: 'Explicame el primero' },
      { direccion: 'ruralicos', texto: 'Es un curso de bienestar animal.', alerta_ids: [901] },
    ],
    digest: { id: 81, fecha: '2026-08-21', mensaje: 'Curso de bienestar animal.' },
    alertasDigest: [{
      id: 901,
      titulo: 'Curso de bienestar animal',
      resumen_usado: 'Curso online de 20 horas.',
      contenido: 'La convocatoria indica un maximo de 35 plazas.',
      fecha: '2026-08-21',
      fuente: 'BOA',
      url: 'https://example.com/901',
    }],
    usuario: {
      name: 'Nombre que no debe llegar al modelo',
      mia_operational_profile: { interests: [{ topic: 'ganaderia', score: 4 }] },
    },
    now: new Date('2026-08-21T10:00:00.000Z'),
    llamarIAFn: async (input, instructions, model, options) => {
      calls.push({ input, instructions, model, options });
      return respuestaFinal({
        reply: 'Hay un maximo de 35 plazas. [E1]',
        used_alert_ids: [901],
        answered: true,
        needs_agent: false,
        no_results: false,
        confidence: 0.98,
        question_type: 'requisitos',
      });
    },
    ejecutarHerramientaFn: async () => {
      toolCalls += 1;
      return { ok: true };
    },
  });

  assert.strictEqual(toolCalls, 0);
  assert.strictEqual(calls.length, 1);
  assert(calls[0].input.includes('Explicame el primero'));
  assert(calls[0].input.includes('Es un curso de bienestar animal'));
  assert(calls[0].input.includes('La convocatoria indica un maximo de 35 plazas'));
  assert(!calls[0].input.includes('Nombre que no debe llegar al modelo'));
  assert.strictEqual(calls[0].options.tools.length, 2);
  assert.strictEqual(result.answer_source, 'mia_conversation_agent_digest');
  assert.deepStrictEqual(result.matches.map((item) => item.id), [901]);
}

async function probarBusquedaHistoricaConLectura() {
  const responses = [
    llamadaHerramienta('resp_1', 'call_search', 'buscar_alertas', {
      keywords: ['ayudas'],
      date_from: '2026-08-14',
      date_to: '2026-08-21',
      sources: [],
      region: 'Aragon',
      limit: 6,
    }),
    llamadaHerramienta('resp_2', 'call_read', 'leer_alerta', { alert_id: 1001 }),
    respuestaFinal({
      reply: 'La ayuda encontrada encaja por territorio y actividad; revisa los requisitos oficiales. [E2]',
      used_alert_ids: [1001],
      answered: true,
      needs_agent: false,
      no_results: false,
      confidence: 0.91,
      question_type: 'requisitos',
    }, 'resp_3'),
  ];
  const llmCalls = [];
  const toolCalls = [];
  const alerta = {
    id: 1001,
    titulo: 'Ayudas a explotaciones agrarias de Aragon',
    resumen_final: 'Convocatoria publicada esta semana.',
    contenido: 'Texto oficial con requisitos de la convocatoria.',
    fecha: '2026-08-18',
    fuente: 'BOA',
    region: 'Aragon',
    url: 'https://example.com/1001',
  };

  const result = await resolverConversacionMIAConHerramientas(null, {
    texto: 'que alertas cuadran conmigo en la ultima semana?',
    contextoReciente: [{
      direccion: 'usuario',
      texto: 'hay alguna ayuda disponible que haya salido en los ultimos meses?',
    }],
    digest: { id: 81, fecha: '2026-08-21', mensaje: 'Resumen de hoy.' },
    alertasDigest: [{ id: 901, titulo: 'Alerta de hoy', contenido: 'Contenido actual.' }],
    usuario: { contexto_narrativo: 'Agricultura en Aragon.' },
    now: new Date('2026-08-21T10:00:00.000Z'),
    llamarIAFn: async (input, instructions, model, options) => {
      llmCalls.push({ input, instructions, model, options });
      return responses.shift();
    },
    ejecutarHerramientaFn: async (_supabase, call, { registro }) => {
      toolCalls.push({ name: call.name, arguments: JSON.parse(call.arguments) });
      const evidence = registro.registrar(alerta, { detailed: call.name === 'leer_alerta' });
      if (call.name === 'buscar_alertas') {
        return { ok: true, search_completed: true, count: 1, alerts: [{ ...alerta, ref: evidence.ref }] };
      }
      return { ok: true, found: true, alert: { ...alerta, ref: evidence.ref } };
    },
  });

  assert.deepStrictEqual(toolCalls.map((item) => item.name), ['buscar_alertas', 'leer_alerta']);
  assert.strictEqual(toolCalls[0].arguments.date_from, '2026-08-14');
  assert.strictEqual(llmCalls[1].options.previousResponseId, 'resp_1');
  assert.strictEqual(llmCalls[1].input[0].type, 'function_call_output');
  assert.strictEqual(llmCalls[2].options.previousResponseId, 'resp_2');
  assert(llmCalls[0].input.includes('hay alguna ayuda disponible'));
  assert(llmCalls[0].input.includes('MENSAJE ACTUAL DEL USUARIO\nque alertas cuadran conmigo'));
  assert.strictEqual(result.answer_source, 'mia_tool_agent');
  assert.deepStrictEqual(result.matches.map((item) => item.id), [1001]);
}

async function probarBusquedaVaciaVerificada() {
  const responses = [
    llamadaHerramienta('resp_empty_1', 'call_empty', 'buscar_alertas', {
      keywords: ['pac'],
      date_from: '2026-08-13',
      date_to: '2026-08-13',
      sources: [],
      region: null,
      limit: 6,
    }),
    respuestaFinal({
      reply: 'No he encontrado alertas sobre la PAC publicadas el 13 de agosto en la base consultada.',
      used_alert_ids: [],
      answered: true,
      needs_agent: false,
      no_results: true,
      confidence: 0.9,
      question_type: 'fecha_publicacion',
    }, 'resp_empty_2'),
  ];
  const result = await resolverConversacionMIAConHerramientas(null, {
    texto: 'y sobre el 13?',
    contextoReciente: [{ direccion: 'usuario', texto: 'Ha salido algo de la PAC otros dias?' }],
    now: new Date('2026-08-21T10:00:00.000Z'),
    llamarIAFn: async () => responses.shift(),
    ejecutarHerramientaFn: async () => ({
      ok: true,
      search_completed: true,
      count: 0,
      alerts: [],
    }),
  });
  assert.strictEqual(result.answer_source, 'mia_tool_agent_no_results');
  assert.strictEqual(result.search_completed, true);
  assert.deepStrictEqual(result.matches, []);
}

async function probarBusquedaSoloPorFecha() {
  const rows = [
    {
      id: 1,
      titulo: 'Publicacion uno',
      resumen_final: 'Contenido uno',
      fecha: '2026-08-21',
      estado_ia: 'listo',
      duplicado_de: null,
      organization_id: null,
    },
    {
      id: 2,
      titulo: 'Publicacion dos',
      resumen_final: 'Contenido dos',
      fecha: '2026-08-21',
      estado_ia: 'listo',
      duplicado_de: null,
      organization_id: null,
    },
  ];
  const registro = __testing.construirRegistroEvidencias([]);
  const result = await buscarAlertasHerramientaMIA(crearSupabaseLectura(rows), {
    keywords: [],
    date_from: '2026-08-21',
    date_to: '2026-08-21',
    sources: [],
    region: null,
    limit: 6,
  }, { registro });
  assert.strictEqual(result.count, 2);
  assert.deepStrictEqual(result.alerts.map((item) => item.id), [1, 2]);

  const perfilPrioriza = await buscarAlertasHerramientaMIA(crearSupabaseLectura([
    ...rows,
    {
      id: 4,
      titulo: 'Ayudas de la PAC para agricultores',
      resumen_final: 'Convocatoria agraria.',
      fecha: '2026-08-21',
      estado_ia: 'listo',
      duplicado_de: null,
      organization_id: null,
    },
  ]), {
    keywords: [],
    date_from: '2026-08-21',
    date_to: '2026-08-21',
    sources: [],
    region: null,
    limit: 1,
  }, {
    registro: __testing.construirRegistroEvidencias([]),
    profile: { interests: [{ topic: 'pac', score: 5 }] },
  });
  assert.strictEqual(perfilPrioriza.alerts[0].id, 4);
  assert.strictEqual(perfilPrioriza.truncated, true);

  const porProvincia = await buscarAlertasHerramientaMIA(crearSupabaseLectura([
    ...rows,
    {
      id: 3,
      titulo: 'Ayuda agraria en Zaragoza',
      resumen_final: 'Convocatoria provincial.',
      fecha: '2026-08-20',
      estado_ia: 'listo',
      duplicado_de: null,
      organization_id: null,
    },
  ]), {
    keywords: [],
    date_from: null,
    date_to: null,
    sources: [],
    region: 'Zaragoza',
    limit: 6,
  }, { registro: __testing.construirRegistroEvidencias([]) });
  assert.deepStrictEqual(porProvincia.alerts.map((item) => item.id), [3]);
}

async function main() {
  await probarRespuestaDesdeDigest();
  await probarBusquedaHistoricaConLectura();
  await probarBusquedaVaciaVerificada();
  await probarBusquedaSoloPorFecha();
  console.log('OK: MIA conserva la conversacion, usa herramientas de solo lectura y fundamenta sus respuestas');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
