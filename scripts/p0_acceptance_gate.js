#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  DEFAULT_FIXTURE_PATH,
  FOCUSED_TESTS,
  FULL_QUALITY_COMMANDS,
  MATRIX_PATH,
  REPO_ROOT,
  REQUIRED_MIGRATIONS,
} = require('./p0-acceptance/config');
const {
  collectFixtureInventory,
  collectInventoryFromPostgres,
} = require('./p0-acceptance/readOnlyInventory');
const { formatTextReport, saveReports } = require('./p0-acceptance/report');

const EXIT_CODES = Object.freeze({
  ACCEPTABLE: 0,
  CHECK_FAILED: 1,
  SCHEMA_NOT_APPLIED: 2,
  USAGE_ERROR: 3,
});

function valueArg(argv, name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const known = new Set([
    '--help',
    '--source',
    '--target',
    '--json',
    '--text',
    '--fixture',
    '--database-url-env',
  ]);
  for (const arg of argv) {
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!known.has(name)) throw new Error(`Argumento no reconocido: ${arg}`);
    if (name !== '--help' && !arg.includes('=')) {
      throw new Error(`Use ${name}=valor`);
    }
  }

  const source = valueArg(argv, 'source', 'fixture');
  const target = valueArg(argv, 'target', source === 'postgres' ? null : 'local');
  if (!['fixture', 'postgres'].includes(source)) {
    throw new Error('--source debe ser fixture o postgres');
  }
  if (source === 'fixture' && target !== 'local') {
    throw new Error('El modo fixture solo admite --target=local');
  }
  if (source === 'postgres' && target !== 'staging') {
    throw new Error('El diagnóstico PostgreSQL solo admite --target=staging; producción está bloqueada');
  }

  return {
    help: argv.includes('--help'),
    source,
    target,
    jsonPath: valueArg(argv, 'json'),
    textPath: valueArg(argv, 'text'),
    fixturePath: path.resolve(valueArg(argv, 'fixture', DEFAULT_FIXTURE_PATH)),
    databaseUrlEnv: valueArg(argv, 'database-url-env', 'P0_ACCEPTANCE_DATABASE_URL'),
  };
}

function usage() {
  return `Uso:
  npm run p0:acceptance -- --source=fixture --target=local [--json=RUTA] [--text=RUTA]
  npm run p0:acceptance -- --source=postgres --target=staging [--database-url-env=P0_ACCEPTANCE_DATABASE_URL] [--json=RUTA] [--text=RUTA]

El modo PostgreSQL exige una URL de staging en la variable indicada y rechaza
credenciales con privilegios INSERT, UPDATE, DELETE o TRUNCATE sobre alertas o
raw_documents. Todas las consultas se ejecutan dentro de una transacción READ ONLY.`;
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function displayCommand(command, args = []) {
  return [command, ...args].join(' ');
}

function runExternalCheck(check, dependencies = {}) {
  const spawn = dependencies.spawnSync || spawnSync;
  const command = check.command === 'npm' ? npmExecutable() : check.command;
  const started = Date.now();
  console.log(`\n[p0:acceptance] ${check.id}: ${displayCommand(command, check.args)}`);
  const result = spawn(command, check.args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  return {
    id: check.id,
    command: displayCommand(check.command, check.args),
    status: exitCode === 0 ? 'pass' : 'failed',
    exit_code: exitCode,
    duration_ms: Date.now() - started,
    error: result.error ? sanitizeError(result.error) : null,
  };
}

function runQualityChecks(dependencies = {}) {
  const full = FULL_QUALITY_COMMANDS.map((check) => runExternalCheck(check, dependencies));
  const focused = FOCUSED_TESTS.map((testFile) => runExternalCheck({
    id: `focused:${testFile}`,
    command: process.execPath,
    args: [testFile],
  }, dependencies));
  return [...full, ...focused];
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} fallo`);
  return result.stdout.trim();
}

function gitSnapshot() {
  const status = runGit(['status', '--porcelain', '--untracked-files=normal']);
  return {
    sha: runGit(['rev-parse', 'HEAD']),
    clean: status.length === 0,
    dirty_entries: status ? status.split(/\r?\n/).length : 0,
  };
}

function checkLocalMigrations() {
  const missing = REQUIRED_MIGRATIONS
    .filter((migration) => !fs.existsSync(
      path.join(REPO_ROOT, 'supabase', 'migrations', migration.file)
    ))
    .map((migration) => migration.file);
  return {
    status: missing.length === 0 ? 'pass' : 'schema_not_applied',
    missing_files: missing,
  };
}

function validateGuaranteeMatrix(matrix) {
  const errors = [];
  const guarantees = Array.isArray(matrix?.guarantees) ? matrix.guarantees : [];
  const coveredP0 = new Set(guarantees.map((item) => item.p0));
  for (const p0 of ['P0.1', 'P0.2', 'P0.3', 'P0.4', 'P0.5', 'P0.6', 'P0.7', 'P0.8']) {
    if (!coveredP0.has(p0)) errors.push(`sin_garantias:${p0}`);
  }
  for (const item of guarantees) {
    if (!item.id || !item.guarantee || !Array.isArray(item.tests) || item.tests.length === 0) {
      errors.push(`garantia_incompleta:${item.id || 'sin_id'}`);
      continue;
    }
    for (const test of item.tests) {
      if (!test.file || !fs.existsSync(path.join(REPO_ROOT, test.file))) {
        errors.push(`prueba_ausente:${item.id}:${test.file || 'sin_archivo'}`);
      }
    }
  }
  return {
    version: matrix?.version || null,
    status: errors.length === 0 ? 'pass' : 'failed',
    errors,
    guarantees,
  };
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error || 'error_desconocido');
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/(?:password|passwd|pwd)=[^\s;]+/gi, 'password=[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]');
}

function assessGate({ candidate, quality, matrix, localMigrations, diagnostic }) {
  const checkFailures = [];
  if (!candidate.clean) checkFailures.push('working_tree_not_clean');
  if (candidate.sha_changed) checkFailures.push('candidate_sha_changed_during_gate');
  for (const check of quality) {
    if (check.status !== 'pass') checkFailures.push(check.id);
  }
  if (matrix.status !== 'pass') checkFailures.push('guarantee_matrix_invalid');
  if (diagnostic.status === 'failed') checkFailures.push('inventory_check_failed');

  const connection = diagnostic.connection || {};
  const schema = diagnostic.schema || {};
  const inventory = diagnostic.inventory || {};
  if (connection.transaction_read_only !== true) checkFailures.push('transaction_not_read_only');
  if (connection.has_write_privileges === true) checkFailures.push('diagnostic_role_has_write_privileges');
  if (schema.status === 'pass'
    && (connection.can_select_alertas !== true || connection.can_select_raw_documents !== true)) {
    checkFailures.push('diagnostic_role_missing_select');
  }
  if (inventory.status === 'pass') {
    if (inventory.anomalies.no_importa_outside_discard > 0) {
      checkFailures.push('no_importa_outside_discard');
    }
    if (inventory.anomalies.listo_with_discard_fields > 0) {
      checkFailures.push('listo_with_discard_fields');
    }
  }

  const schemaMissing = localMigrations.status !== 'pass' || schema.status === 'schema_not_applied';
  let status = 'acceptable';
  let exitCode = EXIT_CODES.ACCEPTABLE;
  if (checkFailures.length > 0) {
    status = 'check_failed';
    exitCode = EXIT_CODES.CHECK_FAILED;
  } else if (schemaMissing) {
    status = 'schema_not_applied';
    exitCode = EXIT_CODES.SCHEMA_NOT_APPLIED;
  }

  const p07Blockers = [...checkFailures];
  if (localMigrations.status !== 'pass') p07Blockers.push('local_migration_files_missing');
  if (schema.status === 'schema_not_applied') p07Blockers.push('required_schema_not_applied');
  const pendingWork = [];
  if (inventory.status === 'pass' && inventory.discards.incomplete > 0) {
    pendingWork.push(`repair_${inventory.discards.incomplete}_incomplete_discards`);
  }
  if (schema.constraint?.exists && !schema.constraint.validated) {
    pendingWork.push('validate_alertas_structured_discard_check_before_discard_backfill');
  }

  const discardBackfillReadiness = {
    status: p07Blockers.length === 0 ? 'ready' : 'blocked',
    blockers: [...new Set(p07Blockers)],
    pending_work: pendingWork,
  };

  return {
    result: {
      status,
      acceptable: exitCode === EXIT_CODES.ACCEPTABLE,
      exit_code: exitCode,
      failures: checkFailures,
    },
    discard_backfill_readiness: discardBackfillReadiness,
    // Alias temporal para consumidores del gate anterior al plan revisado.
    p0_7_readiness: discardBackfillReadiness,
  };
}

async function loadDiagnostic(options) {
  if (options.source === 'fixture') {
    const corpus = JSON.parse(fs.readFileSync(options.fixturePath, 'utf8'));
    return {
      sourceDetails: {
        kind: 'fixture',
        target: 'local',
        fixture_version: corpus.version,
        fixture_path: path.relative(REPO_ROOT, options.fixturePath).replace(/\\/g, '/'),
      },
      diagnostic: {
        status: 'pass',
        ...collectFixtureInventory(corpus),
      },
    };
  }

  const connectionString = process.env[options.databaseUrlEnv];
  if (!connectionString) {
    throw new Error(`Falta la variable ${options.databaseUrlEnv} con la URL read-only de staging`);
  }
  const collected = await collectInventoryFromPostgres(connectionString);
  return {
    sourceDetails: {
      kind: 'postgres',
      target: 'staging',
      database_url_env: options.databaseUrlEnv,
    },
    diagnostic: {
      status: 'pass',
      ...collected,
    },
  };
}

async function runGate(options, dependencies = {}) {
  const started = Date.now();
  const candidateStart = (dependencies.gitSnapshot || gitSnapshot)();
  const matrixRaw = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  const matrix = validateGuaranteeMatrix(matrixRaw);
  const localMigrations = checkLocalMigrations();
  const quality = (dependencies.runQualityChecks || runQualityChecks)(dependencies);

  let sourceDetails = { kind: options.source, target: options.target };
  let diagnostic;
  try {
    const loaded = await (dependencies.loadDiagnostic || loadDiagnostic)(options);
    sourceDetails = loaded.sourceDetails;
    diagnostic = loaded.diagnostic;
  } catch (error) {
    diagnostic = {
      status: 'failed',
      error: sanitizeError(error),
      connection: {
        role: null,
        transaction_read_only: false,
        can_select_alertas: false,
        can_select_raw_documents: false,
        has_write_privileges: null,
      },
      schema: {
        status: 'check_failed',
        missing_tables: [],
        missing_columns: [],
        missing_migrations: [],
        constraint: {
          name: 'alertas_structured_discard_check',
          exists: false,
          validated: false,
        },
      },
      inventory: { status: 'failed', error: sanitizeError(error) },
    };
  }

  const candidateEnd = (dependencies.gitSnapshot || gitSnapshot)();
  const candidate = {
    sha: candidateStart.sha,
    clean: candidateStart.clean && candidateEnd.clean,
    dirty_entries: Math.max(candidateStart.dirty_entries, candidateEnd.dirty_entries),
    sha_changed: candidateStart.sha !== candidateEnd.sha,
  };
  const assessment = assessGate({
    candidate,
    quality,
    matrix,
    localMigrations,
    diagnostic,
  });

  return {
    schema_version: 'p0_acceptance_report_v1',
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    candidate,
    source: sourceDetails,
    result: assessment.result,
    discard_backfill_readiness: assessment.discard_backfill_readiness,
    p0_7_readiness: assessment.p0_7_readiness,
    checks: {
      quality,
      local_migrations: localMigrations,
    },
    guarantee_matrix: matrix,
    diagnostic,
    privacy: {
      aggregate_counts_only: true,
      secrets_included: false,
      full_personal_content_included: false,
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return EXIT_CODES.ACCEPTABLE;
    }
  } catch (error) {
    console.error(`[p0:acceptance] ${sanitizeError(error)}`);
    console.error(usage());
    return EXIT_CODES.USAGE_ERROR;
  }

  const report = await runGate(options);
  console.log(`\n${formatTextReport(report)}`);
  const written = saveReports(report, options);
  if (written.json) console.log(`[p0:acceptance] JSON: ${written.json}`);
  if (written.text) console.log(`[p0:acceptance] Texto: ${written.text}`);
  return report.result.exit_code;
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`[p0:acceptance] ${sanitizeError(error)}`);
      process.exitCode = EXIT_CODES.CHECK_FAILED;
    });
}

module.exports = {
  EXIT_CODES,
  assessGate,
  checkLocalMigrations,
  gitSnapshot,
  loadDiagnostic,
  main,
  parseArgs,
  runExternalCheck,
  runGate,
  runQualityChecks,
  sanitizeError,
  usage,
  validateGuaranteeMatrix,
  valueArg,
};
