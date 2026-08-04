const { conOrganizationId } = require('./organizationContext');
const { FEEDBACK_CATEGORIES, clasificarFeedbackDigest } = require('./feedbackClassifier');
const {
  construirMemoriaAtomica,
  construirMemoriasYaSolicitadaPeroSimilares,
  esYaSolicitadaPeroSimilares,
  guardarMemoriasAtomicas,
} = require('../aprendizaje/atomicMemory');
const HANDOFF_RISK_FLAGS = new Set([
  'low_confidence',
  'feedback_digest_without_executable_actions',
  'digest_missing',
  'knowledge_partial_answer',
  'knowledge_no_match',
  'knowledge_lookup_failed',
  'knowledge_evidence_weak',
  'policy_handoff_required',
]);

function normalizarTextoCaso(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function necesitaCasoAgenteMIA(decision = {}) {
  if (decision.policy?.requires_agent === true) return true;
  if (decision.policy?.requires_agent === false) return false;

  const autoAnswered = Boolean(decision.auto_answered) ||
    (decision.risk_flags || []).includes('auto_answered_from_knowledge_base');

  return (
    (!autoAnswered && decision.intent === 'pregunta_usuario') ||
    decision.intent === 'queja_servicio' ||
    (decision.risk_flags || []).some((flag) => HANDOFF_RISK_FLAGS.has(flag))
  );
}

function construirFeedbackRows({
  user,
  digest,
  alertasOrdenadas = [],
  texto,
  decision = {},
  organizationId = null,
}) {
  const alertasPorItem = new Map(
    (alertasOrdenadas || []).map((alerta, index) => [index + 1, alerta])
  );
  const ahora = new Date().toISOString();
  const orgId = organizationId || user?.organization_id || digest?.organization_id || null;

  return (decision.feedback_actions || [])
    .map((feedback) => {
      const alerta = alertasPorItem.get(Number(feedback.item_numero));
      if (!alerta?.id) return null;
      const classification = clasificarFeedbackDigest({ texto, feedback, alerta });

      return conOrganizationId({
        user_id: user.id,
        digest_id: digest?.id || null,
        alerta_id: alerta.id,
        item_numero: Number(feedback.item_numero),
        valor: Number(feedback.valor),
        canal: 'whatsapp',
        raw_text: texto,
        feedback_category: classification.category,
        feedback_confidence: classification.confidence,
        feedback_detail: {
          reasons: classification.reasons,
          evidence: classification.evidence,
        },
        updated_at: ahora,
      }, orgId);
    })
    .filter(Boolean);
}

function construirMemoriaLegacyRows({
  user,
  digest,
  alertasOrdenadas = [],
  texto,
  decision = {},
  organizationId = null,
}) {
  const alertasPorItem = new Map(
    (alertasOrdenadas || []).map((alerta, index) => [index + 1, alerta])
  );
  const memoryRows = [];
  const orgId = organizationId || user?.organization_id || digest?.organization_id || null;
  const shouldStoreExplicitMemory = decision.policy?.should_store_memory !== false;
  const requestedButSimilar = esYaSolicitadaPeroSimilares(texto);

  for (const feedback of decision.feedback_actions || []) {
    const alerta = alertasPorItem.get(Number(feedback.item_numero));
    if (!alerta?.id) continue;

    if (requestedButSimilar) {
      memoryRows.push(...construirMemoriasYaSolicitadaPeroSimilares({
        userId: user.id,
        alerta,
        digestId: digest?.id || null,
        organizationId: orgId,
        decisionVersion: decision.version || null,
        confidence: decision.confidence ?? 1,
      }));
      continue;
    }

    if (Number(feedback.valor) === 0) continue;

    // "Me mandas demasiado" no es desinterés por esa alerta ni por su tema:
    // pide menos volumen. Se guarda en el ámbito de frecuencia para que no
    // contamine el perfil temático.
    const esQuejaDeFrecuencia = Number(feedback.valor) < 0
      && clasificarFeedbackDigest({ texto, feedback, alerta }).category === FEEDBACK_CATEGORIES.TOO_FREQUENT;

    memoryRows.push(construirMemoriaAtomica({
      userId: user.id,
      tipo: Number(feedback.valor) > 0 ? 'feedback_positivo' : 'feedback_negativo',
      contenido: esQuejaDeFrecuencia
        ? 'Pide recibir menos mensajes'
        : alerta.titulo || feedback.razon || `Feedback item ${feedback.item_numero}`,
      alertaId: esQuejaDeFrecuencia ? null : alerta.id,
      digestId: digest?.id || null,
      organizationId: orgId,
      scopeType: esQuejaDeFrecuencia ? 'frequency' : 'alert',
      scopeValue: esQuejaDeFrecuencia ? 'volumen' : String(alerta.id),
      polarity: Number(feedback.valor) > 0 ? 'positive' : 'negative',
      source: 'response',
      strength: 1,
      confidence: decision.confidence ?? 0.9,
      decisionVersion: decision.version || null,
      metadata: {
        item_numero: Number(feedback.item_numero),
        feedback_reason: feedback.razon || null,
        ...(esQuejaDeFrecuencia ? { feedback_category: FEEDBACK_CATEGORIES.TOO_FREQUENT } : {}),
      },
    }));
  }

  // Las memory_actions declarativas se guardan mediante structuredMemory.js,
  // que ahora es un adaptador hacia la misma tabla canónica. Así evitamos dos
  // escrituras de la misma señal y conservamos inbound_id/versión.
  if (
    shouldStoreExplicitMemory
    && memoryRows.length === 0
    && (decision.memory_actions || []).length === 0
    && decision.intent === 'pregunta_usuario'
  ) {
    const contenido = String(texto || '').trim().slice(0, 1200);
    if (contenido) {
      memoryRows.push(construirMemoriaAtomica({
        userId: user.id,
        tipo: 'pregunta_usuario',
        contenido,
        digestId: digest?.id || null,
        organizationId: orgId,
        scopeType: 'topic',
        scopeValue: 'pregunta_usuario',
        polarity: 'neutral',
        source: 'response',
        strength: 0.7,
        confidence: decision.confidence ?? 0.7,
        decisionVersion: decision.version || null,
      }));
    }
  }

  return memoryRows;
}

async function ejecutarAccionesMIA(supabase, {
  user,
  digest,
  alertasOrdenadas = [],
  texto,
  decision = {},
  organizationId = null,
  aplicarFeedbackAlPerfil,
}) {
  const orgId = organizationId || user?.organization_id || digest?.organization_id || null;
  const feedbackRows = construirFeedbackRows({ user, digest, alertasOrdenadas, texto, decision, organizationId: orgId });
  const memoryRows = construirMemoriaLegacyRows({ user, digest, alertasOrdenadas, texto, decision, organizationId: orgId });
  const requestedButSimilar = esYaSolicitadaPeroSimilares(texto);

  if (feedbackRows.length > 0) {
    const { error } = await supabase
      .from('alerta_feedback')
      .upsert(feedbackRows, { onConflict: 'user_id,digest_id,alerta_id' });
    if (error) throw error;

    // El perfil agregado legacy no sabe distinguir "esta ya la pedí" de
    // "no quiero ayudas parecidas". En ese caso la memoria atómica conserva
    // los dos ámbitos y es la única fuente de aprendizaje segura.
    if (!requestedButSimilar && typeof aplicarFeedbackAlPerfil === 'function') {
      for (const row of feedbackRows) {
        if (row.valor === 0) continue;
        const alerta = (alertasOrdenadas || []).find((a) => Number(a.id) === Number(row.alerta_id));
        if (alerta) {
          await aplicarFeedbackAlPerfil(supabase, {
            userId: user.id,
            alerta,
            delta: row.valor,
            rawText: texto,
          });
        }
      }
    }
  }

  if (memoryRows.length > 0) {
    await guardarMemoriasAtomicas(supabase, memoryRows);
  }

  return {
    feedbacks_guardados: feedbackRows.length,
    memorias_guardadas: memoryRows.length,
  };
}

function construirCasoAgenteDesdeDecision({
  user,
  inboundId = null,
  decisionId = null,
  digestId = null,
  conversationId = null,
  texto,
  decision = {},
  organizationId = null,
}) {
  if (!necesitaCasoAgenteMIA(decision)) return null;

  const prioridad = decision.policy?.priority && decision.policy.priority !== 'normal'
    ? decision.policy.priority
    : decision.intent === 'queja_servicio'
    ? 'alta'
    : (decision.risk_flags || []).includes('low_confidence')
      ? 'media'
      : 'normal';

  const orgId = organizationId || user?.organization_id || null;
  return conOrganizationId({
    user_id: user.id,
    inbound_id: inboundId,
    decision_id: decisionId,
    digest_id: digestId,
    conversation_id: conversationId,
    status: 'open',
    priority: prioridad,
    reason: decision.intent,
    question_text: String(texto || '').trim().slice(0, 2000),
    summary: decision.summary || null,
    decision_json: decision,
    metadata_json: {
      risk_flags: decision.risk_flags || [],
      confidence: decision.confidence ?? null,
      knowledge_context: decision.knowledge_context || null,
      policy: decision.policy || null,
    },
  }, orgId);
}

async function buscarCasoAgenteAbiertoMIA(supabase, row) {
  try {
    const { data, error } = await supabase
      .from('mia_agent_cases')
      .select('id, status, reason, digest_id, question_text, metadata_json, created_at')
      .eq('user_id', row.user_id)
      .eq('reason', row.reason)
      .in('status', ['open', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    const target = normalizarTextoCaso(row.question_text);
    const existing = (data || []).find((item) => {
      return normalizarTextoCaso(item.question_text) === target;
    });

    return { ok: true, available: true, item: existing || null };
  } catch (error) {
    console.warn('[mia:agent_cases] No se pudo buscar caso abierto:', error.message);
    return { ok: false, available: false, item: null, error: error.message };
  }
}

async function registrarCasoAgenteMIA(supabase, options = {}) {
  const row = construirCasoAgenteDesdeDecision(options);
  if (!row) return { ok: true, available: true, created: false, id: null };

  try {
    const existente = await buscarCasoAgenteAbiertoMIA(supabase, row);
    if (!existente.available) {
      return {
        ok: existente.ok,
        available: false,
        created: false,
        id: null,
        reason: existente.reason || 'mia_agent_cases_no_disponible',
        error: existente.error || null,
      };
    }
    if (existente.item?.id) {
      return {
        ok: true,
        available: true,
        created: false,
        existing: true,
        id: existente.item.id,
        reason: 'caso_agente_abierto_existente',
      };
    }

    const { data, error } = await supabase
      .from('mia_agent_cases')
      .insert(row)
      .select('id')
      .single();

    if (error) throw error;
    return { ok: true, available: true, created: true, id: data?.id || null };
  } catch (error) {
    console.warn('[mia:agent_cases] No se pudo registrar caso agente:', error.message);
    return { ok: false, available: false, created: false, error: error.message };
  }
}

async function abrirConversacionAgenteMIA(supabase, {
  user,
  caseId = null,
  inboundId = null,
  decisionId = null,
  digestId = null,
  conversationId = null,
  texto,
  decision = {},
  organizationId = null,
  ttlHours = 72,
} = {}) {
  if (!user?.id || !necesitaCasoAgenteMIA(decision)) {
    return { ok: true, available: true, created: false, updated: false, id: null };
  }

  const ahora = new Date();
  const expiraAt = new Date(ahora.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
  const orgId = organizationId || user?.organization_id || null;
  const contexto = {
    origen: 'mia_agent_case',
    case_id: caseId,
    inbound_id: inboundId,
    decision_id: decisionId,
    digest_id: digestId,
    previous_conversation_id: conversationId,
    intent: decision.intent || null,
    risk_flags: decision.risk_flags || [],
    policy: decision.policy || null,
    pregunta: String(texto || '').trim().slice(0, 1200),
  };

  try {
    const { data: existente, error: selectError } = await supabase
      .from('user_conversations')
      .select('id, contexto_json')
      .eq('user_id', user.id)
      .eq('tipo', 'respuesta_consulta')
      .eq('estado', 'activa')
      .gt('expira_at', ahora.toISOString())
      .order('abierta_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (selectError) throw selectError;

    if (existente?.id) {
      const { error: updateError } = await supabase
        .from('user_conversations')
        .update({
          contexto_json: {
            ...(existente.contexto_json || {}),
            ...contexto,
          },
          digest_id: digestId,
          ...conOrganizationId({}, orgId),
          expira_at: expiraAt,
        })
        .eq('id', existente.id);

      if (updateError) throw updateError;
      return { ok: true, available: true, created: false, updated: true, id: existente.id };
    }

    const { data, error } = await supabase
      .from('user_conversations')
      .insert({
        user_id: user.id,
        ...conOrganizationId({}, orgId),
        tipo: 'respuesta_consulta',
        estado: 'activa',
        contexto_json: contexto,
        digest_id: digestId,
        expira_at: expiraAt,
      })
      .select('id')
      .single();

    if (error) throw error;
    return { ok: true, available: true, created: true, updated: false, id: data?.id || null };
  } catch (error) {
    console.warn('[mia:agent_conversation] No se pudo abrir conversacion agente:', error.message);
    return { ok: false, available: false, created: false, updated: false, id: null, error: error.message };
  }
}

module.exports = {
  construirFeedbackRows,
  construirMemoriaLegacyRows,
  construirCasoAgenteDesdeDecision,
  buscarCasoAgenteAbiertoMIA,
  abrirConversacionAgenteMIA,
  necesitaCasoAgenteMIA,
  ejecutarAccionesMIA,
  registrarCasoAgenteMIA,
};
