const OPENAI_MODELS = Object.freeze({
  economy: 'gpt-5-nano',
  qualityEfficient: 'gpt-5.6-luna',
  embedding: 'text-embedding-3-small',
});

function normalizeModel(model) {
  return String(model || '').trim().toLowerCase();
}

function defaultReasoningForModel(model) {
  const normalized = normalizeModel(model);

  if (normalized === 'gpt-5-nano' || normalized.startsWith('gpt-5-nano-')) {
    return {
      effort: String(process.env.IA_GPT5_NANO_REASONING_EFFORT || 'minimal'),
    };
  }

  if (normalized === 'gpt-5.6-luna' || normalized.startsWith('gpt-5.6-luna-')) {
    return {
      effort: String(process.env.IA_GPT56_LUNA_REASONING_EFFORT || 'low'),
    };
  }

  // Acota el gasto si el despliegue conserva temporalmente un gpt-5 antiguo.
  if (normalized === 'gpt-5' || normalized.startsWith('gpt-5-')) {
    return {
      effort: String(process.env.IA_GPT5_REASONING_EFFORT || 'minimal'),
    };
  }

  return null;
}

module.exports = {
  OPENAI_MODELS,
  defaultReasoningForModel,
};
