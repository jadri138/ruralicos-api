const { checkCronToken } = require('../../../middleware/cronToken');
const { getFechaMadridISO } = require('../../../shared/fechaMadrid');
const { ejecutarDecisionV2ShadowBatch } = require('./shadowRunner');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decisionV2ShadowEnabled() {
  return ['1', 'true', 'yes', 'si', 'on'].includes(
    String(process.env.DECISION_V2_SHADOW_ENABLED || '').trim().toLowerCase()
  );
}

module.exports = function decisionV2Routes(app, supabase) {
  app.post('/alertas/decision-v2-shadow', async (req, res) => {
    if (!checkCronToken(req, res)) return;
    if (!decisionV2ShadowEnabled()) {
      return res.status(409).json({
        error: 'decision-v2 shadow esta desactivado',
        retryable: false,
      });
    }

    const workflowDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || req.body?.fecha || '')
      ? String(req.query.fecha || req.body.fecha)
      : getFechaMadridISO();
    const workflowRunKey = String(req.query.run_key || req.body?.run_key || '').trim();
    if (!UUID_PATTERN.test(workflowRunKey)) {
      return res.status(400).json({ error: 'run_key debe ser un UUID', retryable: false });
    }
    const batchSize = Math.max(
      1,
      Math.min(25, Number(req.query.limit || req.body?.limit || process.env.DECISION_V2_SHADOW_BATCH_SIZE || 1))
    );

    try {
      const result = await ejecutarDecisionV2ShadowBatch(supabase, {
        workflowDate,
        workflowRunKey,
        batchSize,
      });
      return res.json({
        success: true,
        workflow_date: workflowDate,
        workflow_run_key: workflowRunKey,
        ...result,
      });
    } catch (error) {
      console.error('[decision-v2-shadow] Fallo sistemico de la fase:', error.message);
      return res.status(500).json({
        error: 'No se pudo completar el lote shadow de decision-v2',
        detail: String(error.message || error).slice(0, 800),
        retryable: false,
      });
    }
  });
};

module.exports.decisionV2ShadowEnabled = decisionV2ShadowEnabled;
