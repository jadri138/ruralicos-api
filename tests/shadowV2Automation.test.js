const assert = require('assert');
const {
  dailyWorkflowRunKey,
  resolveWorkflowRunKey,
  summarizeWorkflowResult,
  runAutomatedShadowV2Batch,
} = require('../src/modules/alertas/shadow-v2/automation');

(async () => {
  const key12a = dailyWorkflowRunKey('2026-08-12');
  const key12b = dailyWorkflowRunKey('2026-08-12');
  const key13 = dailyWorkflowRunKey('2026-08-13');
  assert.strictEqual(key12a, key12b, 'la misma fecha debe reanudar la misma run-key');
  assert.notStrictEqual(key12a, key13, 'cada fecha debe tener una run-key distinta');
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key12a));
  assert.strictEqual(resolveWorkflowRunKey('2026-08-12'), key12a);
  assert.throws(() => resolveWorkflowRunKey('2026-08-12', 'no-es-uuid'), /run_key/);

  const stopped = summarizeWorkflowResult({
    workflowRunKey: key12a,
    workflowDate: '2026-08-12',
    calls: 2,
    stopped: 'max_alerts',
    ai1: { found: 40, processed: 25, filtered: 23, classified: 1, errors: 1, remaining: 15 },
    ai2: null,
  });
  assert.strictEqual(stopped.done, false);
  assert.strictEqual(stopped.processed, 25);
  assert.strictEqual(stopped.errors, 1);
  assert.strictEqual(stopped.ai1.remaining, 15);

  let received;
  const completed = await runAutomatedShadowV2Batch({
    supabase: { fake: true },
    workflowDate: '2026-08-13',
    limitOverrides: { maxAlerts: 25 },
    logger: { info() {}, warn() {}, error() {} },
    runWorkflow: async (options) => {
      received = options;
      return {
        workflowRunKey: options.workflowRunKey,
        workflowDate: options.workflowDate,
        calls: 1,
        stopped: null,
        ai1: { found: 5, processed: 5, filtered: 4, classified: 1, errors: 0 },
        ai2: {
          found: 1,
          processed: 1,
          generated: 1,
          empty: 0,
          noCandidates: 0,
          errors: 0,
          sendGateVersion: 'shadow-v2-send-gate-1',
          sendGateAllowed: 1,
          sendGateBlocked: 0,
          sendGateReasons: {},
        },
      };
    },
  });
  assert.strictEqual(received.workflowRunKey, key13);
  assert.strictEqual(received.limitOverrides.maxAlerts, 25);
  assert.strictEqual(completed.done, true);
  assert.strictEqual(completed.processed, 6);
  assert.strictEqual(completed.ai2.generated, 1);
  assert.strictEqual(completed.ai2.send_gate_allowed, 1);
  assert.strictEqual(completed.ai2.send_gate_blocked, 0);

  const replayKey = '04ac9326-5e7e-4696-a781-37b2b28f8ca3';
  await runAutomatedShadowV2Batch({
    supabase: { fake: true },
    workflowDate: '2026-08-12',
    workflowRunKey: replayKey,
    logger: { info() {}, warn() {}, error() {} },
    runWorkflow: async (options) => {
      assert.strictEqual(options.workflowRunKey, replayKey);
      return {
        workflowRunKey: options.workflowRunKey,
        workflowDate: options.workflowDate,
        calls: 0,
        stopped: null,
        ai1: { found: 0, processed: 0, filtered: 0, classified: 0, errors: 0 },
        ai2: { found: 0, processed: 0, generated: 0, empty: 0, noCandidates: 0, errors: 0 },
      };
    },
  });

  console.log('OK: automatizacion shadow-v2 determinista, reanudable y resumida sin datos sensibles');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
