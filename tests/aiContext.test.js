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
  'src/modules/tareas/README.md',
];

for (const relativePath of currentDocs) {
  const content = read(relativePath);
  assert.ok(
    content.includes(workflowCommand),
    `${relativePath} debe nombrar el único workflow de producción`
  );
}

for (const removedPath of [
  'src/modules/tareas/pipelineRunner.js',
  'src/modules/tareas/pipelineJobs.js',
  'scripts/repair_stale_pipeline_jobs.js',
]) {
  assert.ok(!fs.existsSync(path.join(root, removedPath)), `No debe volver el componente retirado: ${removedPath}`);
}

const tareasRoutes = read('src/modules/tareas/tareas.routes.js');
assert.ok(!tareasRoutes.includes("app.all('/tareas/pipeline-tick'"), 'no debe volver la ruta del runner retirado');
assert.ok(!tareasRoutes.includes("app.get('/tareas/pipeline-diario'"), 'no debe volver el monolito duplicado');

const removedRouteSources = [
  read('src/modules/alertas/alertas.routes.js'),
  read('src/modules/feedback/feedback.routes.js'),
  read('src/modules/embeddings/embeddings.routes.js'),
  read('src/modules/usuarios/userAuth.routes.js'),
].join('\n');
for (const removedRoute of [
  '/alertas/enviar-whatsapp',
  '/feedback/enviar-digest-prueba',
  '/feedback/simular-respuesta',
  '/embeddings/test',
  '/first-login',
]) {
  assert.ok(!removedRouteSources.includes(removedRoute), `No debe volver el endpoint retirado: ${removedRoute}`);
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
const orderedWorkflowTokens = [
  ['/tareas/scrapers-diario', '/tareas/scrapers-diario'],
  ['/alertas/clasificar', '/alertas/clasificar'],
  ['/alertas/resumir', '/alertas/resumir'],
  ['/alertas/revisar', '/alertas/revisar'],
  ['/alertas/deduplicar', '/alertas/deduplicar'],
  ['/tareas/hold-evidence-recovery', 'const holdEvidenceRecovery = await runHoldEvidenceRecoveryStep()'],
  ['/alertas/preparar-digest', '/alertas/preparar-digest'],
  ['/alertas/enviar-digest', '/alertas/enviar-digest'],
  ['/alertas/generar-resumen-free', '/alertas/generar-resumen-free'],
  ['/alertas/enviar-resumen-free', '/alertas/enviar-resumen-free'],
];

const mainIndex = workflow.indexOf('async function main()');
let previousIndex = -1;
for (const [endpoint, token] of orderedWorkflowTokens) {
  const currentIndex = workflow.indexOf(token, mainIndex);
  assert.ok(currentIndex > previousIndex, `Orden del workflow inesperado en ${endpoint}`);
  previousIndex = currentIndex;
}

const v2ShadowIndex = workflow.indexOf('shadowV2 = await runShadowV2Step()', mainIndex);
const promoteV2Index = workflow.indexOf('/tareas/promover-digest-v2', v2ShadowIndex);
const enqueueIndex = workflow.indexOf('/alertas/enviar-digest', promoteV2Index);
assert.ok(v2ShadowIndex > 0 && promoteV2Index > v2ShadowIndex && enqueueIndex > promoteV2Index,
  'V2 debe completar shadow, promover y solo despues encolar');

const v1AuditIndex = workflow.indexOf("if (DIGEST_ENGINE === 'v1')", enqueueIndex);
assert.ok(v1AuditIndex > enqueueIndex, 'V1 debe conservar shadow como auditoria posterior');

console.log('✓ Contexto para IA coherente con el workflow y las rutas vigentes');
