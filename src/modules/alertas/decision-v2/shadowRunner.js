const crypto = require('crypto');
const { llamarIA } = require('../../../platform/ia/llamarIA');
const {
  getMaxAlertasDigestUsuario,
  renderizarMensajeDigestFallback,
} = require('../../digest/digest.service');
const {
  ENGINE_VERSION,
  CONTRACT_VERSION,
  PROMPT_VERSION,
  DEFAULT_MODEL,
  construirPerfilSnapshot,
  ejecutarDecisionV2,
} = require('./decisionEngine');
const defaultRepository = require('./decisionRepository');

const RENDER_VERSION = 'digest-fallback-pure-v1';

function numeroConfig(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function crearLlamadorDecisionV2(callIA = llamarIA) {
  return ({ input, instructions, model, textFormat, maxOutputTokens }) => callIA(
    input,
    instructions,
    model,
    {
      task: 'decision_v2_shadow',
      textFormat,
      maxOutputTokens,
      returnMetadata: true,
      retries: 0,
    }
  );
}

function validarRenderShadow(rendered, selectedAlerts = []) {
  if (!rendered || typeof rendered.message !== 'string' || !rendered.message.trim()) {
    throw new Error('El compositor no devolvio un mensaje completo.');
  }
  const expected = selectedAlerts.map((alert) => Number(alert.id));
  const actual = (rendered.items || []).map((item) => Number(item.alert_id));
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error('El compositor altero la seleccion o el orden de decision-v2.');
  }
  for (const item of rendered.items || []) {
    if (!item.rendered_block || !rendered.message.includes(item.rendered_block)) {
      throw new Error(`El bloque renderizado de la alerta ${item.alert_id} no aparece completo en el mensaje.`);
    }
  }
}

function convertirErrorRender(engineResult, error) {
  return {
    ...engineResult,
    status: 'ERROR',
    error_code: 'shadow_render_error',
    error_message: String(error.message || error).slice(0, 1000),
    error_details: {},
    selected_alerts: [],
  };
}

function resultadoErrorInesperado({ user, model, maxIncluded, error }) {
  return {
    status: 'ERROR',
    engine_version: ENGINE_VERSION,
    contract_version: CONTRACT_VERSION,
    prompt_version: PROMPT_VERSION,
    model,
    max_included: maxIncluded,
    profile_snapshot: construirPerfilSnapshot(user),
    candidates_snapshot: [],
    objective_filter_summary: {},
    policy_snapshot: {},
    system_prompt: null,
    prompt_text: null,
    retry_prompt_text: null,
    llm_input: null,
    llm_raw_response: null,
    llm_raw_responses: [],
    llm_normalized_response: null,
    llm_attempts: 0,
    usage_json: { attempts: [] },
    error_code: 'unexpected_shadow_error',
    error_message: String(error.message || error).slice(0, 1000),
    error_details: { code: error.code || null },
    duplicate_input_count: 0,
    decisions: [],
    selected_alerts: [],
  };
}

async function ejecutarShadowParaUsuario({
  supabase,
  repository = defaultRepository,
  user,
  alerts,
  rawDocumentsByAlert,
  sentAlertIds,
  workflowDate,
  workflowRunKey,
  model = DEFAULT_MODEL,
  maxIncluded = getMaxAlertasDigestUsuario(user),
  totalOfficialChars = numeroConfig(
    process.env.DECISION_V2_MAX_OFFICIAL_INPUT_CHARS,
    180000,
    50000,
    1000000
  ),
  callLLM = crearLlamadorDecisionV2(),
  renderMessage = renderizarMensajeDigestFallback,
  shadowRunId = crypto.randomUUID(),
} = {}) {
  const claim = await repository.reclamarShadowRun(supabase, {
    shadowRunId,
    workflowRunKey,
    workflowDate,
    user,
    engineVersion: ENGINE_VERSION,
    contractVersion: CONTRACT_VERSION,
    promptVersion: PROMPT_VERSION,
    renderVersion: RENDER_VERSION,
    model,
    maxIncluded,
  });
  if (!claim.claimed) {
    return {
      processed: false,
      reused: true,
      shadow_run_id: claim.shadowRunId,
      status: claim.status,
    };
  }

  let engineResult;
  let rendered = null;
  try {
    engineResult = await ejecutarDecisionV2({
      user,
      alerts,
      rawDocumentsByAlert,
      sentAlertIds,
      maxIncluded,
      model,
      callLLM,
      totalOfficialChars,
    });
    if (engineResult.status === 'GENERATED') {
      try {
        rendered = renderMessage({
          user,
          alertas: engineResult.selected_alerts,
          fecha: workflowDate,
          organizationContext: null,
          preserveOrder: true,
          maxChars: null,
          maxItems: null,
        });
        validarRenderShadow(rendered, engineResult.selected_alerts);
      } catch (error) {
        engineResult = convertirErrorRender(engineResult, error);
        rendered = null;
      }
    }
  } catch (error) {
    engineResult = resultadoErrorInesperado({ user, model, maxIncluded, error });
  }

  const persisted = await repository.persistirResultadoShadow(supabase, {
    shadowRunId: claim.shadowRunId,
    workflowDate,
    user,
    engineResult,
    rendered,
  });
  return {
    processed: true,
    reused: false,
    shadow_run_id: claim.shadowRunId,
    status: engineResult.status,
    decisions: persisted.decisions,
    items: persisted.items,
  };
}

async function ejecutarDecisionV2ShadowBatch(supabase, {
  workflowDate,
  workflowRunKey,
  batchSize = numeroConfig(process.env.DECISION_V2_SHADOW_BATCH_SIZE, 1, 1, 25),
  model = process.env.DECISION_V2_MODEL || DEFAULT_MODEL,
  repository = defaultRepository,
  callLLM = crearLlamadorDecisionV2(),
  renderMessage = renderizarMensajeDigestFallback,
} = {}) {
  const users = await repository.cargarUsuariosPendientesShadow(supabase, {
    workflowRunKey,
    batchSize,
  });
  if (users.length === 0) {
    return {
      procesadas: 0,
      actualizadas: 0,
      generated: 0,
      empty: 0,
      errors: 0,
      runs: [],
    };
  }

  const alerts = await repository.cargarAlertasPeriodoShadow(supabase, { workflowDate });
  const rawDocumentsByAlert = await repository.cargarDocumentosOficialesShadow(
    supabase,
    alerts.map((alert) => alert.id)
  );
  const sentByUser = await repository.cargarHistorialEnviadoShadow(
    supabase,
    users.map((user) => user.id)
  );

  const runs = [];
  for (const user of users) {
    runs.push(await ejecutarShadowParaUsuario({
      supabase,
      repository,
      user,
      alerts,
      rawDocumentsByAlert,
      sentAlertIds: sentByUser.get(Number(user.id)) || new Set(),
      workflowDate,
      workflowRunKey,
      model,
      callLLM,
      renderMessage,
    }));
  }

  const processed = runs.filter((run) => run.processed).length;
  return {
    procesadas: processed,
    actualizadas: processed,
    generated: runs.filter((run) => run.status === 'GENERATED').length,
    empty: runs.filter((run) => run.status === 'EMPTY').length,
    errors: runs.filter((run) => run.status === 'ERROR').length,
    runs,
  };
}

module.exports = {
  RENDER_VERSION,
  crearLlamadorDecisionV2,
  validarRenderShadow,
  ejecutarShadowParaUsuario,
  ejecutarDecisionV2ShadowBatch,
};
