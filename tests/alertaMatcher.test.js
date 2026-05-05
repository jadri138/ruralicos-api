const assert = require('assert');
const { diagnosticarAlertaUsuario } = require('../src/utils/alertaMatcher');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

const userValladolid = {
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Valladolid'],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: { normativa_general: true, ayudas_subvenciones: true },
  },
};

test('provincias [] en alerta equivale a nacional/todas las provincias', () => {
  const alerta = {
    fuente: 'BOCYL',
    provincias: [],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, true);
});

test('BOE con provincias [] equivale a nacional', () => {
  const alerta = {
    fuente: 'BOE',
    provincias: [],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, true);
});

test('BOE con provincia concreta no pasa a otra provincia por defecto', () => {
  const alerta = {
    fuente: 'BOE',
    provincias: ['Jaen'],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'provincia_no_coincide');
});

test('marcador nacional en provincias pasa aunque haya provincia de usuario concreta', () => {
  const alerta = {
    fuente: 'BOE',
    provincias: ['nacional'],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, true);
});

test('boletin autonomico con provincia distinta no pasa filtro duro', () => {
  const alerta = {
    fuente: 'BOJA',
    provincias: ['Jaen'],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'provincia_no_coincide');
});

console.log(`\nResultados alertaMatcher: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
