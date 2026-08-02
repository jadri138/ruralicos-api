#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  gradeReplayReport,
} = require('../src/modules/alertas/decision/replayGrader');

function parseArgs(argv = process.argv.slice(2)) {
  const help = argv.includes('--help') || argv.includes('-h');
  if (help) return { help: true, enabled: false, input: null };
  const inputIndex = argv.indexOf('--input');
  const input = inputIndex >= 0 ? argv[inputIndex + 1] : null;
  const enabled = argv.includes('--enable');
  if (!enabled) throw new Error('El grader esta apagado: usa --enable de forma explicita');
  if (!input) throw new Error('--input es obligatorio');
  return { help: false, enabled, input: path.resolve(input) };
}

function helpText() {
  return [
    'Uso: node scripts/grade_alert_decision_replay.js --enable --input <informe-replay.json>',
    '',
    'Requiere REPLAY_GRADER_MODEL y OPENAI_API_KEY.',
    'Es una señal auxiliar: nunca cambia el OK/FALLO del replay.',
    'No ejecuta envios ni escribe en Supabase.',
  ].join('\n');
}

function buildOpenAICaller(model, dependencies = {}) {
  return async ({ input, schema }) => {
    const { llamarIA, parsearJSON } = dependencies.ia
      || require('../src/platform/ia/llamarIA');
    const previousAudit = process.env.IA_RUNS_LOG;
    process.env.IA_RUNS_LOG = 'false';
    let response;
    try {
      response = await llamarIA(
        JSON.stringify(input),
        [
          'Evalua como auditor independiente un replay de decisiones de alertas.',
          'Busca inconsistencias semanticas graves entre decisiones, mensajes, memoria y metricas.',
          'No reemplazas las reglas exactas ni decides la aceptacion.',
          'Devuelve solo el JSON del esquema indicado.',
        ].join(' '),
        model,
        {
          task: 'alert_decision_replay_grader',
          textFormat: schema,
          maxOutputTokens: 2400,
          returnMetadata: true,
        }
      );
    } finally {
      if (previousAudit === undefined) delete process.env.IA_RUNS_LOG;
      else process.env.IA_RUNS_LOG = previousAudit;
    }
    return {
      parsed: parsearJSON(response.text),
      metadata: response.metadata,
    };
  };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const output = dependencies.output || console;
  if (options.help) {
    output.log(helpText());
    return { exitCode: 0, result: null };
  }
  const model = dependencies.model || process.env.REPLAY_GRADER_MODEL;
  if (!model) throw new Error('Falta REPLAY_GRADER_MODEL; no se elige un modelo automaticamente');
  const report = JSON.parse(fs.readFileSync(options.input, 'utf8'));
  const acceptanceBefore = cloneAcceptance(report.acceptance);
  const result = await gradeReplayReport(report, {
    enabled: true,
    caller: dependencies.caller || buildOpenAICaller(model, dependencies),
  });
  if (JSON.stringify(report.acceptance) !== JSON.stringify(acceptanceBefore)) {
    throw new Error('El grader auxiliar intento alterar la aceptacion');
  }
  output.log(JSON.stringify(result, null, 2));
  return { exitCode: 0, result };
}

function cloneAcceptance(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

if (require.main === module) {
  main()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`Grader no ejecutado: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  buildOpenAICaller,
  helpText,
  main,
  parseArgs,
};
