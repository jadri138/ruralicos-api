function contieneJson(actual, expected) {
  if (!expected || typeof expected !== 'object') return actual === expected;
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => contieneJson(actual[key], value));
}

function crearSupabaseMemoria(seed = {}) {
  const tables = Object.fromEntries(
    Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))])
  );
  const calls = [];
  const tableRows = (name) => {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  };

  function builder(table) {
    const state = {
      op: 'select',
      patch: null,
      inserted: null,
      filters: [],
      limit: null,
      order: null,
      returning: false,
    };

    const query = {
      select() {
        if (state.op !== 'select') state.returning = true;
        return this;
      },
      update(patch) {
        state.op = 'update';
        state.patch = patch;
        calls.push({ table, op: 'update', patch });
        return this;
      },
      insert(rows) {
        state.op = 'insert';
        state.inserted = Array.isArray(rows) ? rows : [rows];
        calls.push({ table, op: 'insert', rows: state.inserted });
        return this;
      },
      upsert(rows) {
        state.op = 'insert';
        state.inserted = Array.isArray(rows) ? rows : [rows];
        calls.push({ table, op: 'upsert', rows: state.inserted });
        return this;
      },
      delete() {
        state.op = 'delete';
        calls.push({ table, op: 'delete' });
        return this;
      },
      eq(column, value) { state.filters.push((row) => row[column] === value); return this; },
      neq(column, value) { state.filters.push((row) => row[column] !== value); return this; },
      in(column, values) { state.filters.push((row) => values.includes(row[column])); return this; },
      or(expression) {
        if (String(expression).startsWith('delivery_status.is.null,delivery_status.in.(')) {
          const values = String(expression).match(/delivery_status\.in\.\(([^)]+)\)/)?.[1]?.split(',') || [];
          state.filters.push((row) => (
            row.delivery_status === null
            || row.delivery_status === undefined
            || values.includes(row.delivery_status)
          ));
        }
        return this;
      },
      contains(column, value) {
        state.filters.push((row) => contieneJson(row[column], value));
        return this;
      },
      is(column, value) { state.filters.push((row) => row[column] === value); return this; },
      not(column, operator, value) {
        if (operator === 'is' && value === null) {
          state.filters.push((row) => row[column] !== null && row[column] !== undefined);
        }
        return this;
      },
      gt(column, value) { state.filters.push((row) => String(row[column]) > String(value)); return this; },
      lte(column, value) {
        state.filters.push((row) => (
          row[column] !== null
          && row[column] !== undefined
          && String(row[column]) <= String(value)
        ));
        return this;
      },
      lt(column, value) {
        state.filters.push((row) => {
          const left = Number(row[column]);
          const right = Number(value);
          return Number.isFinite(left) && Number.isFinite(right)
            ? left < right
            : String(row[column]) < String(value);
        });
        return this;
      },
      gte(column, value) { state.filters.push((row) => String(row[column]) >= String(value)); return this; },
      order(column, options = {}) {
        state.order = { column, ascending: options.ascending !== false };
        return this;
      },
      limit(value) { state.limit = Number(value); return this; },
      maybeSingle() {
        return execute().then((result) => ({
          ...result,
          data: Array.isArray(result.data) ? result.data[0] || null : result.data,
        }));
      },
      single() {
        return execute().then((result) => ({
          ...result,
          data: Array.isArray(result.data) ? result.data[0] || null : result.data,
        }));
      },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };

    function filteredRows() {
      let rows = tableRows(table).filter((row) => state.filters.every((filter) => filter(row)));
      if (state.order) {
        const direction = state.order.ascending ? 1 : -1;
        rows = [...rows].sort((a, b) => (
          String(a[state.order.column] || '').localeCompare(String(b[state.order.column] || '')) * direction
        ));
      }
      if (Number.isFinite(state.limit)) rows = rows.slice(0, state.limit);
      return rows;
    }

    async function execute() {
      if (state.op === 'insert') {
        if (table === 'whatsapp_delivery_events') {
          const duplicate = state.inserted.find((candidate) => (
            tableRows(table).some((row) => row.event_hash === candidate.event_hash)
          ));
          if (duplicate) {
            return { data: null, error: { code: '23505', message: 'duplicate event_hash' } };
          }
        }
        if (table === 'user_memory') {
          const duplicate = state.inserted.find((candidate) => (
            tableRows(table).some((row) => (
              row.user_id === candidate.user_id && row.memory_key === candidate.memory_key
            ))
          ));
          if (duplicate) return { data: null, error: { code: '23505', message: 'duplicate memory_key' } };
        }
        const target = tableRows(table);
        const inserted = state.inserted.map((row) => ({ id: row.id || target.length + 1, ...row }));
        target.push(...inserted);
        return { data: state.returning ? inserted : null, error: null };
      }

      const rows = filteredRows();
      if (state.op === 'update') {
        rows.forEach((row) => Object.assign(row, state.patch));
        return { data: state.returning ? rows.map((row) => ({ ...row })) : null, error: null };
      }
      if (state.op === 'delete') {
        const target = tableRows(table);
        for (const row of rows) target.splice(target.indexOf(row), 1);
        return { data: state.returning ? rows.map((row) => ({ ...row })) : null, error: null };
      }
      return { data: rows.map((row) => ({ ...row })), error: null };
    }

    return query;
  }

  return { tables, calls, from: builder };
}

module.exports = {
  contieneJson,
  crearSupabaseMemoria,
};
