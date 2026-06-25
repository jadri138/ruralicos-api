const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  construirPatchIntelligence,
  parseBackfillArgs,
} = require('../scripts/backfill_alert_intelligence');

const defaults = parseBackfillArgs([]);
assert.deepStrictEqual(defaults, {
  days: 30,
  batch: 100,
  concurrency: 3,
  resumeAfterId: 0,
  write: false,
  dryRun: true,
});

const write = parseBackfillArgs([
  '--days=45',
  '--batch',
  '80',
  '--concurrency=4',
  '--resume-after-id=123',
  '--write',
]);
assert.strictEqual(write.write, true);
assert.strictEqual(write.dryRun, false);
assert.strictEqual(write.resumeAfterId, 123);

assert.throws(
  () => parseBackfillArgs(['--dry-run', '--write']),
  /solo uno/
);

const patch = construirPatchIntelligence(
  { decision_audit: { classification: { version: 1 } } },
  {
    pre_score: 4,
    pre_status: 'keep',
    pre_reasons: [{ tag: 'ayuda', weight: 3 }],
    candidate_level: 'strong_candidate',
  },
  ['tipo:ayudas_subvenciones']
);
assert.strictEqual(Object.hasOwn(patch, 'estado_ia'), false);
assert.deepStrictEqual(patch.decision_audit.classification, { version: 1 });
assert.strictEqual(patch.taxonomy_tags[0], 'tipo:ayudas_subvenciones');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'backfill_alert_intelligence.js'),
  'utf8'
);
assert(!source.includes("require('../src/platform/whatsapp"));
assert(!source.includes("from('digests')"));
assert(!source.includes('enviarDigest'));
assert(!source.includes('estado_ia:'));

console.log('OK: backfill seguro, reanudable y dry-run por defecto');
