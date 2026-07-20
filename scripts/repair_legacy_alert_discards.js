#!/usr/bin/env node

// Uso: npm run repair:legacy-discards -- [--apply] [--page-size=500]
// --page-size solo controla cada pagina de lectura; siempre se recorre todo el historico.

require('dotenv').config();

const {
  normalizarTamanoPagina,
  repararDescartesHistoricos,
} = require('../src/modules/alertas/clasificacion/legacyDiscardRepair');

const VALIDATION_SQL_PATH = 'scripts/sql/validate_alert_discard_constraint.sql';

function valorArgumento(argv, name) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')
    ? argv[index + 1]
    : null;
}

function parsearArgumentos(argv = process.argv.slice(2)) {
  if (argv.some((arg) => arg === '--limit' || arg.startsWith('--limit='))) {
    throw new Error('--limit ya no existe: use --page-size; solo controla la paginacion, no el total.');
  }
  return {
    dryRun: !argv.includes('--apply'),
    pageSize: normalizarTamanoPagina(valorArgumento(argv, 'page-size'), 500),
  };
}

function puedeValidarConstraint(options, result) {
  return options.dryRun === false
    && Array.isArray(result.failed)
    && result.failed.length === 0
    && result.repaired === result.repairable;
}

async function main(argv = process.argv.slice(2)) {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(
    (name) => !process.env[name]
  );
  if (required.length > 0) {
    throw new Error(`Faltan variables requeridas: ${required.join(', ')}`);
  }

  const options = parsearArgumentos(argv);
  const { supabase } = require('../src/platform/supabase');
  console.log(
    `[legacy discard repair] mode=${options.dryRun ? 'dry-run' : 'apply'} page_size=${options.pageSize}`
  );
  console.log(
    '[legacy discard repair] Solo se reparan filas cuyo estado_ia ya es descartado; NO IMPORTA no se usa para inferir el estado.'
  );

  const result = await repararDescartesHistoricos(supabase, options);
  console.log(JSON.stringify(result, null, 2));
  if (options.dryRun) {
    console.log('[legacy discard repair] No se escribio ningun cambio. Use --apply para aplicar.');
  } else if (puedeValidarConstraint(options, result)) {
    console.log(
      `[legacy discard repair] Reparacion finalizada sin fallos. Revise y ejecute ${VALIDATION_SQL_PATH} para validar la constraint.`
    );
  }
  if (result.failed.length > 0) process.exitCode = 1;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[legacy discard repair] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  VALIDATION_SQL_PATH,
  main,
  parsearArgumentos,
  puedeValidarConstraint,
  valorArgumento,
};
