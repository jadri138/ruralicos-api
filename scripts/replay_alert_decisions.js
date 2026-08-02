#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  formatReplayReport,
  runOfflineReplay,
} = require('../src/modules/alertas/decision/replay');

const DEFAULT_CORPUS_PATH = path.join(
  __dirname,
  '..',
  'tests',
  'fixtures',
  'decision',
  'golden-corpus.json'
);

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    input: DEFAULT_CORPUS_PATH,
    json: false,
    metamorphic: true,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--input') {
      const next = argv[index + 1];
      if (!next) throw new Error('Falta la ruta después de --input');
      options.input = path.resolve(next);
      index += 1;
    } else if (value === '--json') {
      options.json = true;
    } else if (value === '--no-metamorphic') {
      options.metamorphic = false;
    } else if (value === '--help' || value === '-h') {
      options.help = true;
    } else {
      throw new Error(`Argumento desconocido: ${value}`);
    }
  }
  return options;
}

function readCorpus(inputPath) {
  const absolutePath = path.resolve(inputPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  return JSON.parse(raw);
}

function helpText() {
  return [
    'Uso: node scripts/replay_alert_decisions.js [opciones]',
    '',
    'Opciones:',
    '  --input <ruta>       Corpus JSON local (por defecto, corpus dorado)',
    '  --json               Imprime el informe completo como JSON',
    '  --no-metamorphic     Omite únicamente las mutaciones de regresión',
    '  --help               Muestra esta ayuda',
    '',
    'Este comando es offline: solo lee un JSON local e imprime el resultado.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), output = console) {
  const options = parseArgs(argv);
  if (options.help) {
    output.log(helpText());
    return { exitCode: 0, report: null };
  }
  const corpus = readCorpus(options.input);
  const report = await runOfflineReplay(corpus, { metamorphic: options.metamorphic });
  output.log(options.json ? JSON.stringify(report, null, 2) : formatReplayReport(report));
  return { exitCode: report.acceptance.passed ? 0 : 1, report };
}

if (require.main === module) {
  main()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`Replay no ejecutado: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_CORPUS_PATH,
  helpText,
  main,
  parseArgs,
  readCorpus,
};
