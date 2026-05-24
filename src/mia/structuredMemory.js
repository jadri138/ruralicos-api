const crypto = require('crypto');
const { conOrganizationId } = require('./organizationContext');

const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);

const TOPIC_RULES = [
  ['pac', /\b(pac|politica agraria comun|fega|feaga|feader|solicitud unica|sigpac|ecoregimen)\b/i],
  ['ayudas_maquinaria', /\b(tractor|tractores|maquinaria|maquina|maquinas|apero|aperos)\b/i],
  ['ayudas_subvenciones', /\b(ayuda|ayudas|subvencion|subvenciones|subsidio|convocatoria|pago|prima|indemnizacion)\b/i],
  ['agua_riego', /\b(agua|riego|regadio|pozo|pozos|concesion de aguas|comunidad de regantes)\b/i],
  ['olivar', /\b(olivar|olivo|olivos|aceituna|aceitunas)\b/i],
  ['porcino', /\b(porcino|cerdo|cerdos|cochino|cochinos)\b/i],
  ['vacuno', /\b(vacuno|vaca|vacas|bovino|bovinos)\b/i],
];

function esTablaNoDisponible(error) {
  return MISSING_TABLE_CODES.has(error?.code);
}

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hashDetalle(texto) {
  return crypto
    .createHash('sha256')
    .update(normalizar(texto).slice(0, 500))
    .digest('hex');
}

function inferirTopic(contenido) {
  const texto = normalizar(contenido);
  for (const [topic, regex] of TOPIC_RULES) {
    if (regex.test(texto)) return topic;
  }
  return 'general';
}

function inferirPolarity(tipo) {
  if (['interes_detectado', 'feedback_positivo', 'respuesta_exploracion'].includes(tipo)) return 'positive';
  if (['desinteres_detectado', 'feedback_negativo'].includes(tipo)) return 'negative';
  return 'neutral';
}

function construirMemoriasEstructuradas({
  userId,
  digestId = null,
  inboundId = null,
  decision = {},
  textoOriginal = '',
  source = 'whatsapp',
  organizationId = null,
}) {
  const memoryActions = Array.isArray(decision.memory_actions) ? decision.memory_actions : [];

  return memoryActions
    .map((memoria) => {
      const contenido = String(memoria.contenido || '').trim();
      if (!contenido) return null;

      const confidence = Number(memoria.peso_inicial || decision.confidence || 0.5);
      const topic = inferirTopic(contenido);

      return conOrganizationId({
        user_id: userId,
        digest_id: digestId,
        inbound_id: inboundId,
        source,
        memory_type: memoria.tipo || 'mensaje_libre',
        topic,
        detail: contenido.slice(0, 500),
        detail_hash: hashDetalle(contenido),
        polarity: inferirPolarity(memoria.tipo),
        confidence: Number.isFinite(confidence) ? Math.max(0.1, Math.min(1, confidence)) : 0.5,
        evidence: String(textoOriginal || contenido).slice(0, 1000),
        decision_version: decision.version || null,
        metadata_json: {
          intent: decision.intent || null,
          summary: decision.summary || null,
        },
      }, organizationId);
    })
    .filter(Boolean);
}

async function registrarMemoriaEstructuradaMIA(supabase, options = {}) {
  const rows = construirMemoriasEstructuradas(options);
  if (rows.length === 0) return { ok: true, available: true, inserted: 0 };

  let inserted = 0;
  let merged = 0;

  try {
    for (const row of rows) {
      const { data: existente, error: selectError } = await supabase
        .from('mia_structured_memory')
        .select('id, confidence, duplicate_count')
        .eq('user_id', row.user_id)
        .eq('memory_type', row.memory_type)
        .eq('topic', row.topic)
        .eq('polarity', row.polarity)
        .eq('detail_hash', row.detail_hash)
        .maybeSingle();

      if (selectError) throw selectError;

      if (existente?.id) {
        const { error: updateError } = await supabase
          .from('mia_structured_memory')
          .update({
            confidence: Math.max(Number(existente.confidence || 0), Number(row.confidence || 0.5)),
            evidence: row.evidence,
            metadata_json: row.metadata_json,
            duplicate_count: Number(existente.duplicate_count || 0) + 1,
            last_seen_at: new Date().toISOString(),
          })
          .eq('id', existente.id);

        if (updateError) throw updateError;
        merged++;
        continue;
      }

      const { error: insertError } = await supabase
        .from('mia_structured_memory')
        .insert({
          ...row,
          duplicate_count: 0,
          last_seen_at: new Date().toISOString(),
        });

      if (insertError) throw insertError;
      inserted++;
    }

    return { ok: true, available: true, inserted, merged };
  } catch (error) {
    if (esTablaNoDisponible(error)) {
      return {
        ok: true,
        available: false,
        inserted: 0,
        merged: 0,
        reason: 'mia_structured_memory_no_disponible',
      };
    }

    console.warn('[mia:structured_memory] No se pudo registrar memoria estructurada:', error.message);
    return {
      ok: false,
      available: false,
      inserted,
      merged,
      error: error.message,
    };
  }
}

module.exports = {
  construirMemoriasEstructuradas,
  registrarMemoriaEstructuradaMIA,
  inferirTopic,
  inferirPolarity,
  hashDetalle,
};
