#!/usr/bin/env node

require('dotenv').config();

const {
  normalizarLimite,
  repararDescartesHistoricos,
} = require('../src/modules/alertas/clasificacion/legacyDiscardRepair');

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
  return {
    dryRun: !argv.includes('--apply'),
    limit: normalizarLimite(valorArgumento(argv, 'limit'), 500),
  };
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
    `[legacy discard repair] mode=${options.dryRun ? 'dry-run' : 'apply'} page_size=${options.limit}`
  );
  console.log(
    '[legacy discard repair] Solo se reparan filas cuyo estado_ia ya es descartado; NO IMPORTA no se usa para inferir el estado.'
  );

  const result = await repararDescartesHistoricos(supabase, options);
  console.log(JSON.stringify(result, null, 2));
  if (options.dryRun) {
    console.log('[legacy discard repair] No se escribio ningun cambio. Use --apply para aplicar.');
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
  main,
  parsearArgumentos,
  valorArgumento,
};
