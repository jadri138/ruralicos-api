// scripts/run_tests.js
//
// Runner de la suite local: descubre y ejecuta todos los tests/*.test.js en
// procesos separados (mismo aislamiento que la antigua cadena de `&&` del
// package.json, que había que mantener a mano y ya había dejado ficheros
// huérfanos sin ejecutar). Uso:
//   node scripts/run_tests.js            → toda la suite
//   node scripts/run_tests.js mia        → solo los que contengan "mia"

const { readdirSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const testsDir = path.join(__dirname, '..', 'tests');
const filtro = (process.argv[2] || '').toLowerCase();

const ficheros = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => !filtro || name.toLowerCase().includes(filtro))
  .sort();

if (ficheros.length === 0) {
  console.error(`No hay tests que coincidan con "${filtro}" en tests/`);
  process.exit(1);
}

const inicio = Date.now();
const fallos = [];

for (const fichero of ficheros) {
  const resultado = spawnSync(process.execPath, [path.join(testsDir, fichero)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (resultado.status !== 0) fallos.push(fichero);
}

const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
console.log(`\n${'='.repeat(60)}`);
console.log(`Suite: ${ficheros.length} ficheros en ${segundos}s — ${fallos.length === 0 ? 'TODO OK' : `${fallos.length} CON FALLOS`}`);
for (const fichero of fallos) console.log(`  FALLO: ${fichero}`);
process.exit(fallos.length === 0 ? 0 : 1);
