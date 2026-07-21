const {
  REQUIRED_COLUMNS,
  REQUIRED_MIGRATIONS,
  REQUIRED_TABLES,
} = require('./config');
const {
  DISCARD_COMPATIBILITY_SUMMARY,
} = require('../../src/modules/alertas/clasificacion/discardDecision');

const REQUIRED_CONSTRAINT = 'alertas_structured_discard_check';
const INVENTORY_SOURCES = Object.freeze(['BOPA', 'DOGC', 'DOE']);

const FORBIDDEN_SQL = /\b(?:insert|update|delete|merge|upsert|alter|create|drop|truncate|call|do|grant|revoke|refresh|vacuum|analyze|copy|execute|prepare|lock|nextval|setval|pg_advisory_lock)\b/i;

const INVENTORY_SQL = Object.freeze({
  connection: `
    select
      current_user as role_name,
      current_setting('transaction_read_only') = 'on' as transaction_read_only,
      coalesce(has_table_privilege(current_user, to_regclass('public.alertas'), 'SELECT'), false) as alertas_can_select,
      coalesce(has_table_privilege(current_user, to_regclass('public.raw_documents'), 'SELECT'), false) as raw_documents_can_select,
      coalesce(has_table_privilege(current_user, to_regclass('public.alertas'), 'INSERT'), false) as alertas_can_insert,
      coalesce(has_table_privilege(current_user, to_regclass('public.alertas'), 'UPDATE'), false) as alertas_can_update,
      coalesce(has_table_privilege(current_user, to_regclass('public.alertas'), 'DELETE'), false) as alertas_can_delete,
      coalesce(has_table_privilege(current_user, to_regclass('public.alertas'), 'TRUNCATE'), false) as alertas_can_truncate,
      coalesce(has_table_privilege(current_user, to_regclass('public.raw_documents'), 'INSERT'), false) as raw_documents_can_insert,
      coalesce(has_table_privilege(current_user, to_regclass('public.raw_documents'), 'UPDATE'), false) as raw_documents_can_update,
      coalesce(has_table_privilege(current_user, to_regclass('public.raw_documents'), 'DELETE'), false) as raw_documents_can_delete,
      coalesce(has_table_privilege(current_user, to_regclass('public.raw_documents'), 'TRUNCATE'), false) as raw_documents_can_truncate
  `,
  tables: `
    select table_schema, table_name
    from information_schema.tables
    where (table_schema = 'public' and table_name = any($1::text[]))
       or (table_schema = 'supabase_migrations' and table_name = 'schema_migrations')
    order by table_schema, table_name
  `,
  columns: `
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = any($1::text[])
    order by table_name, ordinal_position
  `,
  migrations: `
    select version::text as version, name
    from supabase_migrations.schema_migrations
    where version::text = any($1::text[])
    order by version::text
  `,
  constraint: `
    select
      constraint_row.conname as name,
      constraint_row.convalidated as validated
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation_row
      on relation_row.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = relation_row.relnamespace
    where namespace_row.nspname = 'public'
      and relation_row.relname = 'alertas'
      and constraint_row.conname = $1
  `,
  alertasBySourceState: `
    select
      coalesce(nullif(btrim(fuente), ''), '(sin_fuente)') as fuente,
      coalesce(nullif(btrim(estado_ia), ''), '(sin_estado)') as estado_ia,
      count(*)::bigint as total
    from public.alertas
    group by 1, 2
    order by 1, 2
  `,
  retained: `
    select
      count(*) filter (where estado_ia = 'pendiente_revision_manual')::bigint as pendiente_revision_manual,
      count(*) filter (where estado_ia = 'needs_evidence')::bigint as needs_evidence
    from public.alertas
  `,
  discards: `
    select
      count(*) filter (where estado_ia = 'descartado')::bigint as total,
      count(*) filter (
        where estado_ia = 'descartado'
          and coalesce(
            btrim(discard_reason_code) <> ''
            and btrim(discard_reason) <> ''
            and btrim(discard_stage) <> ''
            and discard_confidence between 0::double precision and 1::double precision
            and jsonb_typeof(decision_audit) = 'object'
            and jsonb_typeof(decision_audit -> 'discard') = 'object'
            and decision_audit #>> '{discard,code}' = discard_reason_code
            and decision_audit #>> '{discard,reason}' = discard_reason
            and decision_audit #>> '{discard,stage}' = discard_stage
            and case
              when jsonb_typeof(decision_audit #> '{discard,confidence}') = 'number'
                then (decision_audit #>> '{discard,confidence}')::double precision = discard_confidence
              else false
            end,
            false
          )
      )::bigint as structured,
      count(*) filter (
        where estado_ia = 'descartado'
          and not coalesce(
            btrim(discard_reason_code) <> ''
            and btrim(discard_reason) <> ''
            and btrim(discard_stage) <> ''
            and discard_confidence between 0::double precision and 1::double precision
            and jsonb_typeof(decision_audit) = 'object'
            and jsonb_typeof(decision_audit -> 'discard') = 'object'
            and decision_audit #>> '{discard,code}' = discard_reason_code
            and decision_audit #>> '{discard,reason}' = discard_reason
            and decision_audit #>> '{discard,stage}' = discard_stage
            and case
              when jsonb_typeof(decision_audit #> '{discard,confidence}') = 'number'
                then (decision_audit #>> '{discard,confidence}')::double precision = discard_confidence
              else false
            end,
            false
          )
      )::bigint as incomplete
    from public.alertas
  `,
  noImportaOutsideDiscard: `
    select count(*)::bigint as total
    from public.alertas
    where btrim(coalesce(resumen, '')) = 'NO IMPORTA'
      and estado_ia is distinct from 'descartado'
  `,
  readyWithDiscardFields: `
    select count(*)::bigint as total
    from public.alertas
    where estado_ia = 'listo'
      and (
        nullif(btrim(discard_reason_code), '') is not null
        or nullif(btrim(discard_reason), '') is not null
        or nullif(btrim(discard_stage), '') is not null
        or discard_confidence is not null
        or coalesce(jsonb_typeof(decision_audit -> 'discard') = 'object', false)
      )
  `,
  rawCoverage: `
    with sources(fuente) as (
      values ('BOPA'::text), ('DOGC'::text), ('DOE'::text)
    )
    select
      sources.fuente,
      (
        select count(*)::bigint
        from public.alertas alert_row
        where upper(coalesce(alert_row.fuente, '')) = sources.fuente
      ) as alertas,
      (
        select count(distinct raw_row.inserted_alerta_id)::bigint
        from public.raw_documents raw_row
        join public.alertas alert_row on alert_row.id = raw_row.inserted_alerta_id
        where upper(coalesce(raw_row.fuente, '')) = sources.fuente
          and upper(coalesce(alert_row.fuente, '')) = sources.fuente
      ) as alertas_con_raw_document,
      (
        select count(*)::bigint
        from public.raw_documents raw_row
        where upper(coalesce(raw_row.fuente, '')) = sources.fuente
      ) as raw_documents,
      (
        select count(*)::bigint
        from public.raw_documents raw_row
        where upper(coalesce(raw_row.fuente, '')) = sources.fuente
          and nullif(btrim(raw_row.texto_raw), '') is not null
      ) as raw_documents_con_texto,
      (
        select count(*)::bigint
        from public.raw_documents raw_row
        where upper(coalesce(raw_row.fuente, '')) = sources.fuente
          and (
            nullif(btrim(raw_row.organismo), '') is not null
            or nullif(btrim(raw_row.seccion), '') is not null
            or nullif(btrim(raw_row.boletin), '') is not null
            or nullif(btrim(raw_row.id_oficial), '') is not null
            or coalesce(
              raw_row.metadata_json ?| array[
                'organismo', 'seccion', 'subseccion', 'tipo_documento',
                'tipoDocumento', 'document_type', 'id_oficial', 'idOficial',
                'boletin', 'bopa'
              ],
              false
            )
          )
      ) as raw_documents_con_metadata_oficial
    from sources
    order by sources.fuente
  `,
});

function normalizeSql(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim();
}

function assertReadOnlyStatement(sql) {
  const normalized = normalizeSql(sql);
  if (!/^(?:select|with|show)\b/i.test(normalized)) {
    throw new Error('p0_read_only_violation: solo se permiten SELECT, WITH o SHOW');
  }
  const withoutTrailingSemicolon = normalized.replace(/;\s*$/, '');
  const withoutStringLiterals = withoutTrailingSemicolon.replace(/'(?:''|[^'])*'/g, "''");
  if (withoutStringLiterals.includes(';') || FORBIDDEN_SQL.test(withoutStringLiterals)) {
    throw new Error('p0_read_only_violation: sentencia potencialmente mutante rechazada');
  }
  return true;
}

async function queryReadOnly(client, sql, params = []) {
  assertReadOnlyStatement(sql);
  return client.query(sql, params);
}

async function withReadOnlyTransaction(client, task) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let result;
  let taskError = null;
  try {
    const check = await client.query('SHOW transaction_read_only');
    if (check.rows?.[0]?.transaction_read_only !== 'on') {
      throw new Error('p0_read_only_violation: la transaccion no esta en READ ONLY');
    }
    result = await task(client);
  } catch (error) {
    taskError = error;
  }
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    if (!taskError) taskError = rollbackError;
  }
  if (taskError) throw taskError;
  return result;
}

function numberValue(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundedLabel(value, fallback) {
  const normalized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return (normalized || fallback).slice(0, 64);
}

function buildSchemaReport({ tables = [], columns = {}, migrations = [], constraint = null }) {
  const tableSet = new Set(tables.map(String));
  const migrationSet = new Set(migrations.map(String));
  const missingTables = REQUIRED_TABLES.filter((table) => !tableSet.has(table));
  const missingColumns = [];

  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const available = new Set((columns[table] || []).map(String));
    for (const column of required) {
      if (!available.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }

  const missingMigrations = REQUIRED_MIGRATIONS
    .filter((migration) => !migrationSet.has(migration.version))
    .map((migration) => migration.version);
  const constraintState = {
    name: REQUIRED_CONSTRAINT,
    exists: Boolean(constraint?.exists),
    validated: constraint?.exists ? Boolean(constraint.validated) : false,
  };
  const schemaNotApplied = missingTables.length > 0
    || missingColumns.length > 0
    || missingMigrations.length > 0
    || !constraintState.exists;

  return {
    status: schemaNotApplied ? 'schema_not_applied' : 'pass',
    required_tables: REQUIRED_TABLES,
    missing_tables: missingTables,
    missing_columns: missingColumns,
    required_migrations: REQUIRED_MIGRATIONS.map((migration) => migration.version),
    missing_migrations: missingMigrations,
    constraint: constraintState,
  };
}

function connectionReport(row = {}) {
  const writeFlags = [
    row.alertas_can_insert,
    row.alertas_can_update,
    row.alertas_can_delete,
    row.alertas_can_truncate,
    row.raw_documents_can_insert,
    row.raw_documents_can_update,
    row.raw_documents_can_delete,
    row.raw_documents_can_truncate,
  ];

  return {
    role: row.role_name || null,
    transaction_read_only: row.transaction_read_only === true,
    can_select_alertas: row.alertas_can_select === true,
    can_select_raw_documents: row.raw_documents_can_select === true,
    has_write_privileges: writeFlags.some((value) => value === true),
  };
}

function rowsToColumns(rows = []) {
  const columns = {};
  for (const row of rows) {
    if (!columns[row.table_name]) columns[row.table_name] = [];
    columns[row.table_name].push(row.column_name);
  }
  return columns;
}

function normalizeInventoryRows({ bySourceState, retained, discards, noImporta, ready, rawCoverage }) {
  return {
    alertas_by_source_state: (bySourceState || []).map((row) => ({
      fuente: boundedLabel(row.fuente, '(sin_fuente)'),
      estado_ia: boundedLabel(row.estado_ia, '(sin_estado)'),
      total: numberValue(row.total),
    })),
    retained: {
      pendiente_revision_manual: numberValue(retained?.pendiente_revision_manual),
      needs_evidence: numberValue(retained?.needs_evidence),
    },
    discards: {
      total: numberValue(discards?.total),
      structured: numberValue(discards?.structured),
      incomplete: numberValue(discards?.incomplete),
    },
    anomalies: {
      no_importa_outside_discard: numberValue(noImporta?.total),
      listo_with_discard_fields: numberValue(ready?.total),
    },
    raw_documents_coverage: (rawCoverage || []).map((row) => ({
      fuente: boundedLabel(row.fuente, '(sin_fuente)'),
      alertas: numberValue(row.alertas),
      alertas_con_raw_document: numberValue(row.alertas_con_raw_document),
      raw_documents: numberValue(row.raw_documents),
      raw_documents_con_texto: numberValue(row.raw_documents_con_texto),
      raw_documents_con_metadata_oficial: numberValue(row.raw_documents_con_metadata_oficial),
    })),
  };
}

async function collectPostgresInventory(client) {
  const connectionResult = await queryReadOnly(client, INVENTORY_SQL.connection);
  const tablesResult = await queryReadOnly(client, INVENTORY_SQL.tables, [REQUIRED_TABLES]);
  const columnsResult = await queryReadOnly(client, INVENTORY_SQL.columns, [REQUIRED_TABLES]);
  const hasMigrationTable = tablesResult.rows.some(
    (row) => row.table_schema === 'supabase_migrations' && row.table_name === 'schema_migrations'
  );
  const migrationsResult = hasMigrationTable
    ? await queryReadOnly(
      client,
      INVENTORY_SQL.migrations,
      [REQUIRED_MIGRATIONS.map((migration) => migration.version)]
    )
    : { rows: [] };
  const hasAlertas = tablesResult.rows.some(
    (row) => row.table_schema === 'public' && row.table_name === 'alertas'
  );
  const constraintResult = hasAlertas
    ? await queryReadOnly(client, INVENTORY_SQL.constraint, [REQUIRED_CONSTRAINT])
    : { rows: [] };
  const constraintRow = constraintResult.rows[0];
  const schema = buildSchemaReport({
    tables: tablesResult.rows
      .filter((row) => row.table_schema === 'public')
      .map((row) => row.table_name),
    columns: rowsToColumns(columnsResult.rows),
    migrations: migrationsResult.rows.map((row) => row.version),
    constraint: constraintRow
      ? { exists: true, validated: constraintRow.validated }
      : { exists: false, validated: false },
  });

  const requiredDataSchemaReady = schema.missing_tables.length === 0
    && schema.missing_columns.length === 0;
  if (!requiredDataSchemaReady) {
    return {
      connection: connectionReport(connectionResult.rows[0]),
      schema,
      inventory: {
        status: 'unavailable',
        reason: 'schema_not_applied',
      },
    };
  }

  const [bySourceState, retained, discards, noImporta, ready, rawCoverage] = await Promise.all([
    queryReadOnly(client, INVENTORY_SQL.alertasBySourceState),
    queryReadOnly(client, INVENTORY_SQL.retained),
    queryReadOnly(client, INVENTORY_SQL.discards),
    queryReadOnly(client, INVENTORY_SQL.noImportaOutsideDiscard),
    queryReadOnly(client, INVENTORY_SQL.readyWithDiscardFields),
    queryReadOnly(client, INVENTORY_SQL.rawCoverage),
  ]);

  return {
    connection: connectionReport(connectionResult.rows[0]),
    schema,
    inventory: {
      status: 'pass',
      ...normalizeInventoryRows({
        bySourceState: bySourceState.rows,
        retained: retained.rows[0],
        discards: discards.rows[0],
        noImporta: noImporta.rows[0],
        ready: ready.rows[0],
        rawCoverage: rawCoverage.rows,
      }),
    },
  };
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStructuredDiscard(alerta = {}) {
  const discard = alerta.decision_audit?.discard;
  return nonEmptyText(alerta.discard_reason_code)
    && nonEmptyText(alerta.discard_reason)
    && nonEmptyText(alerta.discard_stage)
    && Number.isFinite(Number(alerta.discard_confidence))
    && Number(alerta.discard_confidence) >= 0
    && Number(alerta.discard_confidence) <= 1
    && discard
    && discard.code === alerta.discard_reason_code
    && discard.reason === alerta.discard_reason
    && discard.stage === alerta.discard_stage
    && Number(discard.confidence) === Number(alerta.discard_confidence);
}

function fixtureDataInventory(fixture = {}) {
  const alertas = Array.isArray(fixture.alertas) ? fixture.alertas : [];
  const raws = Array.isArray(fixture.raw_documents) ? fixture.raw_documents : [];
  const grouped = new Map();
  for (const alerta of alertas) {
    const fuente = nonEmptyText(alerta.fuente) ? alerta.fuente.trim() : '(sin_fuente)';
    const estado = nonEmptyText(alerta.estado_ia) ? alerta.estado_ia.trim() : '(sin_estado)';
    const key = `${fuente}\u0000${estado}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  const discarded = alertas.filter((alerta) => alerta.estado_ia === 'descartado');
  const structured = discarded.filter(isStructuredDiscard).length;
  const rawCoverage = INVENTORY_SOURCES.map((fuente) => {
    const sourceAlerts = alertas.filter(
      (alerta) => String(alerta.fuente || '').toUpperCase() === fuente
    );
    const sourceRaws = raws.filter(
      (raw) => String(raw.fuente || '').toUpperCase() === fuente
    );
    const sourceAlertIds = new Set(sourceAlerts.map((alerta) => String(alerta.id)));
    const linked = new Set(
      sourceRaws
        .filter((raw) => sourceAlertIds.has(String(raw.inserted_alerta_id)))
        .map((raw) => String(raw.inserted_alerta_id))
    );
    const hasMetadata = (raw) => [raw.organismo, raw.seccion, raw.boletin, raw.id_oficial]
      .some(nonEmptyText)
      || (raw.metadata_json
        && typeof raw.metadata_json === 'object'
        && Object.keys(raw.metadata_json).length > 0);

    return {
      fuente,
      alertas: sourceAlerts.length,
      alertas_con_raw_document: linked.size,
      raw_documents: sourceRaws.length,
      raw_documents_con_texto: sourceRaws.filter((raw) => nonEmptyText(raw.texto_raw)).length,
      raw_documents_con_metadata_oficial: sourceRaws.filter(hasMetadata).length,
    };
  });

  return {
    status: 'pass',
    alertas_by_source_state: [...grouped.entries()]
      .map(([key, total]) => {
        const [fuente, estado_ia] = key.split('\u0000');
        return { fuente, estado_ia, total };
      })
      .sort((a, b) => `${a.fuente}\u0000${a.estado_ia}`.localeCompare(`${b.fuente}\u0000${b.estado_ia}`)),
    retained: {
      pendiente_revision_manual: alertas.filter(
        (alerta) => alerta.estado_ia === 'pendiente_revision_manual'
      ).length,
      needs_evidence: alertas.filter((alerta) => alerta.estado_ia === 'needs_evidence').length,
    },
    discards: {
      total: discarded.length,
      structured,
      incomplete: discarded.length - structured,
    },
    anomalies: {
      no_importa_outside_discard: alertas.filter(
        (alerta) => alerta.resumen === DISCARD_COMPATIBILITY_SUMMARY
          && alerta.estado_ia !== 'descartado'
      ).length,
      listo_with_discard_fields: alertas.filter((alerta) => alerta.estado_ia === 'listo'
        && (
          nonEmptyText(alerta.discard_reason_code)
          || nonEmptyText(alerta.discard_reason)
          || nonEmptyText(alerta.discard_stage)
          || alerta.discard_confidence !== null && alerta.discard_confidence !== undefined
          || alerta.decision_audit?.discard
        )).length,
    },
    raw_documents_coverage: rawCoverage,
  };
}

function collectFixtureInventory(corpus = {}) {
  const fixture = corpus.inventory_fixture || {};
  const schemaFixture = fixture.schema || {};
  const roleFixture = fixture.database_role || {};
  return {
    connection: {
      role: roleFixture.role || roleFixture.name || null,
      transaction_read_only: roleFixture.transaction_read_only === true,
      can_select_alertas: roleFixture.can_select_alertas === true,
      can_select_raw_documents: roleFixture.can_select_raw_documents === true,
      has_write_privileges: roleFixture.has_write_privileges === true,
    },
    schema: buildSchemaReport({
      tables: schemaFixture.tables,
      columns: schemaFixture.columns,
      migrations: schemaFixture.migrations,
      constraint: schemaFixture.constraint,
    }),
    inventory: fixtureDataInventory(fixture),
  };
}

async function collectInventoryFromPostgres(connectionString) {
  const { Client } = require('pg');
  const client = new Client({
    connectionString,
    application_name: 'ruralicos_p0_acceptance_read_only',
    statement_timeout: 30000,
    query_timeout: 45000,
  });
  await client.connect();
  try {
    return await withReadOnlyTransaction(client, collectPostgresInventory);
  } finally {
    await client.end();
  }
}

module.exports = {
  INVENTORY_SQL,
  REQUIRED_CONSTRAINT,
  assertReadOnlyStatement,
  buildSchemaReport,
  collectFixtureInventory,
  collectInventoryFromPostgres,
  collectPostgresInventory,
  fixtureDataInventory,
  isStructuredDiscard,
  normalizeInventoryRows,
  queryReadOnly,
  withReadOnlyTransaction,
};
