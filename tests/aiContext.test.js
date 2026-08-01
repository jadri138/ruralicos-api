const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.ok(fs.existsSync(absolutePath), `Falta el archivo canónico: ${relativePath}`);
  return fs.readFileSync(absolutePath, 'utf8');
}

const workflowCommand = 'node scripts/run_digest_workflow.js';
const currentDocs = [
  'AGENTS.md',
  'README.md',
  'docs/AI_CONTEXT.md',
  'docs/ARQUITECTURA.md',
  'docs/cron_digest_setup.md',
  'docs/cron_complementarios_setup.md',
  'src/modules/tareas/README.md',
];

for (const relativePath of currentDocs) {
  const content = read(relativePath);
  assert.ok(
    content.includes(workflowCommand),
    `${relativePath} debe nombrar el único workflow de producción`
  );
}

for (const relativePath of currentDocs) {
  const content = read(relativePath);
  assert.ok(
    !/(?:curl|node)[^\n]*\/tareas\/pipeline-tick/i.test(content),
    `${relativePath} no debe presentar pipeline-tick como comando ejecutable`
  );
}

const aiContext = read('docs/AI_CONTEXT.md');
for (const requiredFact of [
  'digest_candidate_decisions',
  'user_conversations',
  'message_type="digest_pro"',
  'subscription="cooperativa"',
  'Europe/Madrid',
  'diagnosticarAlertaUsuario',
  'prepararDigestHandler',
  'enviarDigestHandler',
]) {
  assert.ok(aiContext.includes(requiredFact), `AI_CONTEXT debe conservar la advertencia: ${requiredFact}`);
}

for (const requiredPath of [
  'scripts/run_digest_workflow.js',
  'src/routes.js',
  'src/modules/alertas/seleccion/alertaMatcher.js',
  'src/modules/alertas/seleccion/alertSelectionEngine.js',
  'src/modules/digest/digest.routes.js',
  'src/modules/digest/digest.service.js',
]) {
  assert.ok(fs.existsSync(path.join(root, requiredPath)), `AI_CONTEXT apunta a una ruta inexistente: ${requiredPath}`);
}

const workflow = read('scripts/run_digest_workflow.js');
const orderedEndpoints = [
  '/tareas/scrapers-diario',
  '/alertas/clasificar',
  '/alertas/resumir',
  '/alertas/revisar',
  '/alertas/deduplicar',
  '/alertas/preparar-digest',
  '/alertas/enviar-digest',
  '/alertas/generar-resumen-free',
  '/alertas/enviar-resumen-free',
];

let previousIndex = -1;
for (const endpoint of orderedEndpoints) {
  const currentIndex = workflow.indexOf(endpoint);
  assert.ok(currentIndex > previousIndex, `Orden del workflow inesperado en ${endpoint}`);
  previousIndex = currentIndex;
}

console.log('✓ Contexto para IA coherente con el workflow y las rutas vigentes');
