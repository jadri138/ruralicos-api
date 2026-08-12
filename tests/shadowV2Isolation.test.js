const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const moduleDir = path.join(root, 'src', 'modules', 'alertas', 'shadow-v2');
const sources = fs.readdirSync(moduleDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => fs.readFileSync(path.join(moduleDir, name), 'utf8'))
  .join('\n');

const forbiddenImports = [
  'decision/judge',
  'candidatePipeline',
  'truthCard',
  'authority',
  'alertSelectionEngine',
  'embeddings',
  'user_memory',
  'userMemory',
];
for (const forbidden of forbiddenImports) {
  assert(!sources.includes(forbidden), `shadow-v2 no puede depender de ${forbidden}`);
}

const forbiddenWrites = [
  'digests',
  'digest_items',
  'digest_attempts',
  'digest_candidate_decisions',
  'mia_outbox',
  'users',
  'alertas',
  'raw_documents',
];
for (const table of forbiddenWrites) {
  const pattern = new RegExp(`from\\(['\"]${table}['\"]\\)[\\s\\S]{0,100}\\.(insert|update|upsert|delete)\\(`, 'i');
  assert(!pattern.test(sources), `shadow-v2 no puede escribir en ${table}`);
}

assert(!/whatsapp|ultramsg|enviarMensaje|enviarWhatsApp/i.test(sources));
assert(!/second.?opinion|disagreement|vot|reconcil|hold/i.test(sources));
assert(!/pre_score|estado_ia|taxonomy_tags|perfil_embedding/.test(sources));
const matcher = fs.readFileSync(path.join(moduleDir, 'profileMatch.js'), 'utf8');
assert(!/subscription/.test(matcher), 'subscription no puede intervenir en el cruce');

const workflow = fs.readFileSync(path.join(root, 'scripts', 'run_digest_workflow.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src', 'routes.js'), 'utf8');
assert(!/shadow-v2|shadow_v2|decision-v2|DECISION_V2/.test(workflow));
assert(!/shadow-v2|decision-v2/.test(routes));

const runner = fs.readFileSync(path.join(root, 'scripts', 'run_shadow_v2_workflow.js'), 'utf8');
assert(runner.includes("process.env.SHADOW_V2_ENABLED"));
assert(runner.includes("=== 'true'"));
assert(!/whatsapp|ultramsg|mia_outbox/i.test(runner));

const repoSource = fs.readFileSync(path.join(moduleDir, 'repository.js'), 'utf8');
for (const table of [
  'shadow_v2_alert_classifications',
  'shadow_v2_digest_runs',
  'shadow_v2_digest_items',
]) assert(repoSource.includes(table));

assert(!fs.existsSync(path.join(root, 'src', 'modules', 'alertas', 'decision-v2', 'decisionEngine.js')));

console.log('OK: aislamiento estatico, sin imports prohibidos, rutas, cron ni envios');
