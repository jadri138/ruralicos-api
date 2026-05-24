const { construirDigestItems } = require('../src/mia/digestItems');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

console.log('\n=== TESTS: mia digest items ===\n');

const rows = construirDigestItems({
  digestId: 10,
  userId: 141,
  fecha: '2026-05-22',
  origen: 'pgvector_rpc',
  organizationId: 12,
  alertas: [
    {
      id: 8064,
      titulo: 'Ayudas para maquinaria agricola',
      resumen_final: 'Convocatoria para tractores.',
      similitud: 0.82,
      provincias: ['Aragon'],
      sectores: ['Agricultura'],
      tipos_alerta: ['ayudas_subvenciones'],
      fuente: 'BOA',
    },
  ],
});

assert(rows.length === 1, 'Construye una fila por alerta del digest');
assert(rows[0].item_numero === 1, 'Numera items desde 1');
assert(rows[0].alerta_id === 8064, 'Conserva alerta_id');
assert(rows[0].score === 0.82, 'Guarda score de similitud cuando existe');
assert(rows[0].motivo_seleccion === 'pgvector_rpc', 'Guarda origen de seleccion');
assert(rows[0].organization_id === 12, 'Propaga organization_id al item del digest');
assert(rows[0].tags_json.fuente === 'BOA', 'Guarda tags de trazabilidad');
assert(/tractores/i.test(rows[0].resumen_usado), 'Guarda resumen usado para MIA');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
