const assert = require('assert');
const fs = require('fs');
const path = require('path');

const script = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'run_digest_workflow.js'),
  'utf8'
);

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

test('el comando historico usa el pipeline reanudable por defecto', () => {
  assert(
    script.includes('mainPipelineDriver') &&
    script.includes("appendQuery('/tareas/pipeline-tick'") &&
    script.includes('ALLOW_LEGACY_DIGEST_WORKFLOW ? mainLegacy() : mainPipelineDriver()'),
    'el cron historico debe conducir el job con checkpoints y reservar legacy para rescate'
  );
});

test('espera el tiempo suficiente cuando otro tick conserva el claim', () => {
  assert(
    script.includes('PIPELINE_DRIVER_BUSY_DELAY_MS') &&
    script.includes("tick === 'already_running' ? PIPELINE_DRIVER_BUSY_DELAY_MS"),
    'already_running debe usar una espera larga para cubrir la caducidad del heartbeat sin hacer polling agresivo'
  );
  assert(
    script.includes("tickNumber % 6 === 0"),
    'el log ocupado debe agruparse para no imprimir decenas de lineas identicas'
  );
});

test('el workflow diario ejecuta ingesta antes de IA y digest', () => {
  const scrapersIndex = script.indexOf("'/tareas/scrapers-diario'");
  const clasificarIndex = script.indexOf("'/alertas/clasificar'");
  const prepararIndex = script.indexOf("'/alertas/preparar-digest'");
  const enviarIndex = script.indexOf("'/alertas/enviar-digest'");

  assert(scrapersIndex > 0, 'debe ejecutar scrapers-diario');
  assert(clasificarIndex > scrapersIndex, 'clasificar debe ir despues de scrapers');
  assert(prepararIndex > clasificarIndex, 'preparar digest debe ir despues de IA');
  assert(enviarIndex > prepararIndex, 'enviar digest debe ir despues de preparar');
});

test('repara pendientes IA usando POST antes de clasificar', () => {
  const repairIndex = script.indexOf("'/alertas/reparar-pendientes-ia'");
  const clasificarIndex = script.indexOf("'/alertas/clasificar'");
  const methodPostIndex = script.indexOf("method: 'POST'", repairIndex);

  assert(repairIndex > 0, 'debe llamar a reparar-pendientes-ia');
  assert(methodPostIndex > repairIndex, 'reparar-pendientes-ia debe usar POST');
  assert(repairIndex < clasificarIndex, 'reparar debe ir antes de clasificar');
});

test('permite fijar fecha para pasos diarios', () => {
  assert(script.includes('const FECHA ='), 'debe leer FECHA');
  assert(script.includes('function conFecha'), 'debe tener helper conFecha');
  assert(script.includes("conFecha('/alertas/preparar-digest')"), 'preparar digest debe aceptar fecha');
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

test('activa preguntas automaticas despues del digest real', () => {
  assert(
    script.includes('/cerebro/ciclo-diario?explorar=true&dryRunExploracion=false'),
    'el ciclo posterior debe preguntar y aprender sin quedarse en simulacion'
  );
});

console.log(`\nResultados runDigestWorkflow: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
