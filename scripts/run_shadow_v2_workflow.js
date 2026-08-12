#!/usr/bin/env node
require('dotenv').config();

const crypto = require('crypto');
const { getFechaMadridISO } = require('../src/shared/fechaMadrid');
const { runShadowV2Workflow } = require('../src/modules/alertas/shadow-v2/workflow');

function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.map((argument) => {
    const match = String(argument).match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Argumento invalido: ${argument}. Usa --nombre=valor.`);
    return [match[1], match[2]];
  }));
}

function enabled() {
  return String(process.env.SHADOW_V2_ENABLED || '').trim().toLowerCase() === 'true';
}

async function main() {
  if (!enabled()) {
    throw new Error('shadow-v2 esta apagado. Define SHADOW_V2_ENABLED=true solo para una ejecucion manual.');
  }
  const args = parseArgs();
  const { supabase } = require('../src/platform/supabase');
  const result = await runShadowV2Workflow({
    supabase,
    workflowDate: args.date || getFechaMadridISO(),
    workflowRunKey: args['run-key'] || crypto.randomUUID(),
    limitOverrides: {
      maxAlerts: args['max-alerts'],
      maxUsers: args['max-users'],
      maxCandidatesPerUser: args['max-candidates'],
      maxTotalCalls: args['max-calls'],
      maxOfficialCharsPerAlert: args['max-official-chars'],
      maxPersonalPromptChars: args['max-personal-prompt-chars'],
      maxSelected: args['max-selected'],
    },
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.stopped) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[shadow-v2] ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, enabled, main };
