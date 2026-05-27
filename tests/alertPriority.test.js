const assert = require('assert');
const { clasificarPrioridadAlerta } = require('../src/brain/alertPriority');

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

console.log('\n=== TESTS: alert priority ===\n');

test('concesion local de agua no sube a urgente por contener riego', () => {
  const result = clasificarPrioridadAlerta({
    titulo: 'Concesion de agua para riego en Corullon (Leon)',
    resumen_final: [
      'TIPO: agua_infraestructuras',
      'PRIORIDAD: media',
      'HECHO: La Confederacion Hidrografica publica una concesion concreta.',
    ].join('\n'),
    tipos_alerta: ['agua_infraestructuras'],
    subsectores: ['agua'],
  });

  assert.notStrictEqual(result.prioridad, 'urgente');
  assert(result.motivos.includes('expediente_individual_local'));
});

test('ayuda con plazo sigue siendo urgente', () => {
  const result = clasificarPrioridadAlerta({
    titulo: 'Convocatoria de ayudas PAC con plazo de solicitud',
    resumen_final: 'PRIORIDAD: alta\nPLAZO: hasta el 15 de junio',
    tipos_alerta: ['ayudas_subvenciones'],
  });

  assert.strictEqual(result.prioridad, 'urgente');
});

test('ficha baja reduce prioridad de aviso menor', () => {
  const result = clasificarPrioridadAlerta({
    titulo: 'Correccion de errores en anuncio agrario',
    resumen_final: 'PRIORIDAD: baja\nDETALLE: correccion menor sin plazo nuevo',
    tipos_alerta: ['normativa_general'],
  });

  assert.strictEqual(result.prioridad, 'baja');
});

console.log(`\nResultados alertPriority: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
