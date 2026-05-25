#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const { supabase } = require('../src/supabaseClient');
const { ingestKnowledgeDocument } = require('../src/mia/knowledgeIngest');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/ingest_mia_knowledge.js --file ruta.pdf --title "Manual SIGPAC" --category SIGPAC --source MAPA --url https://...',
    '',
    'Opciones:',
    '  --file             PDF, TXT o MD a ingestar',
    '  --title            Titulo del documento',
    '  --category         Categoria: SIGPAC, PAC, FEAGA, glosario...',
    '  --source           Fuente visible: MAPA, FEGA, Ruralicos...',
    '  --source-type      Tipo de fuente, por defecto manual',
    '  --url              URL oficial opcional',
    '  --date             Fecha del documento YYYY-MM-DD opcional',
    '  --version          Version opcional',
    '  --organization-id  Opcional para corpus privado de una cooperativa',
    '  --chunk-words      Palabras por chunk, defecto 500',
    '  --overlap-words    Solape entre chunks, defecto 80',
    '  --mock             Usa embeddings mock para pruebas locales',
    '  --dry-run          Extrae y trocea sin escribir en Supabase',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file || !args.title || !args.category) {
    console.error(usage());
    process.exit(1);
  }

  const filePath = path.resolve(args.file);
  const buffer = await fs.readFile(filePath);
  const result = await ingestKnowledgeDocument(supabase, {
    buffer,
    fileName: filePath,
    title: args.title,
    category: args.category,
    source: args.source || null,
    sourceType: args['source-type'] || 'manual',
    url: args.url || null,
    date: args.date || null,
    version: args.version || null,
    organizationId: args['organization-id'] ? Number(args['organization-id']) : null,
    chunkWords: args['chunk-words'],
    overlapWords: args['overlap-words'],
    useMockEmbeddings: Boolean(args.mock),
    dryRun: Boolean(args['dry-run']),
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`[mia:knowledge] ERROR: ${error.message}`);
  process.exit(1);
});
