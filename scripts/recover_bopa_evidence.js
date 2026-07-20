#!/usr/bin/env node

require('dotenv').config();

function argumento(nombre, fallback = null) {
  const prefijo = `--${nombre}=`;
  const encontrado = process.argv.find((value) => value.startsWith(prefijo));
  return encontrado ? encontrado.slice(prefijo.length) : fallback;
}

async function main() {
  const faltan = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((key) => !process.env[key]);
  if (faltan.length) throw new Error(`Faltan variables requeridas: ${faltan.join(', ')}`);

  const fecha = argumento('fecha');
  const limit = argumento('limit', '20');
  const dryRun = !process.argv.includes('--apply');
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    throw new Error('El filtro --fecha debe usar YYYY-MM-DD');
  }

  const { supabase } = require('../src/platform/supabase');
  const {
    recuperarAlertasBopaSinEvidencia,
  } = require('../src/modules/boletines/scrapers/BOPA/bopaEvidenceRecovery');

  console.log(`[BOPA recovery] modo=${dryRun ? 'dry-run' : 'apply'} fecha=${fecha || 'todas'} limit=${limit}`);
  const resultado = await recuperarAlertasBopaSinEvidencia(supabase, {
    fecha,
    limit,
    dryRun,
  });
  console.log(JSON.stringify(resultado, null, 2));
  if (dryRun) console.log('[BOPA recovery] No se ha escrito ningún cambio. Use --apply para aplicar.');
}

main().catch((error) => {
  console.error(`[BOPA recovery] ${error.message}`);
  process.exit(1);
});
