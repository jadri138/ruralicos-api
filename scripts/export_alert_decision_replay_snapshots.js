#!/usr/bin/env node

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  buildHistoricalReplayCorpus,
  collectHistoricalReplayRows,
} = require('../src/modules/alertas/decision/replaySnapshotExporter');

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseArgs(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const from = valueAfter(argv, '--from');
  const to = valueAfter(argv, '--to');
  const output = valueAfter(argv, '--output');
  const signalThrough = valueAfter(argv, '--signal-through') || (validDay(to) ? addDays(to, 14) : null);
  const maxRows = Number(valueAfter(argv, '--max-rows') || 20000);
  if (!validDay(from) || !validDay(to) || from > to) {
    throw new Error('--from y --to deben ser fechas validas YYYY-MM-DD y estar ordenadas');
  }
  if (!validDay(signalThrough) || signalThrough < to) {
    throw new Error('--signal-through debe ser una fecha igual o posterior a --to');
  }
  if (!output) throw new Error('--output es obligatorio');
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100000) {
    throw new Error('--max-rows debe ser un entero entre 1 y 100000');
  }
  return {
    help: false,
    from,
    to,
    signalThrough,
    output: path.resolve(output),
    maxRows,
  };
}

function helpText() {
  return [
    'Uso: node scripts/export_alert_decision_replay_snapshots.js --from YYYY-MM-DD --to YYYY-MM-DD --output <archivo.json>',
    '',
    'Opciones:',
    '  --signal-through YYYY-MM-DD   Incluye clics/feedback posteriores (por defecto, 14 dias)',
    '  --max-rows N                  Limite por tabla (por defecto, 20000)',
    '  --help                        Muestra esta ayuda',
    '',
    'Solo lee Supabase. El archivo local se crea sin sobrescribir y no contiene PII directa.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const output = dependencies.output || console;
  if (options.help) {
    output.log(helpText());
    return { exitCode: 0, corpus: null };
  }
  if (fs.existsSync(options.output)) {
    throw new Error(`El archivo ya existe y no se sobrescribira: ${options.output}`);
  }
  const directory = path.dirname(options.output);
  if (!fs.existsSync(directory)) throw new Error(`La carpeta de salida no existe: ${directory}`);
  const client = dependencies.client || require('../src/platform/supabase').supabase;
  const rows = await collectHistoricalReplayRows({
    client,
    from: options.from,
    to: options.to,
    signalThrough: `${options.signalThrough}T23:59:59.999Z`,
    maxRows: options.maxRows,
  });
  const corpus = buildHistoricalReplayCorpus(rows, {
    from: options.from,
    to: options.to,
    signalThrough: options.signalThrough,
    generatedAt: new Date().toISOString(),
    salt: dependencies.salt || process.env.REPLAY_EXPORT_SALT || crypto.randomBytes(32).toString('hex'),
  });
  fs.writeFileSync(options.output, `${JSON.stringify(corpus, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  output.log(`Snapshot local creado: ${options.output}`);
  output.log(`Casos: ${corpus.cases.length}; perfiles: ${corpus.profiles.length}`);
  return { exitCode: 0, corpus };
}

if (require.main === module) {
  main()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`Snapshot no creado: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  addDays,
  helpText,
  main,
  parseArgs,
};
