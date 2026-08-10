const assert = require('assert');
const fs = require('fs');
const path = require('path');

const script = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'run_digest_workflow.js'),
  'utf8'
);
const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes.js'), 'utf8');
const decisionRoute = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'modules', 'alertas', 'decision-v2', 'decisionV2.routes.js'),
  'utf8'
);

console.log('\n=== TESTS: fase diaria decision-v2 shadow ===\n');

assert(script.includes("const RUN_DECISION_V2_SHADOW = parseBool(process.env.RUN_DECISION_V2_SHADOW, false)"));
assert(script.includes('const DECISION_V2_SHADOW_RUN_KEY ='));
assert(script.includes("'decision-v2-shadow'"));
assert(script.includes("conFecha('/alertas/decision-v2-shadow')"));
assert(script.includes('run_key: DECISION_V2_SHADOW_RUN_KEY'));
assert(script.includes("{ method: 'POST' }"));

const recoveryIndex = script.indexOf('const holdEvidenceRecovery = await runHoldEvidenceRecoveryStep()');
const shadowIndex = script.indexOf('const decisionV2Shadow = RUN_DECISION_V2_SHADOW');
const prepareIndex = script.indexOf('const rutaPrepararDigest =');
const sendIndex = script.indexOf("'/alertas/enviar-digest'");
assert(recoveryIndex > 0 && shadowIndex > recoveryIndex);
assert(prepareIndex > shadowIndex);
assert(sendIndex > prepareIndex);

const helperStart = script.indexOf('async function runOptionalBatchedStep');
const helperEnd = script.indexOf('async function runHoldEvidenceRecoveryStep');
const helper = script.slice(helperStart, helperEnd);
assert(helper.includes('try {'));
assert(helper.includes('catch (err)'));
assert(helper.includes('skipped: true'));
assert(script.includes("reason: 'decision_v2_shadow_desactivado'"));
assert(routes.includes("require('./modules/alertas/decision-v2/decisionV2.routes')"));
assert(routes.includes('decisionV2Routes(app, supabase)'));
assert(decisionRoute.includes("app.post('/alertas/decision-v2-shadow'"));
assert(decisionRoute.includes('DECISION_V2_SHADOW_ENABLED'));
assert(decisionRoute.includes('checkCronToken'));

console.log('OK: la fase esta apagada por defecto y usa una clave idempotente por ejecucion');
console.log('OK: se drena antes del digest real y su fallo queda aislado del envio');
console.log('\nResultados decisionV2Workflow: 2 aprobados, 0 fallidos');
