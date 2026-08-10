const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CONTRACT_VERSION } = require('../src/modules/alertas/decision-v2/decisionEngine');
const {
  ejecutarShadowParaUsuario,
} = require('../src/modules/alertas/decision-v2/shadowRunner');
const {
  persistirResultadoShadow,
} = require('../src/modules/alertas/decision-v2/decisionRepository');

function profile() {
  return {
    id: 801,
    name: 'Ana Prueba',
    first_name: 'Ana',
    subscription: 'agricultor',
    phone_verified: true,
    preferences: {
      provincias: ['Zaragoza'],
      sectores: ['agricultura'],
      subsectores: ['olivar'],
      tipos_alerta: ['ayudas', 'normativa_general'],
    },
    preferencias_extra: '',
    organization_id: null,
  };
}

function alert(id, overrides = {}) {
  return {
    id,
    titulo: `Aviso agrario ${id}`,
    url: `https://boletin.example/${id}`,
    fecha: '2026-08-10',
    region: 'Aragon',
    fuente: 'BOA',
    contenido: 'Convocatoria oficial para titulares de explotaciones agrarias de Zaragoza.',
    provincias: ['Zaragoza'],
    sectores: ['agricultura'],
    subsectores: [],
    tipos_alerta: ['ayudas'],
    estado_ia: 'descartado',
    duplicado_de: null,
    ...overrides,
  };
}

function fakeRepository(captured) {
  return {
    reclamarShadowRun: async () => ({
      claimed: true,
      shadowRunId: '11111111-1111-4111-8111-111111111111',
    }),
    persistirResultadoShadow: async (_supabase, payload) => {
      captured.payload = payload;
      return {
        decisions: payload.engineResult.decisions.length,
        items: payload.rendered?.items?.length || 0,
      };
    },
  };
}

function fakeSupabaseWrites() {
  const writes = [];
  return {
    writes,
    from(table) {
      let action = null;
      let payload = null;
      const builder = {
        insert(value) {
          action = 'insert';
          payload = value;
          return builder;
        },
        update(value) {
          action = 'update';
          payload = value;
          return builder;
        },
        eq() {
          return builder;
        },
        then(resolve) {
          writes.push({ table, action, payload });
          resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

(async () => {
  console.log('\n=== TESTS: integracion completa shadow decision-v2 ===\n');
  const captured = {};
  const result = await ejecutarShadowParaUsuario({
    supabase: {},
    repository: fakeRepository(captured),
    user: profile(),
    alerts: [
      alert(820, { tipos_alerta: ['normativa_general'] }),
      alert(821, { tipos_alerta: ['ayudas'] }),
    ],
    rawDocumentsByAlert: new Map(),
    sentAlertIds: new Set(),
    workflowDate: '2026-08-10',
    workflowRunKey: '22222222-2222-4222-8222-222222222222',
    shadowRunId: '11111111-1111-4111-8111-111111111111',
    maxIncluded: 2,
    callLLM: async () => JSON.stringify({
      decision_version: CONTRACT_VERSION,
      user_id: 801,
      included: [
        { alert_id: 821, priority: 1, reason: 'Primera.', evidence: ['Convocatoria oficial.'] },
        { alert_id: 820, priority: 2, reason: 'Segunda.', evidence: ['Titulares agrarios.'] },
      ],
      excluded: [],
    }),
  });

  assert.strictEqual(result.status, 'GENERATED');
  assert.strictEqual(result.items, 2);
  assert.strictEqual(captured.payload.engineResult.status, 'GENERATED');
  assert.deepStrictEqual(
    captured.payload.rendered.items.map((item) => item.alert_id),
    [821, 820],
    'el compositor debe conservar el orden decidido por el LLM'
  );
  const preview = captured.payload.rendered.message;
  assert(preview.startsWith('Hola *Ana*'));
  assert(preview.includes('https://boletin.example/821'));
  assert(preview.includes('https://boletin.example/820'));
  for (const item of captured.payload.rendered.items) {
    assert(preview.includes(item.rendered_block), 'cada bloque persistido debe aparecer completo en el preview');
  }
  assert.strictEqual(captured.payload.engineResult.profile_snapshot.phone, undefined);
  console.log('OK: genera y persiste mensaje completo, items y orden real sin telefono');

  const database = fakeSupabaseWrites();
  await persistirResultadoShadow(database, captured.payload);
  assert.deepStrictEqual(
    [...new Set(database.writes.map((write) => write.table))].sort(),
    ['shadow_candidate_decisions', 'shadow_digest_items', 'shadow_digest_runs']
  );
  assert(database.writes.some((write) => write.table === 'shadow_digest_runs' && write.payload.mensaje_preview === preview));
  console.log('OK: la persistencia completa escribe exclusivamente las tres tablas shadow');

  const technical = {};
  const errorResult = await ejecutarShadowParaUsuario({
    supabase: {},
    repository: fakeRepository(technical),
    user: profile(),
    alerts: [alert(822)],
    rawDocumentsByAlert: new Map(),
    sentAlertIds: new Set(),
    workflowDate: '2026-08-10',
    workflowRunKey: '33333333-3333-4333-8333-333333333333',
    shadowRunId: '44444444-4444-4444-8444-444444444444',
    maxIncluded: 1,
    callLLM: async () => {
      throw new Error('fallo tecnico simulado');
    },
  });
  assert.strictEqual(errorResult.status, 'ERROR');
  assert.strictEqual(technical.payload.rendered, null);
  assert.strictEqual(technical.payload.engineResult.selected_alerts.length, 0);
  console.log('OK: un fallo tecnico persiste ERROR y no fabrica mensaje');

  const sourceDir = path.join(__dirname, '..', 'src', 'modules', 'alertas', 'decision-v2');
  const source = fs.readdirSync(sourceDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(sourceDir, name), 'utf8'))
    .join('\n');
  for (const table of [
    'digests',
    'digest_items',
    'alerta_click_links',
    'alerta_clicks',
    'mia_outbox',
    'whatsapp_logs',
  ]) {
    const writePattern = new RegExp(`\\.from\\(['\"]${table}['\"]\\)[\\s\\S]{0,180}\\.(insert|update|upsert|delete)\\(`);
    assert(!writePattern.test(source), `decision-v2 no puede escribir en ${table}`);
  }
  assert(!/require\([^)]*(digestOutbox|whatsapp|tracking|clicks|mia\/outbox)/i.test(source));
  console.log('OK: no existe ninguna via de escritura o import de entrega');

  console.log('\nResultados decisionV2Shadow: 4 aprobados, 0 fallidos');
})().catch((error) => {
  console.error('FAIL: integracion completa shadow decision-v2');
  console.error(error.stack || error.message);
  process.exit(1);
});
