const assert = require('assert');
const {
  canonicalSector,
  canonicalSubsector,
  canonicalTipoAlerta,
  normalizarPreferenciasUsuario,
} = require('../src/utils/preferenceCanonical');

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

console.log('\n=== TESTS: preference canonical ===\n');

test('canoniza aliases frecuentes de sectores, subsectores y tipos', () => {
  assert.strictEqual(canonicalSector('agrícola'), 'agricultura');
  assert.strictEqual(canonicalSector('ganadera'), 'ganaderia');
  assert.strictEqual(canonicalSubsector('frutal'), 'frutales');
  assert.strictEqual(canonicalSubsector('medio ambiente'), 'medio_ambiente');
  assert.strictEqual(canonicalSubsector('regadío'), 'agua');
  assert.strictEqual(canonicalSubsector('bienestar animal'), 'bienestar_animal');
  assert.strictEqual(canonicalTipoAlerta('normativa'), 'normativa_general');
  assert.strictEqual(canonicalTipoAlerta('plazo'), 'plazos');
  assert.strictEqual(canonicalTipoAlerta('agua_infraestructura'), 'agua_infraestructuras');
  assert.strictEqual(canonicalTipoAlerta('seguro agrario'), 'seguros_agrarios');
});

test('normaliza preferencias de usuario sin duplicados ni valores desconocidos', () => {
  const result = normalizarPreferenciasUsuario({
    provincias: [' Teruel ', 'Teruel', 'Huesca'],
    sectores: ['Agrícola', 'agricultura', 'ganadera', 'basura'],
    subsectores: ['Frutal', 'frutales', 'Medio ambiente', 'regadío', 'desconocido'],
    tipos_alerta: {
      normativa: true,
      plazo: true,
      ayudas: true,
      random: true,
      formacion: false,
    },
  });

  assert.deepStrictEqual(result.provincias, ['Teruel', 'Huesca']);
  assert.deepStrictEqual(result.sectores, ['agricultura', 'ganaderia']);
  assert.deepStrictEqual(result.subsectores, ['frutales', 'medio_ambiente', 'agua']);
  assert.deepStrictEqual(result.tipos_alerta, {
    normativa_general: true,
    plazos: true,
    ayudas_subvenciones: true,
  });
});

console.log(`\nResultados preferenceCanonical: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
