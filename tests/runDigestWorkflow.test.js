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

console.log(`\nResultados runDigestWorkflow: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
