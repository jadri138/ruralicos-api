// src/modules/feedback/feedback.routes.js
//
// Capa HTTP de feedback: webhook entrante de UltraMsg y diagnóstico protegido
// (/feedback/parse, /feedback/perfil, /feedback/diagnostico...).
// La logica vive en feedback.service.js.
const { checkCronToken } = require('../../middleware/cronToken');
const { responderError } = require('../../shared/responderError');

const { normalizePhone } = require('../../shared/phoneNormalizer');
const {
  aplicarFeedbackAlPerfil,
  extraerTextoEntrante,
  extraerTelefonoEntrante,
  leerPerfilIntereses,
  parsearVotosDigest,
  parsearVotosNaturalesPorAlertas,
  analizarFeedbackCompleto,
} = require('../aprendizaje');
const { enviarDigestPro } = require('../../platform/whatsapp');
const { extraerUltraMsg, esEventoMensajeUltraMsg } = require('../../shared/ultramsgParser');
const { registrarInboundMIA, actualizarInboundMIA } = require('../mia/inbound');
const { decidirMensajeMIA, esRespuestaOrigenCaptacionMIA } = require('../mia/decisionCore');

const { registrarMemoriaEstructuradaMIA } = require('../mia/structuredMemory');
const {
  ejecutarAccionesMIA,
  registrarCasoAgenteMIA,
  abrirConversacionAgenteMIA,
} = require('../mia/actionExecutor');
const {
  resolverPreguntaConBaseConocimientoMIA,
  aplicarRespuestaConocimientoADecision,
} = require('../mia/knowledgeBase');
const {
  registrarDecisionYAccionesMIA,
  actualizarDecisionResultadoMIA,
  actualizarAccionesPorTipoMIA,
} = require('../mia/decisionStore');
const {
  encolarRespuestaMIA,
  procesarOutboxItemMIA,
} = require('../mia/outbox');
const { guardarWebhookEventSeguro } = require('../mia/webhookEvent');
const { procesarAckUltraMsg } = require('../delivery/deliveryService');
const {
  cargarPerfilOperativoMIA,
  aplicarPerfilOperativoAUsuario,
} = require('../mia/userProfile');
const { evaluarPoliticaDecisionMIA } = require('../mia/policy');
const {
  cargarOrganizationContextMIA,
  aplicarOrganizationContextAUsuario,
} = require('../mia/organizationContext');

const {
  comprobarWebhookToken,
  fechaMadridConversacionMIA,
  esConversacionMIADelDia,
  getExpiracionFinDiaMadridISO,
  buscarConversacionActiva,
  cargarDigestYAlertas,
  cargarUltimoDigestEntregadoReciente,
  cargarContextoRecienteMIA,
  construirConsultaContextualMIA,
  extraerItemsReferenciadosInequivocamente,
  buscarUsuarioPorTelefonoEntrante,
} = require('./feedback.service');

function feedbackRoutes(app, supabase) {
  async function guardarWebhookEvent(req, result = null, error = null) {
    return guardarWebhookEventSeguro(supabase, req, result, error);
  }

  app.post('/feedback/parse', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const texto = String(req.body?.texto || req.query?.texto || '').trim();
      if (!texto) return res.status(400).json({ error: 'Indica texto para analizar' });

      const alertaContexto = req.body?.alertaContexto || null;
      const alertas = Array.isArray(req.body?.alertas) ? req.body.alertas : [];
      const votos = parsearVotosDigest(texto, Number(req.body?.totalItems || req.query?.totalItems || 0) || null);
      const votosNaturales = votos.length === 0 && alertas.length > 0
        ? parsearVotosNaturalesPorAlertas(texto, alertas)
        : null;
      const resultado = votos.length > 0
        ? { tipo: 'votos_digest', votos }
        : votosNaturales?.matched
          ? { tipo: 'votos_naturales_alertas', ...votosNaturales }
        : { tipo: 'texto_natural', ...(await analizarFeedbackCompleto(texto, alertaContexto)) };

      return res.json({ ok: true, texto, resultado });
    } catch (err) {
      console.error('Error en /feedback/parse:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/feedback/perfil', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const phone = normalizePhone(req.query.phone);
      if (!phone) return res.status(400).json({ error: 'Indica phone' });

      const { data: user, error: errUser } = await supabase
        .from('users')
        .select('id, phone, name, organization_id')
        .eq('phone', phone)
        .maybeSingle();

      if (errUser) return res.status(500).json({ error: errUser.message });
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const perfil = await leerPerfilIntereses(supabase, user.id);
      const { data: tags, error: errTags } = await supabase
        .from('user_interest_profile')
        .select('tag, score, positivos, negativos, updated_at')
        .eq('user_id', user.id)
        .order('score', { ascending: false });

      if (errTags) return res.status(500).json({ error: errTags.message });

      return res.json({
        ok: true,
        user,
        resumen: perfil.resumen,
        tags: tags || [],
      });
    } catch (err) {
      console.error('Error en /feedback/perfil:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/feedback/diagnostico', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const phone = normalizePhone(req.query.phone);
      if (!phone) return res.status(400).json({ error: 'Indica phone' });

      const { data: user, error: errUser } = await supabase
        .from('users')
        .select('id, phone, name, subscription, organization_id')
        .eq('phone', phone)
        .maybeSingle();

      if (errUser) return res.status(500).json({ error: errUser.message });
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado', phone });

      const [
        { data: digests, error: errDigests },
        { data: feedback, error: errFeedback },
        { data: memoria, error: errMemoria },
        { data: perfil, error: errPerfil },
        { data: eventos, error: errEventos },
      ] = await Promise.all([
        supabase
          .from('digests')
          .select('id, fecha, enviado, enviado_at, alerta_ids, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(5),
        supabase
          .from('alerta_feedback')
          .select('id, digest_id, alerta_id, item_numero, valor, raw_text, created_at, updated_at')
          .eq('user_id', user.id)
          .order('updated_at', { ascending: false })
          .limit(10),
        supabase
          .from('user_memory')
          .select('id, tipo, contenido, alerta_id, digest_id, peso_inicial, incorporado_a_embedding, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('user_interest_profile')
          .select('tag, score, positivos, negativos, updated_at')
          .eq('user_id', user.id)
          .order('score', { ascending: false })
          .limit(20),
        supabase
          .from('webhook_events')
          .select('id, content_type, processed, result_json, error_msg, body_json, created_at')
          .eq('source', 'ultramsg')
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      if (errDigests) return res.status(500).json({ error: errDigests.message });
      if (errFeedback) return res.status(500).json({ error: errFeedback.message });
      if (errMemoria) return res.status(500).json({ error: errMemoria.message });
      if (errPerfil) return res.status(500).json({ error: errPerfil.message });
      if (errEventos) return res.status(500).json({ error: errEventos.message });

      return res.json({
        ok: true,
        user,
        digests: digests || [],
        feedback: feedback || [],
        memoria: memoria || [],
        perfil: perfil || [],
        webhook_events: eventos || [],
      });
    } catch (err) {
      console.error('Error en /feedback/diagnostico:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.all('/webhooks/ultramsg/feedback', async (req, res) => {
    const tokenValidacion = comprobarWebhookToken(req);
    if (!tokenValidacion.ok) {
      const result = {
        ok: false,
        ignored: true,
        reason: tokenValidacion.reason,
      };
      await guardarWebhookEvent(req, result, null);
      return res.status(tokenValidacion.status).json({ error: tokenValidacion.error });
    }

    let inboundMIA = null;

    try {
      const ackResult = await procesarAckUltraMsg(supabase, req.body || {});
      if (ackResult.handled) {
        return res.json({
          ok: ackResult.ok,
          handled: true,
          matched: ackResult.matched ?? false,
          duplicate: ackResult.duplicate ?? false,
          changed: ackResult.changed ?? false,
          ignored: ackResult.ignored ?? false,
          reason: ackResult.reason || ackResult.transition_reason || null,
          delivery_status: ackResult.delivery_status || null,
        });
      }

      const ultra = extraerUltraMsg(req.body);

      if (!esEventoMensajeUltraMsg(ultra.eventType)) {
        const result = { ok: true, ignored: true, reason: 'event_type_no_procesable', event_type: ultra.eventType };
        await guardarWebhookEvent(req, result, null);
        return res.json(result);
      }

      if (ultra.fromMe) {
        const result = { ok: true, ignored: true, reason: 'mensaje_propio' };
        await guardarWebhookEvent(req, result, null);
        return res.json(result);
      }

      const texto = ultra.texto || extraerTextoEntrante(req.body);
      const telefono = normalizePhone(ultra.telefono || extraerTelefonoEntrante(req.body));

      if (!telefono || !texto) {
        const result = { ok: true, ignored: true, reason: 'telefono_o_texto_vacio', telefono: Boolean(telefono), texto: Boolean(texto) };
        await guardarWebhookEvent(req, result, null);
        return res.json(result);
      }

      inboundMIA = await registrarInboundMIA(supabase, {
        source: 'ultramsg',
        ultra,
        telefono,
        texto,
        body: req.body || {},
      });

      if (inboundMIA.duplicate) {
        const result = {
          ok: true,
          ignored: true,
          reason: 'mensaje_duplicado',
          mia_inbound_id: inboundMIA.id || null,
          message_id: inboundMIA.identity?.external_message_id || null,
          duplicate_count: inboundMIA.duplicate_count || null,
        };
        await guardarWebhookEvent(req, result, null);
        return res.json(result);
      }

      if (esRespuestaOrigenCaptacionMIA(texto)) {
        const result = {
          ok: true,
          ignored: true,
          reason: 'respuesta_origen_captacion',
          phone: telefono,
          mia_inbound_id: inboundMIA?.id || null,
          message_id: inboundMIA?.identity?.external_message_id || null,
        };
        await actualizarInboundMIA(supabase, inboundMIA?.id, {
          status: 'ignored',
          ignored_reason: 'respuesta_origen_captacion',
          result_json: result,
        });
        await guardarWebhookEvent(req, result, null);
        return res.json(result);
      }

      if (ultra.senderKind && ultra.senderKind !== 'user') {
        const result = {
          ok: true,
          ignored: true,
          reason: 'canal_no_usuario',
          sender_kind: ultra.senderKind,
          mia_inbound_id: inboundMIA?.id || null,
          message_id: inboundMIA?.identity?.external_message_id || null,
        };
        await actualizarInboundMIA(supabase, inboundMIA?.id, {
          status: 'ignored',
          ignored_reason: 'canal_no_usuario',
          result_json: result,
        });
        await guardarWebhookEvent(req, result, null);
        return res.json(result);
      }

      const user = await buscarUsuarioPorTelefonoEntrante(
        supabase,
        telefono,
        'id, phone, name, subscription, preferences, preferencias_extra, contexto_narrativo, organization_id'
      );
      if (!user) {
        const result = {
          ok: true,
          ignored: true,
          reason: 'usuario_no_encontrado',
          phone: telefono,
          mia_inbound_id: inboundMIA?.id || null,
          message_id: inboundMIA?.identity?.external_message_id || null,
        };
        await actualizarInboundMIA(supabase, inboundMIA?.id, {
          status: 'ignored',
          ignored_reason: 'usuario_no_encontrado',
          result_json: result,
        });
        await guardarWebhookEvent(req, result, null);
        return res.json(result);
      }

      const organizationContext = await cargarOrganizationContextMIA(supabase, user);
      const organizationId = organizationContext.organization_id || null;
      const userConOrganization = aplicarOrganizationContextAUsuario(user, organizationContext);

      await supabase
        .from('users')
        .update({ ultima_interaccion_at: new Date().toISOString() })
        .eq('id', user.id);

      const perfilOperativoMIA = await cargarPerfilOperativoMIA(supabase, user.id, { user: userConOrganization });
      const usuarioMIA = aplicarPerfilOperativoAUsuario(userConOrganization, perfilOperativoMIA);
      const [conversacionActiva, contextoReciente] = await Promise.all([
        buscarConversacionActiva(supabase, user.id),
        cargarContextoRecienteMIA(supabase, user.id),
      ]);
      const { digest, alertasOrdenadas, lateAssociation } = await cargarDigestYAlertas(
        supabase,
        user.id,
        conversacionActiva,
        organizationId,
        { mensajeUsuario: texto }
      );

      let decisionMIA = await decidirMensajeMIA({
        mensajeUsuario: texto,
        usuario: usuarioMIA,
        conversacionActiva,
        digest,
        alertasDelDigest: alertasOrdenadas,
        contextoReciente,
      });
      decisionMIA = {
        ...decisionMIA,
        organization_context: organizationContext,
      };

      const consultaContextual = construirConsultaContextualMIA(texto, contextoReciente);
      if (consultaContextual.usada && decisionMIA.intent === 'unknown') {
        decisionMIA = {
          ...decisionMIA,
          intent: 'pregunta_usuario',
          risk_flags: [...new Set([...(decisionMIA.risk_flags || []), 'recent_context_used'])],
        };
      }

      if (['pregunta_usuario', 'unknown'].includes(decisionMIA.intent)) {
        try {
          const respuestaConocimiento = await resolverPreguntaConBaseConocimientoMIA(supabase, {
            texto: consultaContextual.usada ? consultaContextual.texto : texto,
            limit: 5,
            organizationId,
            organizationContext,
          });
          decisionMIA = aplicarRespuestaConocimientoADecision({
            ...decisionMIA,
            organization_context: organizationContext,
          }, respuestaConocimiento);
        } catch (error) {
          console.warn(`[mia:knowledge] No se pudo consultar la base ${organizationContext.reply_sender || 'Ruralicos'}:`, error.message);
          decisionMIA = {
            ...decisionMIA,
            risk_flags: [...new Set([...(decisionMIA.risk_flags || []), 'knowledge_lookup_failed'])],
            knowledge_context: {
              answered: false,
              needs_agent: true,
              error: error.message,
            },
          };
        }
      }
      decisionMIA = evaluarPoliticaDecisionMIA({
        decision: {
          ...decisionMIA,
          organization_context: organizationContext,
        },
        texto: consultaContextual.usada ? consultaContextual.texto : texto,
        usuario: usuarioMIA,
        perfilOperativo: perfilOperativoMIA,
        conversacionActiva,
        digest,
        alertasDelDigest: alertasOrdenadas,
      });
      const interpretacion = decisionMIA.legacy_interpretacion;
      const decisionStore = await registrarDecisionYAccionesMIA(supabase, {
        inboundId: inboundMIA?.id || null,
        userId: user.id,
        digestId: digest?.id || null,
        conversationId: conversacionActiva?.id || null,
        organizationId,
        decision: decisionMIA,
      });

      const guardado = await ejecutarAccionesMIA(supabase, {
        user: userConOrganization,
        digest,
        alertasOrdenadas,
        texto,
        decision: decisionMIA,
        inboundId: inboundMIA?.id || null,
        organizationId,
        aplicarFeedbackAlPerfil,
      });
      await actualizarAccionesPorTipoMIA(supabase, {
        decisionId: decisionStore.decision_id,
        actionType: 'feedback_digest',
        status: guardado.feedbacks_guardados > 0 ? 'executed' : 'skipped',
        resultJson: { feedbacks_guardados: guardado.feedbacks_guardados },
      });

      const memoriaEstructurada = await registrarMemoriaEstructuradaMIA(supabase, {
        userId: user.id,
        digestId: digest?.id || null,
        inboundId: inboundMIA?.id || null,
        decision: decisionMIA,
        textoOriginal: texto,
        source: 'whatsapp',
        organizationId,
      });

      const casoAgente = await registrarCasoAgenteMIA(supabase, {
        user: userConOrganization,
        inboundId: inboundMIA?.id || null,
        decisionId: decisionStore.decision_id || null,
        digestId: digest?.id || null,
        conversationId: conversacionActiva?.id || null,
        texto,
        decision: decisionMIA,
        organizationId,
      });
      const conversacionAgente = await abrirConversacionAgenteMIA(supabase, {
        user: userConOrganization,
        caseId: casoAgente.id || null,
        inboundId: inboundMIA?.id || null,
        decisionId: decisionStore.decision_id || null,
        digestId: digest?.id || null,
        conversationId: conversacionActiva?.id || null,
        texto,
        decision: decisionMIA,
        organizationId,
      });
      await actualizarAccionesPorTipoMIA(supabase, {
        decisionId: decisionStore.decision_id,
        actionType: 'handoff_agent',
        status: (casoAgente.created || casoAgente.existing || conversacionAgente.created || conversacionAgente.updated) ? 'executed' : 'skipped',
        resultJson: {
          case_id: casoAgente.id || null,
          created: casoAgente.created || false,
          existing: casoAgente.existing || false,
          available: casoAgente.available !== false,
          conversation_id: conversacionAgente.id || null,
          conversation_created: conversacionAgente.created || false,
          conversation_updated: conversacionAgente.updated || false,
          conversation_available: conversacionAgente.available !== false,
          reason: casoAgente.reason || null,
        },
        errorMsg: casoAgente.error || conversacionAgente.error || null,
      });
      await actualizarAccionesPorTipoMIA(supabase, {
        decisionId: decisionStore.decision_id,
        actionType: 'memory',
        status: (guardado.memorias_guardadas > 0 || memoriaEstructurada.inserted > 0 || memoriaEstructurada.merged > 0) ? 'executed' : 'skipped',
        resultJson: {
          memorias_guardadas: guardado.memorias_guardadas,
          estructuradas_inserted: memoriaEstructurada.inserted || 0,
          estructuradas_merged: memoriaEstructurada.merged || 0,
        },
      });

      const mantenerConversacionConsulta =
        conversacionActiva &&
        conversacionAgente.id &&
        Number(conversacionActiva.id) === Number(conversacionAgente.id);

      if (conversacionActiva && !mantenerConversacionConsulta) {
        await supabase
          .from('user_conversations')
          .update({
            estado: 'resuelta',
            cerrada_at: new Date().toISOString(),
          })
          .eq('id', conversacionActiva.id);
      }

      const outboxMIA = await encolarRespuestaMIA(supabase, {
        decision: decisionMIA,
        inboundId: inboundMIA?.id || null,
        decisionId: decisionStore.decision_id || null,
        userId: user.id,
        toPhone: telefono,
        organizationId,
      });
      await actualizarAccionesPorTipoMIA(supabase, {
        decisionId: decisionStore.decision_id,
        actionType: 'reply',
        status: outboxMIA.queued || outboxMIA.body ? 'executed' : 'skipped',
        resultJson: {
          outbox_id: outboxMIA.id || null,
          queued: outboxMIA.queued || false,
          existing: outboxMIA.existing || false,
          status: outboxMIA.status || null,
          available: outboxMIA.available !== false,
        },
        errorMsg: outboxMIA.error || null,
      });

      if (decisionMIA.reply_action?.canal === 'whatsapp' && decisionMIA.reply_action?.texto) {
        const textoRespuesta = outboxMIA.body || decisionMIA.reply_action.texto;
        const enviarInmediato = String(process.env.MIA_OUTBOX_IMMEDIATE_SEND || 'true').toLowerCase() !== 'false';
        if (outboxMIA.id && enviarInmediato) {
          procesarOutboxItemMIA(supabase, {
            id: outboxMIA.id,
            to_phone: telefono,
            body: textoRespuesta,
            attempts: outboxMIA.attempts || 0,
            delivery_status: outboxMIA.delivery_status || 'QUEUED',
            provider_message_id: outboxMIA.provider_message_id || null,
            idempotency_key: outboxMIA.idempotency_key || null,
            message_version: outboxMIA.message_version || null,
            user_id: user.id,
          }, enviarDigestPro)
            .then((result) => {
              if (result.ok === false) console.error('[feedback] Error enviando respuesta MIA:', result.error);
            })
            .catch((err) => console.error('[feedback] Error inesperado procesando outbox MIA:', err.message));
        } else if (!outboxMIA.id && enviarInmediato) {
          console.error('[feedback] Respuesta MIA no enviada: outbox no disponible');
        }
      }

      const result = {
        ok: true,
        user_id: user.id,
        organization_id: organizationId,
        digest_id: digest?.id || null,
        late_digest_association: lateAssociation,
        conversacion_id: conversacionActiva?.id || null,
        mia_inbound_id: inboundMIA?.id || null,
        message_id: inboundMIA?.identity?.external_message_id || null,
        mia_decision_version: decisionMIA.version,
        mia_intent: decisionMIA.intent,
        mia_confidence: decisionMIA.confidence,
        mia_risk_flags: decisionMIA.risk_flags,
        mia_policy: decisionMIA.policy || null,
        mia_knowledge_context: decisionMIA.knowledge_context || null,
        mia_user_profile: {
          version: perfilOperativoMIA.version,
          summary: perfilOperativoMIA.summary || null,
          interests: (perfilOperativoMIA.interests || []).slice(0, 5),
          dislikes: (perfilOperativoMIA.dislikes || []).slice(0, 5),
          availability: perfilOperativoMIA.availability || null,
        },
        mia_organization: {
          organization_id: organizationContext.organization_id || null,
          brand_name: organizationContext.brand_name || 'Ruralicos',
          available: organizationContext.available !== false,
        },
        mia_decision_id: decisionStore.decision_id || null,
        mia_actions_planned: decisionStore.actions_planned || 0,
        mia_actions_inserted: decisionStore.actions_inserted || 0,
        intencion: interpretacion.intencion,
        resumen_para_log: interpretacion.resumen_para_log,
        requiere_respuesta: Boolean(decisionMIA.reply_action),
        mia_outbox_id: outboxMIA.id || null,
        mia_outbox_queued: outboxMIA.queued || false,
        mia_outbox_existing: outboxMIA.existing || false,
        mia_outbox_available: outboxMIA.available !== false,
        mia_agent_case_id: casoAgente.id || null,
        mia_agent_case_created: casoAgente.created || false,
        mia_agent_case_existing: casoAgente.existing || false,
        mia_agent_case_available: casoAgente.available !== false,
        mia_agent_conversation_id: conversacionAgente.id || null,
        mia_agent_conversation_created: conversacionAgente.created || false,
        mia_agent_conversation_updated: conversacionAgente.updated || false,
        memorias_estructuradas_guardadas: memoriaEstructurada.inserted || 0,
        memoria_estructurada_available: memoriaEstructurada.available !== false,
        ...guardado,
      };

      await actualizarInboundMIA(supabase, inboundMIA?.id, {
        status: 'processed',
        user_id: user.id,
        organization_id: organizationId,
        digest_id: digest?.id || null,
        conversation_id: conversacionActiva?.id || null,
        decision_json: decisionMIA,
        result_json: result,
      });
      await actualizarDecisionResultadoMIA(supabase, decisionStore.decision_id, result);

      await guardarWebhookEvent(req, result, null);

      return res.json(result);
    } catch (err) {
      // El detalle queda en inbound/webhook_events y en el log del servidor;
      // al llamador (UltraMsg, un tercero) solo le viaja un error generico.
      await actualizarInboundMIA(supabase, inboundMIA?.id, {
        status: 'failed',
        error_msg: err.message,
      });
      await guardarWebhookEvent(req, null, err);
      return responderError(req, res, err);
    }
  });
}

module.exports = feedbackRoutes;
module.exports.__testing = {
  buscarConversacionActiva,
  cargarDigestYAlertas,
  esConversacionMIADelDia,
  fechaMadridConversacionMIA,
  getExpiracionFinDiaMadridISO,
  cargarUltimoDigestEntregadoReciente,
  cargarContextoRecienteMIA,
  construirConsultaContextualMIA,
  extraerItemsReferenciadosInequivocamente,
};
