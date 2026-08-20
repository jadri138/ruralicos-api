const assert = require('assert');
const {
  aplicarDecayMemoria,
  borrarMemoriaAtomica,
  construirMemoriaAtomica,
  construirMemoriasDesdeDecision,
  construirMemoriasYaSolicitadaPeroSimilares,
  corregirMemoriaAtomica,
  esYaSolicitadaPeroSimilares,
  guardarMemoriasAtomicas,
} = require('../src/modules/aprendizaje/atomicMemory');

function createMemorySupabaseMock(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  let nextId = rows.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0) + 1;

  class Query {
    constructor() {
      this.filters = [];
      this.operation = 'select';
      this.payload = null;
      this.executed = false;
      this.result = null;
    }

    select() {
      return this;
    }

    eq(column, value) {
      this.filters.push([column, value]);
      return this;
    }

    insert(payload) {
      this.operation = 'insert';
      this.payload = { ...payload };
      return this;
    }

    update(payload) {
      this.operation = 'update';
      this.payload = { ...payload };
      return this;
    }

    delete() {
      this.operation = 'delete';
      return this;
    }

    matches(row) {
      return this.filters.every(([column, value]) => row[column] === value);
    }

    async execute() {
      if (this.executed) return this.result;
      this.executed = true;

      if (this.operation === 'insert') {
        const duplicate = rows.find((row) => (
          row.user_id === this.payload.user_id
          && row.memory_key === this.payload.memory_key
        ));
        if (duplicate) {
          this.result = { data: null, error: { code: '23505', message: 'duplicate' } };
          return this.result;
        }
        const inserted = { id: nextId++, created_at: new Date().toISOString(), ...this.payload };
        rows.push(inserted);
        this.result = { data: { ...inserted }, error: null };
        return this.result;
      }

      const matches = rows.filter((row) => this.matches(row));
      if (this.operation === 'update') {
        for (const row of matches) Object.assign(row, this.payload);
        this.result = { data: matches[0] ? { ...matches[0] } : null, error: null };
        return this.result;
      }
      if (this.operation === 'delete') {
        const target = matches[0] || null;
        if (target) rows.splice(rows.indexOf(target), 1);
        this.result = { data: target ? { id: target.id } : null, error: null };
        return this.result;
      }

      this.result = { data: matches[0] ? { ...matches[0] } : null, error: null };
      return this.result;
    }

    maybeSingle() {
      return this.execute();
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }
  }

  return {
    rows,
    from(table) {
      assert.strictEqual(table, 'user_memory');
      return new Query();
    },
  };
}

async function main() {
  const base = construirMemoriaAtomica({
    userId: 9,
    tipo: 'interes_detectado',
    contenido: '  Le interesa la PAC  ',
    scopeType: 'topic',
    scopeValue: 'PAC',
    polarity: 'positive',
    source: 'whatsapp',
    strength: 0.9,
    confidence: 0.95,
  });
  const equivalent = construirMemoriaAtomica({
    userId: 9,
    tipo: 'interes_detectado',
    contenido: 'le interesa la pac',
    scopeType: 'topic',
    scopeValue: 'pac',
    polarity: 'positive',
    source: 'response',
    strength: 0.8,
  });

  assert.strictEqual(base.memory_key, equivalent.memory_key, 'La clave normaliza señales equivalentes');
  assert.strictEqual(base.source, 'response', 'El canal se traduce a una fuente semántica');
  assert.strictEqual(base.scope_value, 'pac');

  const nuancedText = 'Esta no porque ya la pedí, pero mándame ayudas parecidas';
  assert(esYaSolicitadaPeroSimilares(nuancedText), 'Reconoce el rechazo concreto con interés en similares');

  const nuanced = construirMemoriasYaSolicitadaPeroSimilares({
    userId: 9,
    alerta: { id: 77, titulo: 'Ayuda para comprar tractores' },
    digestId: 12,
  });
  assert.strictEqual(nuanced.length, 2);
  assert(nuanced.some((row) => row.scope_type === 'alert' && row.polarity === 'negative'));
  assert(nuanced.some((row) => row.scope_type === 'topic' && row.polarity === 'positive'));
  assert(!nuanced.some((row) => row.scope_type === 'topic' && row.polarity === 'negative'));

  const genericRows = construirMemoriasDesdeDecision({
    userId: 9,
    textoOriginal: 'Me interesa la PAC',
    decision: {
      version: 'decision-v2',
      confidence: 0.9,
      memory_actions: [{
        tipo: 'interes_detectado',
        contenido: 'Le interesa la PAC',
        peso_inicial: 0.9,
      }],
    },
  });
  assert.strictEqual(genericRows.length, 1);
  assert.strictEqual(genericRows[0].scope_value, 'pac');
  assert.strictEqual(
    construirMemoriasDesdeDecision({
      userId: 9,
      textoOriginal: nuancedText,
      decision: { memory_actions: [{ tipo: 'desinteres_detectado', contenido: 'No quiere ayudas' }] },
    }).length,
    0,
    'El adaptador no guarda un negativo temático amplio en el caso matizado'
  );

  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
  const clickDecay = aplicarDecayMemoria({
    status: 'active',
    source: 'click',
    strength: 1,
    last_seen_at: ninetyDaysAgo,
  });
  const responseDecay = aplicarDecayMemoria({
    status: 'active',
    source: 'response',
    polarity: 'positive',
    strength: 1,
    last_seen_at: ninetyDaysAgo,
  });
  assert(clickDecay.effective_strength < responseDecay.effective_strength, 'Los clics decaen más rápido');
  assert.strictEqual(
    aplicarDecayMemoria({
      status: 'active',
      source: 'response',
      polarity: 'negative',
      strength: 0.9,
      last_seen_at: ninetyDaysAgo,
    }).effective_strength,
    0.9,
    'Una exclusión explícita permanece hasta corrección'
  );

  const supabase = createMemorySupabaseMock();
  const firstSave = await guardarMemoriasAtomicas(supabase, [base]);
  const secondSave = await guardarMemoriasAtomicas(supabase, [equivalent]);
  assert.strictEqual(firstSave.inserted, 1);
  assert.strictEqual(secondSave.merged, 1);
  assert.strictEqual(supabase.rows.length, 1, 'Un replay no duplica la memoria');
  assert.strictEqual(supabase.rows[0].duplicate_count, 1);
  assert.strictEqual(
    supabase.rows[0].incorporado_a_embedding,
    false,
    'Una memoria fusionada vuelve a quedar pendiente de recalcular'
  );

  const inboundMemory = construirMemoriaAtomica({
    userId: 10,
    inboundId: 72,
    tipo: 'interes_detectado',
    contenido: 'Le interesa el olivar',
    scopeType: 'topic',
    scopeValue: 'olivar',
    polarity: 'positive',
  });
  await guardarMemoriasAtomicas(supabase, [inboundMemory]);
  const inboundReplay = await guardarMemoriasAtomicas(supabase, [inboundMemory]);
  assert.strictEqual(inboundReplay.replayed, 1);
  assert.strictEqual(
    supabase.rows.find((row) => row.user_id === 10).duplicate_count,
    0,
    'Reprocesar el mismo inbound no aumenta el peso'
  );

  const correction = await corregirMemoriaAtomica(supabase, {
    userId: 9,
    memoryId: supabase.rows[0].id,
    replacement: {
      contenido: 'Ya no le interesa la PAC',
      polarity: 'negative',
      scopeType: 'topic',
      scopeValue: 'pac',
    },
  });
  assert(correction.ok);
  assert.strictEqual(supabase.rows.length, 3);
  const oldRow = supabase.rows.find((row) => row.correction_of == null);
  const correctedRow = supabase.rows.find((row) => row.correction_of === oldRow.id);
  assert.strictEqual(oldRow.status, 'corrected');
  assert.strictEqual(correctedRow.polarity, 'negative');

  const deletion = await borrarMemoriaAtomica(supabase, {
    userId: 9,
    memoryId: correctedRow.id,
  });
  assert(deletion.ok);
  assert.strictEqual(supabase.rows.length, 2, 'El borrado elimina solo la memoria del usuario');

  console.log('OK: memoria atómica idempotente, acotada, corregible y con decay');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
