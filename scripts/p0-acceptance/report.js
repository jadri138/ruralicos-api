const fs = require('fs');
const path = require('path');

function lineValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function formatList(values = []) {
  return values.length > 0 ? values.join(', ') : 'ninguno';
}

function formatTextReport(report) {
  const lines = [
    'RURALICOS P0 - GATE INTEGRAL DE ACEPTACION',
    '='.repeat(49),
    `Resultado: ${report.result.status}`,
    `Aceptable: ${report.result.acceptable ? 'si' : 'no'}`,
    `Codigo de salida: ${report.result.exit_code}`,
    `SHA: ${report.candidate.sha}`,
    `Arbol limpio: ${report.candidate.clean ? 'si' : 'no'}`,
    `Fuente del inventario: ${report.source.kind} (${report.source.target})`,
    `Generado: ${report.generated_at}`,
    '',
    'COMPROBACIONES DE CALIDAD',
    '-'.repeat(27),
  ];

  for (const check of report.checks.quality) {
    lines.push(
      `${check.status === 'pass' ? 'OK' : 'FALLO'} ${check.id} `
      + `(${check.duration_ms} ms, exit=${lineValue(check.exit_code)})`
    );
  }

  lines.push(
    '',
    'MATRIZ GARANTIA -> PRUEBA',
    '-'.repeat(26),
    `Estado: ${report.guarantee_matrix.status}`
  );
  for (const guarantee of report.guarantee_matrix.guarantees) {
    const testFiles = [...new Set(guarantee.tests.map((test) => test.file))];
    lines.push(`${guarantee.id}: ${guarantee.guarantee}`);
    lines.push(`  Pruebas: ${testFiles.join(', ')}`);
  }

  const schema = report.diagnostic.schema;
  lines.push(
    '',
    'ESQUEMA Y MIGRACIONES',
    '-'.repeat(21),
    `Estado: ${schema.status}`,
    `Ficheros de migración locales ausentes: ${formatList(report.checks.local_migrations.missing_files)}`,
    `Tablas ausentes: ${formatList(schema.missing_tables)}`,
    `Columnas ausentes: ${formatList(schema.missing_columns)}`,
    `Migraciones ausentes: ${formatList(schema.missing_migrations)}`,
    `Constraint ${schema.constraint.name}: ${schema.constraint.exists ? 'existe' : 'ausente'}, `
      + `${schema.constraint.validated ? 'validada' : 'no validada'}`,
    '',
    'CONEXION DE DIAGNOSTICO',
    '-'.repeat(23),
    `Rol: ${lineValue(report.diagnostic.connection.role)}`,
    `Transaccion READ ONLY: ${report.diagnostic.connection.transaction_read_only ? 'si' : 'no'}`,
    `Privilegios de escritura detectados: ${report.diagnostic.connection.has_write_privileges ? 'si' : 'no'}`
  );

  const inventory = report.diagnostic.inventory;
  lines.push('', 'INVENTARIO DE SOLO LECTURA', '-'.repeat(26), `Estado: ${inventory.status}`);
  if (inventory.status === 'pass') {
    lines.push('Alertas por fuente y estado:');
    for (const item of inventory.alertas_by_source_state) {
      lines.push(`  ${item.fuente} | ${item.estado_ia}: ${item.total}`);
    }
    lines.push(
      `pendiente_revision_manual: ${inventory.retained.pendiente_revision_manual}`,
      `needs_evidence: ${inventory.retained.needs_evidence}`,
      `Descartes: total=${inventory.discards.total}, estructurados=${inventory.discards.structured}, incompletos=${inventory.discards.incomplete}`,
      `NO IMPORTA fuera de descartado: ${inventory.anomalies.no_importa_outside_discard}`,
      `listo con campos de descarte: ${inventory.anomalies.listo_with_discard_fields}`,
      'Cobertura raw_documents:'
    );
    for (const coverage of inventory.raw_documents_coverage) {
      lines.push(
        `  ${coverage.fuente}: alertas=${coverage.alertas}, enlazadas=${coverage.alertas_con_raw_document}, `
        + `raw=${coverage.raw_documents}, con_texto=${coverage.raw_documents_con_texto}, `
        + `con_metadata=${coverage.raw_documents_con_metadata_oficial}`
      );
    }
  } else {
    lines.push(`Motivo: ${lineValue(inventory.reason || inventory.error)}`);
  }

  lines.push(
    '',
    'PREPARACION DEL BACKFILL DE DESCARTES',
    '-'.repeat(20),
    `Estado: ${report.discard_backfill_readiness.status}`,
    `Bloqueos: ${formatList(report.discard_backfill_readiness.blockers)}`,
    `Trabajo historico pendiente: ${formatList(report.discard_backfill_readiness.pending_work)}`,
    '',
    'PRIVACIDAD Y SEGURIDAD',
    '-'.repeat(22),
    'El informe contiene solo conteos agregados, nombres de esquema y estados.',
    'No contiene URLs de conexion, secretos, titulos ni contenidos de alertas reales.',
    ''
  );

  return lines.join('\n');
}

function writeReport(filePath, content) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');
  return resolved;
}

function saveReports(report, { jsonPath = null, textPath = null } = {}) {
  const written = {};
  if (jsonPath) written.json = writeReport(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  if (textPath) written.text = writeReport(textPath, `${formatTextReport(report)}\n`);
  return written;
}

module.exports = {
  formatTextReport,
  saveReports,
  writeReport,
};
