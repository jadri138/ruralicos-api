const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const REQUIRED_TABLES = Object.freeze(['alertas', 'raw_documents']);

const REQUIRED_COLUMNS = Object.freeze({
  alertas: Object.freeze([
    'id',
    'titulo',
    'contenido',
    'resumen',
    'fecha',
    'fuente',
    'region',
    'provincias',
    'sectores',
    'subsectores',
    'tipos_alerta',
    'taxonomy_tags',
    'estado_ia',
    'resumen_borrador',
    'resumen_final',
    'pre_score',
    'pre_status',
    'pre_reasons',
    'candidate_level',
    'discard_reason_code',
    'discard_reason',
    'discard_stage',
    'discard_confidence',
    'decision_audit',
  ]),
  raw_documents: Object.freeze([
    'id',
    'fuente',
    'inserted_alerta_id',
    'fecha',
    'url',
    'url_html',
    'url_pdf',
    'texto_raw',
    'metadata_json',
    'organismo',
    'seccion',
    'boletin',
    'id_oficial',
    'updated_at',
  ]),
});

const REQUIRED_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: '20260617120000',
    file: '20260617120000_add_raw_documents.sql',
    p0: 'BASE',
  }),
  Object.freeze({
    version: '20260618120000',
    file: '20260618120000_add_alert_preclassification.sql',
    p0: 'BASE',
  }),
  Object.freeze({
    version: '20260625123000',
    file: '20260625123000_add_intelligence_schema_foundation.sql',
    p0: 'BASE',
  }),
  Object.freeze({
    version: '20260719021749',
    file: '20260719021749_add_auditable_alert_discard_fields.sql',
    p0: 'BASE',
  }),
  Object.freeze({
    version: '20260720120000',
    file: '20260720120000_enforce_structured_alert_discards.sql',
    p0: 'BASE',
  }),
]);

const FULL_QUALITY_COMMANDS = Object.freeze([
  Object.freeze({ id: 'lint', command: 'npm', args: ['run', 'lint'] }),
  Object.freeze({ id: 'test_all', command: 'npm', args: ['run', 'test:local'] }),
  Object.freeze({ id: 'check_core', command: 'npm', args: ['run', 'check:core'] }),
]);

const FOCUSED_TESTS = Object.freeze([
  'tests/ruralRoutePrefilter.test.js',
  'tests/procesarConFiltroRural.test.js',
  'tests/taxonomyRegistry.test.js',
  'tests/alertaMatcher.test.js',
  'tests/alertSelectionEngine.test.js',
  'tests/digestAutoSendGuard.test.js',
  'tests/antibioticsEndToEnd.test.js',
  'tests/bopaEvidence.test.js',
  'tests/officialRuralEvidenceGate.test.js',
  'tests/alertDiscardAudit.test.js',
  'tests/discardTraceabilityContract.test.js',
  'tests/p0AcceptanceCorpus.test.js',
  'tests/p0OriginalEdges.test.js',
  'tests/auditedFalseDiscardCorpus.test.js',
  'tests/finalValidationAuthority.test.js',
  'tests/bopzResilience.test.js',
  'tests/pipelineShadowStale.test.js',
  'tests/planAcceptanceMetrics.test.js',
]);

const MATRIX_PATH = path.join(REPO_ROOT, 'scripts', 'p0-acceptance', 'guarantees.json');
const DEFAULT_FIXTURE_PATH = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'p0',
  'acceptance-corpus.json'
);

module.exports = {
  DEFAULT_FIXTURE_PATH,
  FOCUSED_TESTS,
  FULL_QUALITY_COMMANDS,
  MATRIX_PATH,
  REPO_ROOT,
  REQUIRED_COLUMNS,
  REQUIRED_MIGRATIONS,
  REQUIRED_TABLES,
};
