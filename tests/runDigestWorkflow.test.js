const assert = require('assert');
const fs = require('fs');
const path = require('path');

const script = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'run_digest_workflow.js'),
  'utf8'
).replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

console.log('\n=== TESTS: run digest workflow script ===\n');

test('el comando del cron ejecuta el workflow completo directamente', () => {
  assert(
    script.includes('async function main()') &&
    script.includes('main().catch') &&
    !script.includes('already_running'),
    'el cron debe ejecutar las fases directamente'
  );
});

test('el workflow diario ejecuta ingesta antes de IA y digest', () => {
  const scrapersIndex = script.indexOf("'/tareas/scrapers-diario'");
  const clasificarIndex = script.indexOf("'/alertas/clasificar'");
  const recoveryIndex = script.indexOf('const holdEvidenceRecovery = await runHoldEvidenceRecoveryStep()');
  const prepararIndex = script.indexOf("'/alertas/preparar-digest'");
  const enviarIndex = script.indexOf("'/alertas/enviar-digest'");
  const outboxIndex = script.indexOf('const entregarOutbox = await runOutboxStep()', enviarIndex);

  assert(scrapersIndex > 0, 'debe ejecutar scrapers-diario');
  assert(clasificarIndex > scrapersIndex, 'clasificar debe ir despues de scrapers');
  assert(recoveryIndex > clasificarIndex, 'la recuperacion de HOLD debe ir despues de procesar alertas');
  assert(prepararIndex > recoveryIndex, 'preparar digest debe reevaluar despues de recuperar evidencia');
  assert(enviarIndex > prepararIndex, 'enviar digest debe ir despues de preparar');
  assert(outboxIndex > enviarIndex, 'la cola debe drenarse despues de encolar el digest');
});

test('recupera HOLD de forma acotada dentro del unico workflow', () => {
  const helperIndex = script.indexOf('async function runHoldEvidenceRecoveryStep');
  const routeIndex = script.indexOf('`/tareas/hold-evidence-recovery?limit=${safeLimit}&concurrency=${safeConcurrency}`');
  const recoveryIndex = script.indexOf('const holdEvidenceRecovery = await runHoldEvidenceRecoveryStep()');
  const prepararIndex = script.indexOf("'/alertas/preparar-digest'");
  const helper = script.slice(helperIndex, recoveryIndex);
  assert(recoveryIndex > 0 && recoveryIndex < prepararIndex, 'la fase debe ejecutarse justo antes de preparar');
  assert(helperIndex > 0 && routeIndex > helperIndex, 'debe existir un drenaje dedicado para HOLD');
  assert(helper.includes("method: 'POST'"), 'la fase protegida que persiste estado debe usar POST');
  assert(helper.includes('processed < safeLimit || !hasMore'), 'debe parar al recibir un lote corto');
  assert(helper.includes('loops <= safeMaxLoops'), 'debe limitar el nÃºmero de vueltas');
  assert(helper.includes('body?.has_more'), 'debe respetar la seÃ±al has_more del endpoint');
  assert(!script.slice(recoveryIndex, prepararIndex).includes('runOptionalStep'), 'un fallo sistemico de recuperacion debe ser visible');
});

test('repara pendientes IA usando POST antes de clasificar', () => {
  const repairIndex = script.indexOf("'/alertas/reparar-pendientes-ia'");
  const clasificarIndex = script.indexOf("'/alertas/clasificar'");
  const methodPostIndex = script.indexOf("method: 'POST'", repairIndex);

  assert(repairIndex > 0, 'debe llamar a reparar-pendientes-ia');
  assert(methodPostIndex > repairIndex, 'reparar-pendientes-ia debe usar POST');
  assert(repairIndex < clasificarIndex, 'reparar debe ir antes de clasificar');
});

test('usa POST en todas las fases que modifican datos o envían mensajes', () => {
  for (const name of [
    'clasificar',
    'resumir',
    'revisar',
    'deduplicar',
    'preparar-digest',
    'enviar-digest',
    'generar-resumen-free',
    'enviar-resumen-free',
  ]) {
    const routeIndex = script.indexOf(`'/alertas/${name}'`);
    const call = routeIndex >= 0 ? script.slice(routeIndex, routeIndex + 250) : '';
    assert(call.includes("method: 'POST'"), `${name} debe usar POST`);
  }
});

test('permite fijar fecha para pasos diarios', () => {
  assert(script.includes('const FECHA ='), 'debe leer FECHA');
  assert(script.includes('function conFecha'), 'debe tener helper conFecha');
  assert(script.includes("conFecha('/alertas/preparar-digest')"), 'preparar digest debe aceptar fecha');
});

test('permite reintentar el mismo dia sin desplegar una version nueva', () => {
  assert(
    script.includes('const PREPARAR_DIGEST_FORCE = parseBool(process.env.PREPARAR_DIGEST_FORCE, false)'),
    'debe existir el interruptor y estar apagado por defecto'
  );
  assert(
    script.includes("appendQuery(rutaPrepararDigest, { force: 'true' })"),
    'encendido debe pedir la reevaluacion al endpoint'
  );
  // Apagado, la ruta no lleva force: el comportamiento diario no cambia.
  assert(
    /PREPARAR_DIGEST_FORCE\s*\n?\s*\?\s*appendQuery/.test(script),
    'sin el interruptor se usa la ruta normal'
  );
});

test('permite completar la preparacion segura usuario a usuario', () => {
  assert(
    script.includes('const PREPARAR_DIGEST_MAX_LOOPS = Number(process.env.PREPARAR_DIGEST_MAX_LOOPS || 200)'),
    'preparar digest necesita mas vueltas que el resto de fases'
  );
  assert(
    script.includes('PREPARAR_DIGEST_MAX_LOOPS\n  );'),
    'la preparacion debe usar su limite especifico'
  );
});

test('muestra cuantas propuestas reales produjo la preparacion', () => {
  assert(
    script.includes("'digests_generados'") && script.includes("'rescates_generados'"),
    'debe acumular digests normales y rescates'
  );
  assert(
    script.includes('[digest-silence] Se evaluaron usuarios pero no se creo ningun digest'),
    'debe avisar de forma visible cuando procesa usuarios sin crear digests'
  );
  assert(
    script.includes('usuarios_evaluados: prepararDigest?.totalProgress ?? null'),
    'el resumen debe separar usuarios evaluados de digests generados'
  );
});

test('reconoce el campo success del envio free', () => {
  assert(
    script.includes('enviarFree?.success ?? enviarFree?.ok ?? null'),
    'el resumen final debe reflejar correctamente el envio free'
  );
});

test('no crea un segundo emisor MIA y drena la unica cola', () => {
  assert(
    script.includes('/tareas/mia-outbox?limit=') &&
      !script.includes('/cerebro/ciclo-diario?explorar=true&dryRunExploracion=false'),
    'las comunicaciones automaticas deben salir por una sola cola'
  );
  assert(
    script.includes('maxRetries: 0'),
    'el workflow no debe repetir a ciegas una peticion que puede haber enviado mensajes'
  );
  assert(
    script.includes("'/tareas/whatsapp-reconcile?limit=100'") &&
      script.indexOf("'/tareas/whatsapp-reconcile?limit=100'") >
        script.indexOf('const entregarOutbox = await runOutboxStep()'),
    'la conciliacion debe formar parte del mismo workflow y ejecutarse tras la cola'
  );
  const reconcileIndex = script.indexOf("'/tareas/whatsapp-reconcile?limit=100'");
  const explorationIndex = script.indexOf("'/cerebro/exploracion-diaria?limit=100'");
  const explorationCall = script.slice(explorationIndex, explorationIndex + 180);
  const selectiveDrainIndex = script.indexOf('const entregarPreguntasExploracion', explorationIndex);
  assert(explorationIndex > reconcileIndex, 'la exploracion selectiva debe ejecutarse tras conciliar el digest');
  assert(
    explorationCall.includes("method: 'POST'") && explorationCall.includes('maxRetries: 0'),
    'la fase selectiva debe encolar por POST sin reintentos HTTP a ciegas'
  );
  assert(
    selectiveDrainIndex > explorationIndex &&
      script.includes('Number(exploracionDiaria?.encoladas || 0) > 0'),
    'solo debe volver a drenar la misma cola cuando haya preguntas nuevas'
  );
});

console.log(`\nResultados runDigestWorkflow: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
