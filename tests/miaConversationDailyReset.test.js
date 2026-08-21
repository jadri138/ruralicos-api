process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const { __testing } = require('../src/modules/feedback/feedback.routes');

const {
  buscarConversacionActiva,
  cargarDigestYAlertas,
  esConversacionMIADelDia,
  fechaMadridConversacionMIA,
  getExpiracionFinDiaMadridISO,
  extraerItemsReferenciadosInequivocamente,
  cargarConversacionDigestMIA,
  cargarContextoRecienteMIA,
  construirConsultaContextualMIA,
  debeCerrarConversacionMIA,
  debeConsultarBaseConocimientoMIA,
} = __testing;

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

function crearSupabaseMock(tablas = {}) {
  const calls = [];

  function filtrar(table, filters) {
    let rows = tablas[table] || [];
    for (const filter of filters) {
      if (filter.op === 'eq') {
        rows = rows.filter((row) => row[filter.column] === filter.value);
      }
      if (filter.op === 'in') {
        const values = new Set(filter.values);
        rows = rows.filter((row) => values.has(row[filter.column]));
      }
      if (filter.op === 'gte') {
        rows = rows.filter((row) => String(row[filter.column] || '') >= String(filter.value));
      }
      if (filter.op === 'lte') {
        rows = rows.filter((row) => String(row[filter.column] || '') <= String(filter.value));
      }
    }
    return rows;
  }

  return {
    calls,
    from(table) {
      const query = {
        table,
        op: 'select',
        filters: [],
        patch: null,
        select(columns) {
          calls.push({ table, op: 'select', columns });
          return this;
        },
        eq(column, value) {
          this.filters.push({ op: 'eq', column, value });
          calls.push({ table, op: 'eq', column, value });
          return this;
        },
        gt(column, value) {
          calls.push({ table, op: 'gt', column, value });
          return this;
        },
        gte(column, value) {
          this.filters.push({ op: 'gte', column, value });
          calls.push({ table, op: 'gte', column, value });
          return this;
        },
        lte(column, value) {
          this.filters.push({ op: 'lte', column, value });
          calls.push({ table, op: 'lte', column, value });
          return this;
        },
        or() {
          throw new Error('No deberia consultar digests antiguos con .or()');
        },
        in(column, values) {
          if (this.op === 'update') {
            calls.push({ table, op: 'update_in', column, values, patch: this.patch });
            return Promise.resolve({ error: null });
          }
          this.filters.push({ op: 'in', column, values });
          calls.push({ table, op: 'in', column, values });
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return this;
        },
        update(patch) {
          this.op = 'update';
          this.patch = patch;
          calls.push({ table, op: 'update', patch });
          return this;
        },
        maybeSingle() {
          const rows = filtrar(table, this.filters);
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve, reject) {
          return Promise.resolve({ data: filtrar(table, this.filters), error: null }).then(resolve, reject);
        },
      };

      return query;
    },
  };
}

console.log('\n=== TESTS: mia conversation daily reset ===\n');

assert(
  fechaMadridConversacionMIA({ contexto_json: { fecha: '2026-06-05-prueba-123' } }) === '2026-06-05',
  'Extrae fecha diaria aunque el contexto sea de prueba'
);

assert(
  esConversacionMIADelDia({ contexto_json: { fecha: '2026-06-04' } }, '2026-06-05') === false,
  'No considera activa una conversacion de otro dia'
);

assert(
  getExpiracionFinDiaMadridISO('2026-06-05') === '2026-06-05T22:00:00.000Z',
  'Caduca al final del dia Madrid en horario de verano'
);

assert(
  JSON.stringify(extraerItemsReferenciadosInequivocamente('La segunda no me interesa', 3)) === '[2]',
  'Reconoce una referencia ordinal valorada'
);

assert(
  extraerItemsReferenciadosInequivocamente('El 2 de agosto abre el plazo', 3).length === 0,
  'No confunde una fecha con el numero de una alerta'
);

const consultaSeguimiento = construirConsultaContextualMIA('Extremadura', [{
  id: 5,
  texto: 'Sabes cuando pagan la ayuda para fertilizantes?',
  intent: 'pregunta_usuario',
}]);
assert(
  consultaSeguimiento.usada && /fertilizantes[\s\S]*Extremadura/i.test(consultaSeguimiento.texto),
  'Une una aclaracion corta con la pregunta reciente'
);
assert(
  construirConsultaContextualMIA('Quiero recibir alertas sobre PAC', [{
    texto: 'Sabes cuando pagan?', intent: 'pregunta_usuario',
  }]).usada === false,
  'No arrastra contexto a una preferencia nueva'
);
assert(
  construirConsultaContextualMIA('Extremadura', [
    { texto: 'Sabes cuando pagan?', intent: 'pregunta_usuario', direccion: 'usuario' },
    { texto: 'La alerta 1 me interesa', intent: 'feedback_digest', direccion: 'usuario' },
  ]).usada === false,
  'No recupera una pregunta antigua si hubo otra intervencion del usuario despues'
);

assert(
  debeCerrarConversacionMIA({
    conversacionActiva: { id: 20 },
    decision: { policy: { should_reply: true, requires_agent: false } },
    outbox: { id: null },
  }) === false,
  'No cierra una conversación que debía responder pero no pudo encolar respuesta'
);
assert(
  debeCerrarConversacionMIA({
    conversacionActiva: { id: 20, tipo: 'respuesta_consulta' },
    decision: { policy: { should_reply: true, requires_agent: false } },
    outbox: { id: 90 },
  }) === true,
  'Puede cerrar una conversación cuando la respuesta ya quedó encolada'
);
assert(
  debeCerrarConversacionMIA({
    conversacionActiva: { id: 21, tipo: 'feedback_digest' },
    decision: { policy: { should_reply: true, requires_agent: false } },
    outbox: { id: 91 },
  }) === false,
  'Mantiene abierta la conversacion del digest aunque ya haya respondido'
);
assert(
  debeConsultarBaseConocimientoMIA({
    intent: 'pregunta_usuario',
    knowledge_context: { handled: true, answer_source: 'digest_context_clarification' },
  }) === false,
  'No permite que la busqueda global pise una respuesta o aclaracion del digest'
);
assert(
  debeCerrarConversacionMIA({
    conversacionActiva: { id: 20 },
    decision: { policy: { should_reply: true, requires_agent: true } },
    conversacionAgente: { id: null },
    outbox: { id: 90 },
  }) === false,
  'No cierra una consulta que requiere agente si el seguimiento no pudo abrirse'
);

(async () => {
  const supabaseConversaciones = crearSupabaseMock({
    user_conversations: [
      {
        id: 11,
        user_id: 141,
        estado: 'activa',
        tipo: 'feedback_digest',
        contexto_json: { fecha: '2026-06-05', digest_id: 2 },
        abierta_at: '2026-06-05T08:00:00.000Z',
        expira_at: '2026-06-12T08:00:00.000Z',
      },
      {
        id: 10,
        user_id: 141,
        estado: 'activa',
        tipo: 'feedback_digest',
        contexto_json: { fecha: '2026-06-04', digest_id: 1 },
        abierta_at: '2026-06-04T18:00:00.000Z',
        expira_at: '2026-06-11T18:00:00.000Z',
      },
      {
        id: 9,
        user_id: 141,
        estado: 'activa',
        tipo: 'pregunta_exploracion',
        contexto_json: { fecha: '2026-06-04' },
        abierta_at: '2026-06-04T17:00:00.000Z',
        expira_at: '2026-06-11T17:00:00.000Z',
      },
    ],
  });

  const activa = await buscarConversacionActiva(supabaseConversaciones, 141, { fechaHoy: '2026-06-05' });
  assert(activa?.id === 11, 'Devuelve la conversacion mas reciente asociada al digest');
  assert(
    supabaseConversaciones.calls.some((call) =>
      call.table === 'user_conversations' &&
      call.op === 'select' &&
      !String(call.columns || '').includes('created_at')
    ),
    'No pide user_conversations.created_at porque no existe en la BD real'
  );
  assert(
    supabaseConversaciones.calls.some((call) =>
      call.table === 'user_conversations' &&
      call.op === 'update_in' &&
      call.values.includes(9) &&
      !call.values.includes(10) &&
      call.patch.estado === 'expirada'
    ),
    'Expira conversaciones diarias antiguas sin cerrar la sesion del digest'
  );

  const conversacionDigest = await cargarConversacionDigestMIA(crearSupabaseMock({
    mia_inbound_messages: [
      {
        id: 51,
        user_id: 141,
        digest_id: 2,
        sender_kind: 'user',
        status: 'processed',
        text_body: 'Explicame de que va',
        decision_json: { intent: 'pregunta_usuario' },
        created_at: '2026-06-05T08:05:00.000Z',
      },
      {
        id: 52,
        user_id: 141,
        digest_id: 2,
        sender_kind: 'user',
        status: 'processed',
        text_body: 'El curso de bienestar animal',
        decision_json: {
          intent: 'pregunta_usuario',
          knowledge_context: { matches: [{ id: 101 }] },
        },
        created_at: '2026-06-05T08:07:00.000Z',
      },
      {
        id: 53,
        user_id: 141,
        digest_id: 1,
        sender_kind: 'user',
        status: 'processed',
        text_body: 'Mensaje de otro digest',
        created_at: '2026-06-04T08:00:00.000Z',
      },
    ],
    mia_outbox: [
      {
        id: 70,
        user_id: 141,
        digest_id: 2,
        body: 'Digest original con dos cursos',
        metadata_json: { intent: 'digest_daily' },
        delivery_status: 'PROVIDER_ACCEPTED',
        created_at: '2026-06-05T08:00:00.000Z',
        sent_at: '2026-06-05T08:00:30.000Z',
      },
      {
        id: 71,
        user_id: 141,
        digest_id: 2,
        body: 'Dime a cual de los dos cursos te refieres',
        metadata_json: {
          intent: 'pregunta_usuario',
          knowledge_context: { matches: [{ id: 101 }], answer_source: 'ai_grounded' },
        },
        delivery_status: 'READ',
        created_at: '2026-06-05T08:06:00.000Z',
        sent_at: '2026-06-05T08:06:30.000Z',
      },
      {
        id: 72,
        user_id: 141,
        digest_id: 2,
        body: 'Este mensaje no llego al usuario',
        metadata_json: {},
        delivery_status: 'QUEUED',
        created_at: '2026-06-05T08:08:00.000Z',
      },
    ],
  }), { userId: 141, digestId: 2 });
  assert(
    conversacionDigest.map((item) => item.direccion).join(',') === 'ruralicos,usuario,ruralicos,usuario',
    'Carga y ordena todos los mensajes enviados y recibidos del mismo digest'
  );
  assert(
    conversacionDigest.every((item) => !item.texto.includes('otro digest') && !item.texto.includes('no llego')),
    'Aisla el digest actual y excluye salidas que el usuario no recibio'
  );
  assert(
    conversacionDigest.filter((item) => item.alerta_ids?.length).every((item) => item.alerta_ids[0] === 101),
    'Conserva la alerta concreta que MIA estaba explicando para resolver repreguntas'
  );
  assert(
    conversacionDigest.find((item) => item.id === 71)?.answer_source === 'ai_grounded',
    'Conserva el origen de la respuesta para no confundir una busqueda global con el digest'
  );

  const contexto = await cargarContextoRecienteMIA(crearSupabaseMock({
    mia_inbound_messages: [{
      id: 50,
      user_id: 141,
      sender_kind: 'user',
      status: 'processed',
      text_body: 'Sabes cuando pagan la ayuda para fertilizantes?',
      decision_json: { intent: 'pregunta_usuario' },
      created_at: '2026-06-05T08:45:00.000Z',
    }],
  }), 141, { now: '2026-06-05T09:00:00.000Z' });
  assert(
    contexto.length === 1 && contexto[0].intent === 'pregunta_usuario',
    'Carga contexto reciente del mismo usuario'
  );

  const supabaseDigest = crearSupabaseMock({
    digests: [
      {
        id: 20,
        user_id: 141,
        fecha: '2026-06-04',
        alerta_ids: [100],
        enviado: true,
        delivery_status: 'DELIVERED',
        delivered_at: '2026-06-04T08:00:00.000Z',
        organization_id: null,
      },
      {
        id: 21,
        user_id: 141,
        fecha: '2026-06-05',
        alerta_ids: [101],
        enviado: true,
        delivery_status: 'DELIVERED',
        delivered_at: '2026-06-05T08:00:00.000Z',
        organization_id: null,
      },
    ],
    digest_items: [
      {
        digest_id: 21,
        item_numero: 1,
        alerta_id: 101,
        resumen_usado: 'Convocatoria PAC con plazo abierto.',
        motivo_seleccion: 'Encaja con agricultura.',
      },
    ],
    alertas: [
      {
        id: 101,
        titulo: 'Ayuda PAC actual',
        resumen: 'Convocatoria vigente',
        contenido: 'Texto oficial completo de la convocatoria PAC.',
        url: 'https://example.com/pac',
        provincias: ['nacional'],
        sectores: ['agricultura'],
        subsectores: ['pac'],
        tipos_alerta: ['ayudas_subvenciones'],
        fuente: 'BOE',
        organization_id: null,
      },
    ],
  });

  const digestHoy = await cargarDigestYAlertas(supabaseDigest, 141, null, null, { fechaHoy: '2026-06-05' });
  assert(digestHoy.digest?.id === 21, 'Carga solo el digest entregado del dia actual');
  assert(digestHoy.alertasOrdenadas.length === 1 && digestHoy.alertasOrdenadas[0].id === 101, 'Ordena alertas del digest actual');
  assert(
    digestHoy.alertasOrdenadas[0].contenido.includes('Texto oficial completo')
      && digestHoy.alertasOrdenadas[0].resumen_usado.includes('plazo abierto')
      && digestHoy.alertasOrdenadas[0].item_numero === 1,
    'Entrega a MIA el contenido oficial y el texto exacto usado en el digest'
  );
  assert(
    supabaseDigest.calls.some((call) => call.table === 'digests' && call.op === 'eq' && call.column === 'fecha' && call.value === '2026-06-05'),
    'Filtra digests por fecha de hoy'
  );

  const supabaseNoEntregado = crearSupabaseMock({
    digests: [{
      id: 22,
      user_id: 141,
      fecha: '2026-06-05',
      alerta_ids: [102],
      delivery_status: 'FAILED',
      organization_id: null,
    }],
    digest_items: [{ digest_id: 22, item_numero: 1, alerta_id: 102 }],
    alertas: [{ id: 102, titulo: 'No entregada', organization_id: null }],
  });
  const desdeConversacionFallida = await cargarDigestYAlertas(
    supabaseNoEntregado,
    141,
    { digest_id: 22, contexto_json: { digest_id: 22 } },
    null,
    { fechaHoy: '2026-06-05' }
  );
  assert(
    desdeConversacionFallida.digest === null && desdeConversacionFallida.alertasOrdenadas.length === 0,
    'No aprende feedback de un digest que fallo antes de entregarse'
  );

  const supabaseAceptado = crearSupabaseMock({
    digests: [{
      id: 23,
      user_id: 141,
      fecha: '2026-06-05',
      alerta_ids: [103],
      delivery_status: 'PROVIDER_ACCEPTED',
      organization_id: null,
    }],
    digest_items: [{ digest_id: 23, item_numero: 1, alerta_id: 103 }],
    alertas: [{ id: 103, titulo: 'Ayuda aceptada por proveedor', organization_id: null }],
  });
  const desdeAceptado = await cargarDigestYAlertas(
    supabaseAceptado,
    141,
    null,
    null,
    { fechaHoy: '2026-06-05', mensajeUsuario: 'La primera me interesa' }
  );
  assert(
    desdeAceptado.digest?.id === 23 && desdeAceptado.alertasOrdenadas.length === 1,
    'Un inbound puede usar como contexto el digest aceptado por el proveedor'
  );

  const supabaseTardio = crearSupabaseMock({
    digests: [{
      id: 30,
      user_id: 141,
      fecha: '2026-06-04',
      alerta_ids: [201, 202],
      delivery_status: 'DELIVERED',
      delivered_at: '2026-06-04T08:00:00.000Z',
      created_at: '2026-06-04T07:50:00.000Z',
      organization_id: null,
    }],
    digest_items: [
      { digest_id: 30, item_numero: 1, alerta_id: 201 },
      { digest_id: 30, item_numero: 2, alerta_id: 202 },
    ],
    alertas: [
      { id: 201, titulo: 'Ayuda de regadio', organization_id: null },
      { id: 202, titulo: 'Curso de fitosanitarios', organization_id: null },
    ],
  });
  const tardioInequivoco = await cargarDigestYAlertas(
    supabaseTardio,
    141,
    null,
    null,
    {
      fechaHoy: '2026-06-05',
      now: '2026-06-05T09:00:00.000Z',
      mensajeUsuario: 'La 2 no me interesa',
    }
  );
  assert(
    tardioInequivoco.digest?.id === 30 && tardioInequivoco.lateAssociation?.item_numbers?.[0] === 2,
    'Asocia una respuesta tardia inequivoca al ultimo digest entregado'
  );
  assert(
    tardioInequivoco.alertasOrdenadas.map((alerta) => alerta.id).join(',') === '201,202',
    'Conserva el orden completo del digest tardio para interpretar el numero'
  );

  const tardioAmbiguo = await cargarDigestYAlertas(
    supabaseTardio,
    141,
    null,
    null,
    {
      fechaHoy: '2026-06-05',
      now: '2026-06-05T09:00:00.000Z',
      mensajeUsuario: 'No me interesa',
    }
  );
  assert(
    tardioAmbiguo.digest === null && tardioAmbiguo.lateAssociation === null,
    'No atribuye una respuesta tardia ambigua'
  );

  const conConversacionNueva = await cargarDigestYAlertas(
    supabaseTardio,
    141,
    { id: 99, tipo: 'pregunta_exploracion', contexto_json: { fecha: '2026-06-05' } },
    null,
    {
      fechaHoy: '2026-06-05',
      now: '2026-06-05T09:00:00.000Z',
      mensajeUsuario: 'La 2 no me interesa',
    }
  );
  assert(
    conConversacionNueva.digest === null,
    'No mezcla un digest anterior con una conversacion nueva'
  );

  const fueraDeVentana = await cargarDigestYAlertas(
    crearSupabaseMock({
      digests: [{
        id: 31,
        user_id: 141,
        fecha: '2026-06-01',
        alerta_ids: [203],
        delivery_status: 'READ',
        delivered_at: '2026-06-01T08:00:00.000Z',
        read_at: '2026-06-01T10:00:00.000Z',
        created_at: '2026-06-01T07:50:00.000Z',
      }],
      digest_items: [{ digest_id: 31, item_numero: 1, alerta_id: 203 }],
      alertas: [{ id: 203, titulo: 'Aviso antiguo', organization_id: null }],
    }),
    141,
    null,
    null,
    {
      fechaHoy: '2026-06-05',
      now: '2026-06-05T09:00:00.000Z',
      mensajeUsuario: '+1',
    }
  );
  assert(
    fueraDeVentana.digest === null,
    'No asocia respuestas a un digest fuera de la ventana corta'
  );

  console.log(`\nResultados miaConversationDailyReset: ${passed} aprobados, ${failed} fallidos`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
