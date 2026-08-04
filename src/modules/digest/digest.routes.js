// src/modules/digest/digest.routes.js
//
// Capa HTTP del digest: registra las rutas /alertas/preparar-digest,
// enviar-digest, preview-digest y diagnosticar-digest sobre Express. La logica
// vive en digest.service.js.
//
// Sistema de digest personalizado por usuario — 1 mensaje WhatsApp al día.
//
// Flujo:
//   /alertas/preparar-digest  → filtra alertas por plan + preferencias de cada usuario,
//                               genera 1 mensaje IA personalizado y lo guarda en tabla digests.
//   /alertas/enviar-digest    → envía los digests pendientes con delay anti-ban.
//
// Lógica por plan:
//   corral      → solo alertas fuente BOE, máx 1 provincia / 1 sector / 2 subsectores
//   agricultor  → BOE + autonómicos, máx 2 provincias / todos los sectores / 4 subsectores, campo libre
//   cooperativa → todas las fuentes, sin límites, campo libre, modelo IA más potente
//   free        → no recibe digest (usa alertasFree.js)
//
// Si el usuario no tiene alertas relevantes hoy → silencio total (no se envía nada).
//
// NAVEGACION PARA IA: no leer el archivo entero. Sus entradas son
// diagnosticarDigestHandler, previewDigestHandler, prepararDigestHandler y
// enviarDigestHandler. La logica reutilizable vive en digest.service.js.



const { checkCronToken }           = require('../../middleware/cronToken');

const { getPlan }                  = require('../../config/planes');

const { fusionarAlertasUnicas }     = require('../alertas/seleccion/alertCandidateMerge');
const {
  decidirAlertaParaDigest,
  filtrarAlertasParaDigest,
  seleccionarAlertasParaDigest,
} = require('../alertas/seleccion/alertSelectionGate');
const { getFechaMadridISO } = require('../../shared/fechaMadrid');
const { registrarDigestItemsMIA }  = require('../mia/digestItems');
const {
  encolarDigestsPendientes,
} = require('./digestOutbox');
const {
  crearPresupuestoJuezDiario,
  decidirAlertasDigest,
} = require('./decisionIntegration');
const { renderDecisionDigestMessage } = require('./decisionMessage');
const { recoverDecisionHolds } = require('./decisionEvidenceRecovery');
const {
  holdRetryPolicy,
  reclamarHoldsDecisionUsuario,
  adjuntarRetryAAlerta,
  finalizarHoldsDecision,
  cerrarHoldsSinAlerta,
} = require('./decisionHoldRetry');
const {
  DELIVERY_STATUS,
  crearIdempotencyKey,
  crearMessageVersion,
} = require('../delivery/deliveryState');
const {
  esDigestAttemptTerminalActual,
  registrarDigestAttempt,
} = require('../mia/digestAttempts');
const {
  registrarDigestCandidateDecisions,
  registrarDigestCandidateDecisionsCanonicas,
  vincularDigestCandidateDecisions,
} = require('../mia/digestCandidateDecisions');
const {
  cargarPerfilOperativoMIA,
  aplicarPerfilOperativoAUsuario,
  ordenarAlertasConPerfilOperativoMIA,
} = require('../mia/userProfile');

const {
  conOrganizationId,
  extraerOrganizationId,
  filtrarAlertasPorOrganization,
  cargarOrganizationContextMIA,
  aplicarOrganizationContextAUsuario,
} = require('../mia/organizationContext');

const {

  PREPARAR_DIGEST_BATCH_SIZE,
  DIGEST_QUALITY_GATE,
  DIGEST_INCLUDE_REVIEW,
  DIGEST_INCLUDE_INDIVIDUAL_PROVINCIAL,
  DIGEST_REVIEW_MIN_QUALITY_SCORE,
  DIGEST_RESCUE_ENABLED,
  DIGEST_RESCUE_AFTER_DAYS,
  DIGEST_RESCUE_LOOKBACK_DAYS,
  DIGEST_RESCUE_MAX_ALERTAS,
  DIGEST_VECTOR_BACKFILL_MIN,
  DIGEST_FACT_SHEET_BACKFILL_RESERVE,
  DIGEST_FINAL_VALIDATION_MODE,
  DIGEST_FINAL_VALIDATION_ENFORCEMENT,
  ALERTA_DIGEST_SELECT,
  getMaxAlertasDigestUsuario,
  sumarDiasFechaISO,
  motivoUsuarioNoRecibeDigest,
  cargarAlertasListasDigest,
  cargarUsuariosPagoDigest,
  cargarUltimosDigestEnviados,
  filtrarAlertasNoEnviadas,
  necesitaRescateSemanal,
  alertaExcluidaPorPreferenciasExtra,
  prepararAlertasFinalesDigest,
  resumirValidacionFinalDigest,
  prepararValidacionFinalDigestShadow,
  preseleccionarAlertasConFactSheet,
  guardarFactSheetsDigestShadow,
  filtrarAlertasPorValidacionFinalDigest,
  alertasReintentablesPorTextoAusente,
  validacionReintentablePorTextoAusente,
  filtrarAlertasEnviablesAutomaticamente,
  resumirSeleccionDigest,
  contarDecisionesTrasScoring,
  construirFunnelDigest,
  resolverMotivoNoEnvioDigest,
  filtrarAlertasPorCalidadDigest,
  prepararMensajeConLinksTracking,
  obtenerAprendizajeUsuario,
  ordenarPorAprendizaje,
  seleccionarAlertasRescate,
  seleccionarAlertasConMIA,
  abrirConversacionFeedbackDigest,
  registrarExploracionDigest,
  construirPreviewDigestUsuario,
} = require('./digest.service');

function decisionesValidacionFinal(alertas = [], validation = null) {
  const items = Array.isArray(validation?.item_results) ? validation.item_results : [];
  return (alertas || []).map((alerta) => {
    const item = items.find((candidate) =>
      String(candidate?.alerta_id ?? '') === String(alerta.id)
    ) || {};
    return {
      id: alerta.id,
      action: item.status === 'send' ? 'include' : (item.status || 'blocked'),
      motivo: item.reasons?.[0]?.code ||
        item.flags?.[0] ||
        (item.status === 'send' ? 'final_validation_send' : 'final_validation_missing'),
      status: item.status || 'missing',
      flags: item.flags || [],
      reasons: item.reasons || [],
      match_trace: alerta.decision_digest?.match_trace || alerta.decision_digest?.diagnostico?.match_trace || null,
    };
  });
}

function construirValidacionFinalFallida(alertas = [], reason = 'final_validation_error', error = null) {
  const itemResults = (alertas || []).map((alerta) => ({
    alerta_id: alerta.id,
    status: reason === 'final_validation_timeout' ? 'timeout' : 'error',
    flags: [reason],
    reasons: [{
      code: reason,
      status: 'blocked',
      detail: String(error?.message || error || 'La validacion final no pudo completarse.').slice(0, 500),
    }],
  }));
  return {
    ok: false,
    status: 'blocked',
    flags: [reason],
    item_results: itemResults,
    diagnostics: {
      items_total: itemResults.length,
      items_send: 0,
      items_review_only: 0,
      items_blocked: itemResults.length,
    },
  };
}

function decisionesGateEfectivo(enforcement = null) {
  return (enforcement?.decisions || []).map((entry) => ({
    id: entry.alerta?.id,
    action: entry.automatic_send_allowed ? 'include' : 'blocked',
    motivo: entry.effective_reason,
    selection_decision: entry.selection_decision,
    final_validation_decision: entry.final_validation_decision,
    effective_send_decision: entry.effective_send_decision,
    effective_reason: entry.effective_reason,
    automatic_send_allowed: entry.automatic_send_allowed,
    gate_version: entry.gate_version,
    context: entry.context,
    match_trace: entry.selection_decision?.match_trace ||
      entry.selection_decision?.diagnostico?.match_trace ||
      null,
  }));
}

module.exports = function digestRoutes(app, supabase) {

  const diagnosticarDigestHandler = async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const phone = req.query.phone ? String(req.query.phone).replace(/\D/g, '') : null;
      const userId = req.query.user_id ? Number(req.query.user_id) : null;

      if (!phone && !userId) {
        return res.status(400).json({ error: 'Indica phone o user_id' });
      }

      const userQuery = supabase
        .from('users')
        .select('id, name, first_name, phone, subscription, preferences, preferencias_extra, organization_id');

      const { data: user, error: errUser } = userId
        ? await userQuery.eq('id', userId).maybeSingle()
        : await userQuery.eq('phone', phone).maybeSingle();

      if (errUser) return res.status(500).json({ error: errUser.message });
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const plan = getPlan(user.subscription);
      const organizationId = extraerOrganizationId(user);
      const { data: alertasRaw, error: errAlertas } = await supabase
        .from('alertas')
        .select(ALERTA_DIGEST_SELECT)
        .eq('fecha', fecha)
        .eq('estado_ia', 'listo')
        .order('id', { ascending: true });

      if (errAlertas) return res.status(500).json({ error: errAlertas.message });
      const alertas = filtrarAlertasPorOrganization(alertasRaw || [], organizationId);

      const detalle = (alertas || []).map((alerta) => {
        const decision = decidirAlertaParaDigest(alerta, user, {
          qualityGate: DIGEST_QUALITY_GATE,
          allowReview: DIGEST_INCLUDE_REVIEW,
          minReviewQualityScore: DIGEST_REVIEW_MIN_QUALITY_SCORE,
          allowIndividualWithoutMunicipio: DIGEST_INCLUDE_INDIVIDUAL_PROVINCIAL,
          exclusionPreferencias: (item) => alertaExcluidaPorPreferenciasExtra(item, user.preferencias_extra),
        });

        return {
          id: alerta.id,
          titulo: alerta.titulo,
          fuente: alerta.fuente || 'BOE',
          incluida: decision.incluir,
          motivo: decision.motivo,
          riesgo: decision.riesgo,
          detalle: decision.detalle,
          calidad: decision.diagnostico.calidad,
        };
      });

      const resumen = detalle.reduce((acc, item) => {
        const clave = item.incluida ? 'incluidas' : item.motivo;
        acc[clave] = (acc[clave] || 0) + 1;
        return acc;
      }, {});

      return res.json({
        ok: true,
        fecha,
        user: {
          id: user.id,
          phone: user.phone,
          subscription: user.subscription,
          plan: plan.nombre,
          preferences: user.preferences || {},
          preferencias_extra: user.preferencias_extra || null,
        },
        total_alertas_listas: (alertas || []).length,
        resumen,
        detalle,
      });
    } catch (err) {
      console.error('Error en /alertas/diagnosticar-digest', err);
      return res.status(500).json({ error: err.message });
    }
  };

  const previewDigestHandler = async (req, res) => {
    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || req.body?.fecha || '')
        ? (req.query.fecha || req.body?.fecha)
        : getFechaMadridISO();
      const phone = req.query.phone || req.body?.phone
        ? String(req.query.phone || req.body?.phone).replace(/\D/g, '')
        : null;
      const userId = req.query.user_id || req.body?.user_id
        ? Number(req.query.user_id || req.body?.user_id)
        : null;
      const usarIA = String(req.query.ia ?? req.body?.ia ?? 'false').toLowerCase() === 'true';
      const incluirRescate = String(req.query.rescate ?? req.body?.rescate ?? 'true').toLowerCase() !== 'false';

      if (!phone && !userId) {
        return res.status(400).json({ error: 'Indica phone o user_id' });
      }

      const userQuery = supabase
        .from('users')
        .select('id, name, first_name, phone, phone_verified, subscription, preferences, preferencias_extra, organization_id, perfil_embedding, perfil_actualizado_at, contexto_narrativo');

      const { data: user, error: errUser } = userId
        ? await userQuery.eq('id', userId).maybeSingle()
        : await userQuery.eq('phone', phone).maybeSingle();

      if (errUser) return res.status(500).json({ error: errUser.message });
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const preview = await construirPreviewDigestUsuario(supabase, {
        user,
        fecha,
        usarIA,
        incluirRescate,
      });

      return res.json(preview);
    } catch (err) {
      console.error('Error en /alertas/preview-digest', err);
      return res.status(500).json({ error: err.message });
    }
  };

  // ──────────────────────────────────────────────────────────────────
  // /alertas/preparar-digest
  // Cron recomendado: 07:30h
  // ──────────────────────────────────────────────────────────────────
  const prepararDigestHandler = async (req, res) => {
    try {
      const hoy = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();

      const force = String(req.query.force || req.body?.force || '').toLowerCase() === 'true';
      const limiteRaw = Number(req.query.limit || req.body?.limit || process.env.PREPARAR_DIGEST_BATCH_SIZE || PREPARAR_DIGEST_BATCH_SIZE);
      const limiteDigests = Math.max(1, Math.min(50, Number.isFinite(limiteRaw) ? limiteRaw : PREPARAR_DIGEST_BATCH_SIZE));

      // 1) Alertas del día listas para enviar
      const { data: alertasDia, error: errAlertas } = await cargarAlertasListasDigest(supabase, { fecha: hoy });

      if (errAlertas) return res.status(500).json({ error: errAlertas.message });

      // 2) Compuerta de calidad antes de personalizar por usuario
      const totalAlertasDia = (alertasDia || []).length;
      let alertas = alertasDia || [];
      let alertasDescartadasCalidad = [];
      if (DIGEST_QUALITY_GATE) {
        const calidad = filtrarAlertasPorCalidadDigest(alertas, { minScore: 65 });
        alertas = calidad.aceptadas;
        alertasDescartadasCalidad = calidad.rechazadas;

        if (alertasDescartadasCalidad.length > 0) {
          console.warn(`[digest:quality] ${alertasDescartadasCalidad.length} alertas descartadas por calidad antes del digest`);
        }
      }

      if (totalAlertasDia === 0) {
        console.log('[digest] No hay alertas listas hoy; se revisaran rescates semanales si aplica');
      } else if (!alertas || alertas.length === 0) {
        console.log('[digest] No hay alertas con calidad suficiente hoy; se revisaran rescates semanales si aplica');
      }

      // 3) Usuarios de pago
      const { data: usuarios, error: errUsuarios } = await cargarUsuariosPagoDigest(supabase);

      if (errUsuarios) return res.status(500).json({ error: errUsuarios.message });

      if (!usuarios || usuarios.length === 0) {
        return res.json({
          success: true,
          mensaje:           'No hay usuarios con plan activo',
          fecha:             hoy,
          digests_generados: 0,
        });
      }

      // 3) Usuarios que ya tienen digest hoy (idempotencia)
      const { data: digestsExistentes, error: errDigestsExistentes } = await supabase
        .from('digests')
        .select('id, user_id, enviado, delivery_status, idempotency_key, message_version')
        .eq('fecha', hoy);

      if (errDigestsExistentes) return res.status(500).json({ error: errDigestsExistentes.message });

      const digestsPorUsuario = new Map((digestsExistentes || []).map((d) => [d.user_id, d]));
      const estadosAttemptTerminales = [
        'no_send',
        'generated',
        'rescued',
        'sent',
        'skipped_existing',
        'failed',
      ];
      let usuariosAttemptTerminal = new Set();

      if (!force) {
        const { data: attemptsTerminales, error: errAttemptsTerminales } = await supabase
          .from('digest_attempts')
          .select('user_id, status, metadata_json')
          .eq('fecha', hoy)
          .in('status', estadosAttemptTerminales);

        if (errAttemptsTerminales) {
          return res.status(500).json({ error: errAttemptsTerminales.message });
        }

        usuariosAttemptTerminal = new Set(
          (attemptsTerminales || [])
            .filter(esDigestAttemptTerminalActual)
            .map((attempt) => attempt.user_id)
        );
      }

      const usuariosPendientes = usuarios.filter((user) => {
        const digestExistente = digestsPorUsuario.get(user.id);
        if (force) {
          const estado = String(digestExistente?.delivery_status || '').toUpperCase();
          const regenerable = !estado || [
            DELIVERY_STATUS.DRAFT,
            DELIVERY_STATUS.APPROVED,
            DELIVERY_STATUS.FAILED,
          ].includes(estado);
          return !digestExistente?.enviado && regenerable;
        }
        return !digestExistente && !usuariosAttemptTerminal.has(user.id);
      });
      const usuariosBatch = usuariosPendientes.slice(0, limiteDigests);
      const judgeBudget = await crearPresupuestoJuezDiario({ supabase });
      const userIds = usuarios.map((user) => user.id).filter(Boolean);
      const desdeRescate = sumarDiasFechaISO(hoy, -(DIGEST_RESCUE_LOOKBACK_DAYS - 1));
      const ultimosEnviadosPorUsuario = await cargarUltimosDigestEnviados(
        supabase,
        userIds,
        desdeRescate
      );
      let alertasRescateCache = null;

      let generados  = 0;
      let sinAlertas = 0;
      let saltados   = 0;
      let rescatados = 0;
      let sinTelefono = 0;
      const errores  = [];
      let usuariosEvaluados = 0;

      // 4) Procesar usuario a usuario
      for (const user of usuariosBatch) {
        usuariosEvaluados++;

        // Ya tiene digest hoy → saltar
        // Con force=true se rehace solo si aun no fue enviado.
        const digestExistente = digestsPorUsuario.get(user.id);
        const plan = getPlan(user.subscription);

        if (digestExistente?.enviado) {
          saltados++;
          continue;
        }

        if (digestExistente && !force) {
          await registrarDigestAttempt(supabase, {
            userId: user.id,
            fecha: hoy,
            kind: 'daily',
            status: 'skipped_existing',
            totalAlertasDia,
            trasQualityGate: alertas.length,
            metadata: {
              plan: plan.nombre,
              enviado: Boolean(digestExistente.enviado),
              existing_digest_id: digestExistente.id,
            },
          });
          saltados++;
          continue;
        }

        const motivoNoRecibe = motivoUsuarioNoRecibeDigest(user);
        if (motivoNoRecibe) {
          await registrarDigestAttempt(supabase, {
            userId: user.id,
            fecha: hoy,
            kind: 'daily',
            status: 'no_send',
            totalAlertasDia,
            trasQualityGate: alertas.length,
            motivoNoEnvio: motivoNoRecibe,
            metadata: { plan: plan.nombre },
          });
          sinTelefono++;
          continue;
        }

        const organizationContext = await cargarOrganizationContextMIA(supabase, user);
        const organizationId = organizationContext.organization_id || null;
        const userConOrganization = aplicarOrganizationContextAUsuario(user, organizationContext);
        const retryPolicy = holdRetryPolicy();
        let holdsReclamados = [];
        let alertasHoldRetry = [];
        try {
          const retryClaim = await reclamarHoldsDecisionUsuario(supabase, {
            userId: user.id,
            policy: retryPolicy,
          });
          holdsReclamados = retryClaim.claimed;
          if (holdsReclamados.length > 0) {
            const { data: alertasRetry, error: retryAlertError } = await cargarAlertasListasDigest(supabase, {
              ids: holdsReclamados.map((hold) => hold.alerta_id),
              requireReady: false,
            });
            if (retryAlertError) throw retryAlertError;
            const visibles = filtrarAlertasPorOrganization(alertasRetry || [], organizationId);
            holdsReclamados = await cerrarHoldsSinAlerta(supabase, {
              claimed: holdsReclamados,
              loadedAlertIds: visibles.map((alerta) => alerta.id),
            });
            const holdByAlert = new Map(holdsReclamados.map((hold) => [String(hold.alerta_id), hold]));
            alertasHoldRetry = visibles
              .filter((alerta) => holdByAlert.has(String(alerta.id)))
              .map((alerta) => adjuntarRetryAAlerta(alerta, holdByAlert.get(String(alerta.id)), {
                policy: retryPolicy,
              }));
          }
        } catch (holdRetryError) {
          if (holdsReclamados.length > 0) {
            try {
              await finalizarHoldsDecision(supabase, {
                claimed: holdsReclamados,
                decisions: [],
                policy: retryPolicy,
              });
            } catch (releaseError) {
              errores.push({ userId: user.id, warning: 'hold_retry_release_failed', error: releaseError.message });
            }
          }
          holdsReclamados = [];
          alertasHoldRetry = [];
          errores.push({ userId: user.id, warning: 'hold_retry_load_failed', error: holdRetryError.message });
        }
        const attemptStart = await registrarDigestAttempt(supabase, {
          userId: user.id,
          organizationId,
          fecha: hoy,
          kind: 'daily',
          status: 'evaluating',
          ...construirFunnelDigest({
            totalAlertasDia,
            trasQualityGate: alertas.length,
          }),
          metadata: {
            plan: plan.nombre,
            audit_version: 'digest_candidate_audit_v1',
            hold_retries_claimed: alertasHoldRetry.length,
          },
        });
        let digestAttemptId = attemptStart.id || null;
        let attemptKind = 'daily';

        // Las etapas quality_gate, organization_visibility y user_filter ya no
        // se persisten fila a fila: nadie las leía y generaban ~32.000 filas
        // diarias. El embudo por barrera del contrato canónico
        // (`ranking_funnel.stopped_by`) conserva esa explicación de forma
        // agregada en el intento del día.

        // Filtrar alertas relevantes para este usuario
        const alertasVisibles = filtrarAlertasPorOrganization(alertas, organizationId);
        const decisionFn = (alerta) => decidirAlertaParaDigest(alerta, userConOrganization, {
          qualityGate: DIGEST_QUALITY_GATE,
          allowReview: DIGEST_INCLUDE_REVIEW,
          minReviewQualityScore: DIGEST_REVIEW_MIN_QUALITY_SCORE,
          allowIndividualWithoutMunicipio: DIGEST_INCLUDE_INDIVIDUAL_PROVINCIAL,
          exclusionPreferencias: (item) => alertaExcluidaPorPreferenciasExtra(item, user.preferencias_extra),
        });
        const seleccionBase = filtrarAlertasParaDigest(alertasVisibles, userConOrganization, {
          qualityGate: DIGEST_QUALITY_GATE,
          allowReview: DIGEST_INCLUDE_REVIEW,
          minReviewQualityScore: DIGEST_REVIEW_MIN_QUALITY_SCORE,
          allowIndividualWithoutMunicipio: DIGEST_INCLUDE_INDIVIDUAL_PROVINCIAL,
          exclusionPreferencias: (item) => alertaExcluidaPorPreferenciasExtra(item, user.preferencias_extra),
        });
        const alertasUsuario = seleccionBase.alertas;
        const perfilOperativoMIA = await cargarPerfilOperativoMIA(supabase, user.id, { user: userConOrganization });
        const aprendizaje = perfilOperativoMIA.availability?.user_interest_profile
          ? perfilOperativoMIA.interest_profile
          : await obtenerAprendizajeUsuario(supabase, user.id);
        const userConPerfilMIA = aplicarPerfilOperativoAUsuario(userConOrganization, perfilOperativoMIA);
        const alertasConPerfilMIA = ordenarAlertasConPerfilOperativoMIA(alertasUsuario, perfilOperativoMIA);
        const seleccionMIA = await seleccionarAlertasConMIA(supabase, {
          user: userConPerfilMIA,
          fecha: hoy,
          alertasFallback: alertasConPerfilMIA,
          organizationId,
          decisionFn,
        });
        const usandoMIA = Boolean(seleccionMIA?.alertas?.length);
        const candidatasFinales = usandoMIA
          ? fusionarAlertasUnicas(seleccionMIA.alertas, alertasConPerfilMIA)
          : alertasConPerfilMIA;
        const alertasOrdenadas = usandoMIA
          ? ordenarAlertasConPerfilOperativoMIA(candidatasFinales, perfilOperativoMIA, { excludeHard: false })
          : ordenarPorAprendizaje(candidatasFinales, aprendizaje);
        const maxAlertasUsuario = getMaxAlertasDigestUsuario(userConPerfilMIA);
        const topKCandidatas = Math.max(
          maxAlertasUsuario,
          Math.min(20, Number(process.env.ALERT_DECISION_TOP_K) || 10)
        );
        const maxCandidateUnion = Math.min(20, topKCandidatas + 5);
        const maxCandidatasConBackfill = Math.min(alertasOrdenadas.length, topKCandidatas);
        const seleccionFinal = seleccionarAlertasParaDigest(alertasOrdenadas, userConPerfilMIA, {
          qualityGate: DIGEST_QUALITY_GATE,
          allowReview: DIGEST_INCLUDE_REVIEW,
          minReviewQualityScore: DIGEST_REVIEW_MIN_QUALITY_SCORE,
          allowIndividualWithoutMunicipio: DIGEST_INCLUDE_INDIVIDUAL_PROVINCIAL,
          minItems: Math.min(DIGEST_VECTOR_BACKFILL_MIN, maxAlertasUsuario),
          targetItems: maxAlertasUsuario,
          maxItems: maxCandidatasConBackfill,
          origen: usandoMIA ? seleccionMIA.origen : 'perfil_tags_prioridad',
          exclusionPreferencias: (item) => alertaExcluidaPorPreferenciasExtra(item, user.preferencias_extra),
        });
        await registrarDigestCandidateDecisions(supabase, {
          userId: user.id,
          organizationId,
          fecha: hoy,
          kind: 'daily',
          stage: 'selection',
          digestAttemptId,
          decisions: seleccionFinal.decisiones,
          metadata: { origen: usandoMIA ? seleccionMIA.origen : 'perfil_tags_prioridad' },
        });
        // La selección antigua aporta una señal barata, pero ya no es la
        // autoridad. La unión acotada permite que semántica/memoria compitan en
        // el top K canónico sin rescatar ningún bloqueo duro previo.
        let alertasFinales = fusionarAlertasUnicas(
          alertasHoldRetry,
          seleccionFinal.alertas,
          alertasOrdenadas
        ).slice(0, maxCandidateUnion);
        let canonicalDecisionResult = null;
        let modoRescate = null;
        const funnelActual = (finales = 0) => construirFunnelDigest({
          totalAlertasDia,
          totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
          trasQualityGate: modoRescate?.alertasVentanaTrasCalidad ?? alertas.length,
          trasFiltroUsuario: modoRescate?.trasFiltroUsuario ?? alertasUsuario.length,
          trasScoring: modoRescate?.trasScoring ?? contarDecisionesTrasScoring(seleccionFinal),
          alertasFinales: finales,
        });

        // Sin alertas relevantes → silencio
        if (alertasFinales.length === 0) {
          const rescateElegible = necesitaRescateSemanal(user, ultimosEnviadosPorUsuario, hoy);

          if (rescateElegible) {
            if (!alertasRescateCache) {
              const { data: alertasVentana, error: errRescate } = await cargarAlertasListasDigest(supabase, {
                desde: desdeRescate,
                hasta: hoy,
              });
              if (errRescate) {
                console.warn('[digest:rescue] No se pudieron cargar alertas de rescate:', errRescate.message);
                alertasRescateCache = {
                  alertas: [],
                  raw: [],
                  rechazadas: [],
                  total: 0,
                  descartadasCalidad: 0,
                  error: errRescate.message,
                };
              } else if (DIGEST_QUALITY_GATE) {
                const calidadRescate = filtrarAlertasPorCalidadDigest(alertasVentana || [], { minScore: 65 });
                alertasRescateCache = {
                  alertas: calidadRescate.aceptadas,
                  raw: alertasVentana || [],
                  rechazadas: calidadRescate.rechazadas,
                  total: (alertasVentana || []).length,
                  descartadasCalidad: calidadRescate.rechazadas.length,
                };
              } else {
                alertasRescateCache = {
                  alertas: alertasVentana || [],
                  raw: alertasVentana || [],
                  rechazadas: [],
                  total: (alertasVentana || []).length,
                  descartadasCalidad: 0,
                };
              }
            }

            const idsYaEnviados = ultimosEnviadosPorUsuario.get(user.id)?.alerta_ids_enviadas || new Set();
            const alertasRescateNoRepetidas = filtrarAlertasNoEnviadas(
              alertasRescateCache.alertas,
              idsYaEnviados
            );
            const rescate = seleccionarAlertasRescate({
              alertas: alertasRescateNoRepetidas,
              user: userConPerfilMIA,
              aprendizaje,
              perfilOperativoMIA,
              organizationId,
              maxItems: Math.min(
                getMaxAlertasDigestUsuario(userConPerfilMIA),
                DIGEST_RESCUE_MAX_ALERTAS + DIGEST_FACT_SHEET_BACKFILL_RESERVE
              ),
            });

            alertasFinales = rescate.alertas;
            modoRescate = {
              tipo: rescate.tipo,
              desde: desdeRescate,
              totalAlertasVentana: alertasRescateCache.total,
              alertasVentanaTrasCalidad: alertasRescateCache.alertas.length,
              descartadasCalidad: alertasRescateCache.descartadasCalidad,
              trasFiltroUsuario: rescate.trasFiltroUsuario,
              trasScoring: rescate.trasScoring,
            };
            await registrarDigestAttempt(supabase, {
              userId: user.id,
              organizationId,
              fecha: hoy,
              kind: 'daily',
              status: 'no_send',
              ...construirFunnelDigest({
                totalAlertasDia,
                trasQualityGate: alertas.length,
                trasFiltroUsuario: alertasUsuario.length,
                trasScoring: contarDecisionesTrasScoring(seleccionFinal),
                alertasFinales: 0,
              }),
              motivoNoEnvio: 'daily_sin_alertas_rescate_iniciado',
              metadata: {
                plan: plan.nombre,
                rescue_kind: rescate.tipo,
              },
            });
            attemptKind = 'rescue';
            const rescueAttempt = await registrarDigestAttempt(supabase, {
              userId: user.id,
              organizationId,
              fecha: hoy,
              kind: attemptKind,
              status: 'evaluating',
              ...construirFunnelDigest({
                totalAlertasDia,
                totalAlertasVentana: modoRescate.totalAlertasVentana,
                trasQualityGate: modoRescate.alertasVentanaTrasCalidad,
                trasFiltroUsuario: modoRescate.trasFiltroUsuario,
                trasScoring: modoRescate.trasScoring,
                alertasFinales: alertasFinales.length,
              }),
              metadata: {
                plan: plan.nombre,
                rescate: modoRescate,
                audit_version: 'digest_candidate_audit_v1',
              },
            });
            digestAttemptId = rescueAttempt.id || digestAttemptId;
            await registrarDigestCandidateDecisions(supabase, {
              userId: user.id,
              organizationId,
              fecha: hoy,
              kind: attemptKind,
              stage: 'selection',
              digestAttemptId,
              decisions: rescate.decisiones,
              metadata: { rescue_type: rescate.tipo },
            });
            console.log(`[digest:rescue] User ${user.id} (${plan.nombre}) → rescate ${rescate.tipo} con ${alertasFinales.length} alertas`);
          } else {
            const motivoNoEnvio = resolverMotivoNoEnvioDigest({
              totalAlertasDia,
              alertasTrasQualityGate: alertas,
              alertasVisibles,
              seleccionBase,
              alertasOrdenadas,
            });

            await registrarDigestAttempt(supabase, {
              userId: user.id,
              fecha: hoy,
              kind: 'daily',
              status: 'no_send',
              ...funnelActual(0),
              motivoNoEnvio,
              metadata: {
                plan: plan.nombre,
                rescate_enabled: DIGEST_RESCUE_ENABLED,
                rescate_elegible: false,
                seleccion_base: resumirSeleccionDigest(seleccionBase),
                seleccion_final: resumirSeleccionDigest(seleccionFinal),
              },
            });

            sinAlertas++;
            console.log(`[digest] User ${user.id} (${plan.nombre}) → 0 alertas relevantes → sin digest`);
            continue;
          }
        }

        const maxAlertasTrasFactSheet = modoRescate
          ? Math.min(DIGEST_RESCUE_MAX_ALERTAS, maxAlertasUsuario)
          : maxAlertasUsuario;
        const preseleccionFactSheet = await preseleccionarAlertasConFactSheet({
          supabase,
          alertas: alertasFinales,
          maxItems: maxCandidateUnion,
          organizationId,
        });
        alertasFinales = preseleccionFactSheet.candidates || preseleccionFactSheet.alertas;
        await registrarDigestCandidateDecisionsCanonicas(supabase, {
          userId: user.id,
          organizationId,
          fecha: hoy,
          kind: attemptKind,
          stage: 'fact_sheet_preselection',
          digestAttemptId,
          decisions: preseleccionFactSheet.decisions,
          metadata: preseleccionFactSheet.diagnostics,
        });
        for (const warning of preseleccionFactSheet.warnings) {
          errores.push({ userId: user.id, ...warning });
        }

        if (alertasFinales.length === 0) {
          if (holdsReclamados.length > 0) {
            await finalizarHoldsDecision(supabase, {
              claimed: holdsReclamados,
              decisions: [],
              policy: retryPolicy,
            });
            holdsReclamados = [];
          }
          await registrarDigestAttempt(supabase, {
            userId: user.id,
            fecha: hoy,
            kind: attemptKind,
            status: 'no_send',
            ...funnelActual(0),
            motivoNoEnvio: 'fact_sheet_preselection_no_send',
            metadata: {
              plan: plan.nombre,
              rescate: modoRescate,
              fact_sheet_preselection: preseleccionFactSheet.diagnostics,
            },
          });
          sinAlertas++;
          console.log(`[digest] User ${user.id} -> ninguna candidata supero la ficha previa -> sin digest`);
          continue;
        }

        const origenDigest = modoRescate
          ? `rescate_semanal_${modoRescate.tipo}`
          : (usandoMIA ? seleccionMIA.origen : 'perfil_tags_prioridad');
        let recoveryDiagnostics = [];

        try {
          const decisionBase = {
            supabase,
            user: userConPerfilMIA,
            perfilOperativo: perfilOperativoMIA,
            exploracion: seleccionMIA?.exploracion || null,
            fecha: hoy,
            budget: judgeBudget,
            policy: {
              topK: topKCandidatas,
              maxItems: maxAlertasTrasFactSheet,
            },
          };
          const initialDecisionResult = await decidirAlertasDigest({
            ...decisionBase,
            alertas: alertasFinales,
          });
          const recovery = await recoverDecisionHolds({
            supabase,
            result: initialDecisionResult,
            alertas: alertasFinales,
          });
          recoveryDiagnostics = recovery.diagnostics;
          canonicalDecisionResult = initialDecisionResult;
          if (recovery.reevaluate) {
            await registrarDigestCandidateDecisions(supabase, {
              userId: user.id,
              organizationId,
              fecha: hoy,
              kind: attemptKind,
              stage: 'personal_relevance_before_recovery',
              digestAttemptId,
              decisions: initialDecisionResult.audit_decisions,
              metadata: { recovery: recovery.diagnostics },
            });
            canonicalDecisionResult = await decidirAlertasDigest({
              ...decisionBase,
              alertas: recovery.alertas,
            });
          }
          for (const diagnostic of recovery.diagnostics) {
            if (diagnostic.status === 'FAILED') {
              errores.push({
                userId: user.id,
                alertaId: diagnostic.alert_id,
                warning: 'hold_recovery_failed',
                error: diagnostic.error || null,
              });
            }
          }
        } catch (decisionError) {
          if (holdsReclamados.length > 0) {
            try {
              await finalizarHoldsDecision(supabase, {
                claimed: holdsReclamados,
                decisions: [],
                policy: retryPolicy,
              });
            } catch (releaseError) {
              errores.push({ userId: user.id, warning: 'hold_retry_release_failed', error: releaseError.message });
            }
          }
          await registrarDigestAttempt(supabase, {
            userId: user.id,
            organizationId,
            fecha: hoy,
            kind: attemptKind,
            status: 'failed',
            ...funnelActual(0),
            judgeEvaluatedCount: 0,
            approvedCount: 0,
            motivoNoEnvio: 'canonical_decision_error',
            errorMsg: decisionError.message,
            metadata: { plan: plan.nombre, origen: origenDigest },
          });
          errores.push({ userId: user.id, error: decisionError.message, stage: 'canonical_decision' });
          continue;
        }

        await registrarDigestCandidateDecisionsCanonicas(supabase, {
          userId: user.id,
          organizationId,
          fecha: hoy,
          kind: attemptKind,
          stage: 'personal_relevance_judge',
          digestAttemptId,
          decisions: canonicalDecisionResult.audit_decisions,
          metadata: {
            contract_version: canonicalDecisionResult.contract_version,
            policy_version: canonicalDecisionResult.policy_version,
            funnel: canonicalDecisionResult.ranking?.funnel || null,
            portfolio: canonicalDecisionResult.portfolio?.counts || null,
            recovery: recoveryDiagnostics,
          },
        });
        if (holdsReclamados.length > 0) {
          await finalizarHoldsDecision(supabase, {
            claimed: holdsReclamados,
            decisions: canonicalDecisionResult.audit_decisions,
            policy: retryPolicy,
          });
          holdsReclamados = [];
        }

        alertasFinales = prepararAlertasFinalesDigest(
          canonicalDecisionResult.alertas,
          userConPerfilMIA,
          {
            origenDigest,
            modoRescate,
            fecha: hoy,
          }
        );

        if (alertasFinales.length === 0) {
          await registrarDigestAttempt(supabase, {
            userId: user.id,
            organizationId,
            fecha: hoy,
            kind: attemptKind,
            status: 'no_send',
            ...funnelActual(0),
            judgeEvaluatedCount: canonicalDecisionResult.evaluated?.length || 0,
            approvedCount: 0,
            motivoNoEnvio: 'canonical_authority_silence',
            metadata: {
              plan: plan.nombre,
              origen: origenDigest,
              ranking_funnel: canonicalDecisionResult.ranking?.funnel || null,
              portfolio: canonicalDecisionResult.portfolio?.counts || null,
            },
          });
          sinAlertas++;
          console.log(`[digest] User ${user.id} -> autoridad final decide silencio`);
          continue;
        }

        // Gate de envio automatico: review_only / blocked / exclude no se autoenvian aunque
        // hayan entrado como relleno (incoherencia review_only). Defensa en profundidad,
        // independiente del enforcement de la validacion final.
        const candidatasAutoSend = alertasFinales;
        const { enviables: alertasEnviables, retenidas: alertasRetenidasReview } =
          filtrarAlertasEnviablesAutomaticamente(alertasFinales);
        if (alertasRetenidasReview.length > 0) {
          console.log(`[digest] User ${user.id} → ${alertasRetenidasReview.length} alerta(s) review_only/no enviables retenidas (sin autoenvio)`);
        }
        alertasFinales = alertasEnviables;
        const enviablesIds = new Set(alertasEnviables.map((alerta) => String(alerta.id)));
        const retenidasPorId = new Map(
          alertasRetenidasReview.map((item) => [String(item.alerta_id), item])
        );
        await registrarDigestCandidateDecisionsCanonicas(supabase, {
          userId: user.id,
          organizationId,
          fecha: hoy,
          kind: attemptKind,
          stage: 'auto_send_gate',
          digestAttemptId,
          decisions: candidatasAutoSend.map((alerta) => ({
            id: alerta.id,
            action: enviablesIds.has(String(alerta.id))
              ? 'include'
              : (retenidasPorId.get(String(alerta.id))?.action || 'blocked'),
            motivo: enviablesIds.has(String(alerta.id))
              ? 'selection_gate_passed_pending_final_validation'
              : (retenidasPorId.get(String(alerta.id))?.motivo || 'automatic_send_retained'),
            selection_decision: alerta.decision_digest || null,
            match_trace: alerta.decision_digest?.match_trace ||
              alerta.decision_digest?.diagnostico?.match_trace ||
              null,
          })),
        });

        if (alertasFinales.length === 0) {
          await registrarDigestAttempt(supabase, {
            userId: user.id,
            fecha: hoy,
            kind: attemptKind,
            status: 'no_send',
            ...funnelActual(0),
            motivoNoEnvio: 'sin_alertas_enviables_review_only',
            metadata: {
              plan: plan.nombre,
              origen: origenDigest,
              rescate: modoRescate,
              retenidas_review_only: alertasRetenidasReview,
            },
          });
          sinAlertas++;
          console.log(`[digest] User ${user.id} → sin alertas enviables tras gate review_only → sin digest`);
          continue;
        }

        console.log(`[digest] User ${user.id} (${plan.nombre}) → ${alertasFinales.length}/${alertasUsuario.length} alertas → generando...`);

        try {
          const renderedDecisionMessage = renderDecisionDigestMessage({
            user: userConPerfilMIA,
            alertas: alertasFinales,
            fecha: hoy,
          });
          let mensajeRaw = renderedDecisionMessage.message;
          alertasFinales = renderedDecisionMessage.alertas;
          if (renderedDecisionMessage.omitted > 0) {
            errores.push({
              userId: user.id,
              warning: 'canonical_message_length_omitted',
              total: renderedDecisionMessage.omitted,
            });
          }

          if (!mensajeRaw || mensajeRaw.trim() === 'SIN_ALERTAS') {
            await registrarDigestAttempt(supabase, {
              userId: user.id,
              fecha: hoy,
              kind: attemptKind,
              status: 'no_send',
              ...funnelActual(alertasFinales.length),
              motivoNoEnvio: 'canonical_message_projection_empty',
              metadata: { plan: plan.nombre },
            });
            sinAlertas++;
            console.log(`[digest] User ${user.id} → IA descartó todas las alertas → sin digest`);
            continue;
          }

          let mensaje = mensajeRaw.trim();

          let finalValidationShadow = null;
          try {
            const shadow = await prepararValidacionFinalDigestShadow({
              supabase,
              mensaje: mensaje.trim(),
              alertas: alertasFinales,
              user: userConPerfilMIA,
              organizationId,
            });
            alertasFinales = shadow.alertas;
            finalValidationShadow = shadow.validation;
            await registrarDigestCandidateDecisionsCanonicas(supabase, {
              userId: user.id,
              organizationId,
              fecha: hoy,
              kind: attemptKind,
              stage: 'final_validation',
              digestAttemptId,
              decisions: decisionesValidacionFinal(alertasFinales, finalValidationShadow),
              metadata: {
                enforcement_enabled: DIGEST_FINAL_VALIDATION_ENFORCEMENT,
                enforcement_mode: DIGEST_FINAL_VALIDATION_MODE,
              },
            });
            for (const warning of shadow.warnings || []) {
              errores.push({
                userId: user.id,
                warning: warning.warning,
                alertaId: warning.alerta_id,
                error: warning.error,
              });
            }
            const initialFactSheetStore = await guardarFactSheetsDigestShadow({
              supabase,
              alertas: alertasFinales,
              validation: finalValidationShadow,
              organizationId,
              enforcementMode: DIGEST_FINAL_VALIDATION_MODE,
            });
            if (!initialFactSheetStore.ok) {
              errores.push({
                userId: user.id,
                warning: 'fact_sheet_shadow_inicial_no_registrado',
              });
            }
          } catch (errShadow) {
            if (errShadow?.code === 'CANONICAL_DECISION_AUDIT_FAILED'
              || errShadow?.code === 'CANONICAL_DECISION_AUDIT_STAGE_INVALID') {
              throw errShadow;
            }
            console.warn(`[digest:shadow] No se pudo validar digest final user ${user.id}:`, errShadow.message);
            errores.push({ userId: user.id, warning: 'final_validation_shadow_error', error: errShadow.message });
            finalValidationShadow = construirValidacionFinalFallida(
              alertasFinales,
              errShadow?.code === 'ETIMEDOUT' ? 'final_validation_timeout' : 'final_validation_error',
              errShadow
            );
            await registrarDigestCandidateDecisionsCanonicas(supabase, {
              userId: user.id,
              organizationId,
              fecha: hoy,
              kind: attemptKind,
              stage: 'final_validation',
              digestAttemptId,
              decisions: decisionesValidacionFinal(alertasFinales, finalValidationShadow),
              metadata: {
                enforcement_enabled: true,
                enforcement_mode: 'enforce',
                validation_error: true,
              },
            });
          }

          let finalValidationEnforcement = null;
          if (DIGEST_FINAL_VALIDATION_ENFORCEMENT) {
            if (!finalValidationShadow) {
              await registrarDigestAttempt(supabase, {
                userId: user.id,
                fecha: hoy,
                kind: attemptKind,
                status: 'no_send',
                ...funnelActual(alertasFinales.length),
                motivoNoEnvio: 'final_validation_error',
                metadata: { plan: plan.nombre, origen: origenDigest, rescate: modoRescate },
              });
              sinAlertas++;
              continue;
            }

            finalValidationEnforcement = filtrarAlertasPorValidacionFinalDigest(
              alertasFinales,
              finalValidationShadow,
              {
                mode: DIGEST_FINAL_VALIDATION_MODE,
                context: modoRescate ? 'rescue' : 'automatic_daily',
              }
            );
            await registrarDigestCandidateDecisionsCanonicas(supabase, {
              userId: user.id,
              organizationId,
              fecha: hoy,
              kind: attemptKind,
              stage: 'effective_send_gate',
              digestAttemptId,
              decisions: decisionesGateEfectivo(finalValidationEnforcement),
              metadata: {
                enforcement_enabled: true,
                enforcement_mode: 'enforce',
                gate_version: finalValidationEnforcement.summary.gate_version,
              },
            });
            const reintentarMensajeCompleto = validacionReintentablePorTextoAusente(
              finalValidationEnforcement
            );
            if (reintentarMensajeCompleto) {
              errores.push({
                userId: user.id,
                warning: 'final_validation_retry_with_local_fallback',
              });
              finalValidationEnforcement = {
                ...finalValidationEnforcement,
                aceptadas: alertasReintentablesPorTextoAusente(finalValidationEnforcement),
                retry_items_with_fallback: true,
              };
            }

            if (finalValidationEnforcement.aceptadas.length === 0) {
              await registrarDigestAttempt(supabase, {
                userId: user.id,
                fecha: hoy,
                kind: attemptKind,
                status: 'no_send',
                ...funnelActual(0),
                motivoNoEnvio: finalValidationEnforcement.motivo_no_envio || 'final_validation_no_send',
                metadata: {
                  plan: plan.nombre,
                  origen: origenDigest,
                  rescate: modoRescate,
                  final_validation: resumirValidacionFinalDigest(finalValidationShadow),
                  final_validation_enforcement: finalValidationEnforcement.summary,
                },
              });
              sinAlertas++;
              console.log(`[digest] User ${user.id} -> validacion final sin items enviables -> sin digest`);
              continue;
            }

            alertasFinales = finalValidationEnforcement.aceptadas;
            if (finalValidationEnforcement.rechazadas.length > 0) {
              const regenerated = renderDecisionDigestMessage({
                user: userConPerfilMIA,
                alertas: alertasFinales,
                fecha: hoy,
              });
              mensajeRaw = regenerated.message;
              alertasFinales = regenerated.alertas;
              mensaje = mensajeRaw.trim();

              const shadow = await prepararValidacionFinalDigestShadow({
                supabase,
                mensaje: mensaje.trim(),
                alertas: alertasFinales,
                user: userConPerfilMIA,
                organizationId,
              });
              alertasFinales = shadow.alertas;
              finalValidationShadow = shadow.validation;
              await registrarDigestCandidateDecisionsCanonicas(supabase, {
                userId: user.id,
                organizationId,
                fecha: hoy,
                kind: attemptKind,
                stage: 'final_validation',
                digestAttemptId,
                decisions: decisionesValidacionFinal(alertasFinales, finalValidationShadow),
                metadata: {
                  enforcement_enabled: DIGEST_FINAL_VALIDATION_ENFORCEMENT,
                  enforcement_mode: DIGEST_FINAL_VALIDATION_MODE,
                  regenerated: true,
                },
              });
              for (const warning of shadow.warnings || []) {
                errores.push({
                  userId: user.id,
                  warning: warning.warning,
                  alertaId: warning.alerta_id,
                  error: warning.error,
                });
              }

              finalValidationEnforcement = filtrarAlertasPorValidacionFinalDigest(
                alertasFinales,
                finalValidationShadow,
                {
                  mode: DIGEST_FINAL_VALIDATION_MODE,
                  context: modoRescate ? 'rescue' : 'automatic_daily',
                }
              );
              await registrarDigestCandidateDecisionsCanonicas(supabase, {
                userId: user.id,
                organizationId,
                fecha: hoy,
                kind: attemptKind,
                stage: 'effective_send_gate',
                digestAttemptId,
                decisions: decisionesGateEfectivo(finalValidationEnforcement),
                metadata: {
                  enforcement_enabled: true,
                  enforcement_mode: 'enforce',
                  gate_version: finalValidationEnforcement.summary.gate_version,
                  regenerated: true,
                },
              });
              if (finalValidationEnforcement.aceptadas.length === 0) {
                await registrarDigestAttempt(supabase, {
                  userId: user.id,
                  fecha: hoy,
                  kind: attemptKind,
                  status: 'no_send',
                  ...funnelActual(0),
                  motivoNoEnvio: finalValidationEnforcement.motivo_no_envio || 'final_validation_no_send',
                  metadata: {
                    plan: plan.nombre,
                    origen: origenDigest,
                    rescate: modoRescate,
                    final_validation: resumirValidacionFinalDigest(finalValidationShadow),
                    final_validation_enforcement: finalValidationEnforcement.summary,
                  },
                });
                sinAlertas++;
                console.log(`[digest] User ${user.id} -> validacion final filtro todos tras regenerar -> sin digest`);
                continue;
              }

              if (finalValidationEnforcement.rechazadas.length > 0) {
                // El mensaje regenerado aun contenia items rechazados. No se
                // pierde lo que si paso: se vuelve a renderizar solo el
                // subconjunto aceptado y se valida una ultima vez.
                alertasFinales = finalValidationEnforcement.aceptadas;
                const cleaned = renderDecisionDigestMessage({
                  user: userConPerfilMIA,
                  alertas: alertasFinales,
                  fecha: hoy,
                });
                mensajeRaw = cleaned.message;
                alertasFinales = cleaned.alertas;
                mensaje = mensajeRaw.trim();
                const cleanupShadow = await prepararValidacionFinalDigestShadow({
                  supabase,
                  mensaje: mensaje.trim(),
                  alertas: alertasFinales,
                  user: userConPerfilMIA,
                  organizationId,
                });
                alertasFinales = cleanupShadow.alertas;
                finalValidationShadow = cleanupShadow.validation;
                await registrarDigestCandidateDecisionsCanonicas(supabase, {
                  userId: user.id,
                  organizationId,
                  fecha: hoy,
                  kind: attemptKind,
                  stage: 'final_validation',
                  digestAttemptId,
                  decisions: decisionesValidacionFinal(alertasFinales, finalValidationShadow),
                  metadata: {
                    enforcement_enabled: true,
                    enforcement_mode: DIGEST_FINAL_VALIDATION_MODE,
                    regenerated: true,
                    cleanup_accepted_only: true,
                  },
                });
                finalValidationEnforcement = filtrarAlertasPorValidacionFinalDigest(
                  alertasFinales,
                  finalValidationShadow,
                  {
                    mode: DIGEST_FINAL_VALIDATION_MODE,
                    context: modoRescate ? 'rescue' : 'automatic_daily',
                  }
                );
                await registrarDigestCandidateDecisionsCanonicas(supabase, {
                  userId: user.id,
                  organizationId,
                  fecha: hoy,
                  kind: attemptKind,
                  stage: 'effective_send_gate',
                  digestAttemptId,
                  decisions: decisionesGateEfectivo(finalValidationEnforcement),
                  metadata: {
                    enforcement_enabled: true,
                    enforcement_mode: 'enforce',
                    gate_version: finalValidationEnforcement.summary.gate_version,
                    regenerated: true,
                    cleanup_accepted_only: true,
                  },
                });
                if (
                  finalValidationEnforcement.aceptadas.length === 0 ||
                  finalValidationEnforcement.rechazadas.length > 0
                ) {
                  await registrarDigestAttempt(supabase, {
                    userId: user.id,
                    fecha: hoy,
                    kind: attemptKind,
                    status: 'no_send',
                    ...funnelActual(0),
                    motivoNoEnvio: 'final_validation_unstable_after_regeneration',
                    metadata: {
                      plan: plan.nombre,
                      origen: origenDigest,
                      rescate: modoRescate,
                      final_validation: resumirValidacionFinalDigest(finalValidationShadow),
                      final_validation_enforcement: finalValidationEnforcement.summary,
                    },
                  });
                  sinAlertas++;
                  console.log(`[digest] User ${user.id} -> validacion final inestable tras limpieza -> sin digest`);
                  continue;
                }
              }

              alertasFinales = finalValidationEnforcement.aceptadas;
            }
          }

          const alertaIdsDigest = alertasFinales.map((a) => a.id);
          const messageVersion = crearMessageVersion(mensaje.trim(), 'decision_message_v1');
          const digestIdempotencyKey = crearIdempotencyKey({
            source: 'digest_daily',
            sourceId: `${user.id}:${hoy}`,
            messageVersion,
          });
          let digestInsertado = null;
          let writeError = null;
          const regenerandoDigestExistente = Boolean(digestExistente && force && !digestExistente.enviado);

          if (regenerandoDigestExistente) {
            const updateResult = await supabase
              .from('digests')
              .update(conOrganizationId({
                mensaje: mensaje.trim(),
                alerta_ids: alertaIdsDigest,
                enviado: false,
                delivery_status: DELIVERY_STATUS.APPROVED,
                message_version: messageVersion,
                idempotency_key: digestIdempotencyKey,
                provider_message_id: null,
                accepted_at: null,
                sent_to_whatsapp_at: null,
                delivered_at: null,
                read_at: null,
                failed_at: null,
              }, organizationId))
              .eq('id', digestExistente.id)
              .eq('enviado', false)
              .or('delivery_status.is.null,delivery_status.in.(DRAFT,APPROVED,FAILED)')
              .select('id')
              .single();
            digestInsertado = updateResult.data;
            writeError = updateResult.error;
          } else {
            const insertResult = await supabase
              .from('digests')
              .insert(conOrganizationId({
                user_id:    user.id,
                fecha:      hoy,
                mensaje:    mensaje.trim(),
                alerta_ids: alertaIdsDigest,
                enviado:    false,
                delivery_status: DELIVERY_STATUS.APPROVED,
                message_version: messageVersion,
                idempotency_key: digestIdempotencyKey,
              }, organizationId))
              .select('id')
              .single();
            digestInsertado = insertResult.data;
            writeError = insertResult.error;
          }

          if (writeError) {
            if (writeError.code === '23505') {
              // Carrera entre crons — no es error crítico
              console.warn(`[digest] UNIQUE violation user ${user.id} — ya existe, saltando`);
              await registrarDigestAttempt(supabase, {
                userId: user.id,
                fecha: hoy,
                kind: attemptKind,
                status: 'skipped_existing',
                ...funnelActual(alertasFinales.length),
                metadata: { plan: plan.nombre, rescate: modoRescate },
              });
              saltados++;
            } else {
              console.error(`[digest] Error guardando digest user ${user.id}:`, writeError.message);
              await registrarDigestAttempt(supabase, {
                userId: user.id,
                fecha: hoy,
                kind: attemptKind,
                status: 'failed',
                ...funnelActual(alertasFinales.length),
                motivoNoEnvio: 'error_guardando_digest',
                errorMsg: writeError.message,
                metadata: { plan: plan.nombre, rescate: modoRescate },
              });
              errores.push({ userId: user.id, error: writeError.message });
            }
          } else {
            if (regenerandoDigestExistente) {
              for (const tabla of ['digest_items', 'alerta_click_links']) {
                const { error: cleanupError } = await supabase
                  .from(tabla)
                  .delete()
                  .eq('digest_id', digestInsertado.id);
                if (cleanupError) {
                  console.warn(`[digest] No se pudo limpiar ${tabla} del digest ${digestInsertado.id}:`, cleanupError.message);
                }
              }
            }

            const finalizedAttempt = await registrarDigestAttempt(supabase, {
              userId: user.id,
              organizationId,
              fecha: hoy,
              kind: attemptKind,
              status: modoRescate ? 'rescued' : 'generated',
              deliveryStatus: DELIVERY_STATUS.APPROVED,
              judgeEvaluatedCount: canonicalDecisionResult?.evaluated?.length || 0,
              approvedCount: alertasFinales.length,
              digestId: digestInsertado.id,
              ...construirFunnelDigest({
                totalAlertasDia,
                totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
                trasQualityGate: modoRescate?.alertasVentanaTrasCalidad ?? alertas.length,
                trasFiltroUsuario: modoRescate?.trasFiltroUsuario ?? alertasUsuario.length,
                trasScoring: modoRescate?.trasScoring ?? contarDecisionesTrasScoring(seleccionFinal),
                alertasFinales: alertasFinales.length,
              }),
              motivoNoEnvio: modoRescate ? 'sin_alertas_hoy_rescate_semanal_generado' : null,
              metadata: {
                plan: plan.nombre,
                origen: origenDigest,
                rescate: modoRescate,
                final_validation: resumirValidacionFinalDigest(finalValidationShadow),
                final_validation_enforcement: finalValidationEnforcement?.summary || null,
              },
            });
            digestAttemptId = finalizedAttempt.id || digestAttemptId;
            const candidateLink = await vincularDigestCandidateDecisions(supabase, {
              userId: user.id,
              fecha: hoy,
              kind: attemptKind,
              digestId: digestInsertado.id,
              digestAttemptId,
            });
            if (!candidateLink.ok) {
              errores.push({
                userId: user.id,
                digestId: digestInsertado.id,
                warning: 'candidate_decisions_no_vinculadas',
                error: candidateLink.error,
              });
            }

            const digestItems = await registrarDigestItemsMIA(supabase, {
              digestId: digestInsertado.id,
              userId: user.id,
              fecha: hoy,
              alertas: alertasFinales,
              origen: origenDigest,
              organizationId,
            });

            const factSheetStore = await guardarFactSheetsDigestShadow({
              supabase,
              alertas: alertasFinales,
              validation: finalValidationShadow,
              organizationId,
              digestId: digestInsertado.id,
              enforcementMode: DIGEST_FINAL_VALIDATION_MODE,
            });

            if (!factSheetStore.ok) {
              errores.push({
                userId: user.id,
                digestId: digestInsertado.id,
                warning: 'fact_sheet_shadow_no_registrado',
              });
            }

            if (!digestItems.ok) {
              errores.push({
                userId: user.id,
                digestId: digestInsertado.id,
                warning: 'digest_items_no_registrados',
                error: digestItems.error,
              });
            }

            const tracking = await prepararMensajeConLinksTracking(supabase, {
              mensaje: mensaje.trim(),
              userId: user.id,
              digestId: digestInsertado.id,
              alertas: alertasFinales,
              organizationId,
            });

            if (tracking.enabled && tracking.mensaje !== mensaje.trim()) {
              mensaje = tracking.mensaje;
              const trackedMessageVersion = crearMessageVersion(
                mensaje.trim(),
                'decision_message_v1'
              );
              const { error: updateMensajeError } = await supabase
                .from('digests')
                .update({
                  mensaje: mensaje.trim(),
                  message_version: trackedMessageVersion,
                  idempotency_key: crearIdempotencyKey({
                    source: 'digest_daily',
                    sourceId: `${user.id}:${hoy}`,
                    messageVersion: trackedMessageVersion,
                  }),
                })
                .eq('id', digestInsertado.id);

              if (updateMensajeError) {
                console.warn(`[digest] No se pudo actualizar digest con links tracking ${digestInsertado.id}:`, updateMensajeError.message);
                errores.push({
                  userId: user.id,
                  digestId: digestInsertado.id,
                  warning: 'tracking_links_no_actualizados',
                  error: updateMensajeError.message,
                });
              }
            }

            if (alertaIdsDigest.length > 0) {
              try {
                await abrirConversacionFeedbackDigest(supabase, {
                  userId: user.id,
                  digestId: digestInsertado.id,
                  alertaIds: alertaIdsDigest,
                  fecha: hoy,
                  organizationId,
                });
              } catch (errConversacion) {
                console.warn(`[digest] No se pudo abrir conversacion feedback user ${user.id}:`, errConversacion.message);
                errores.push({
                  userId: user.id,
                  digestId: digestInsertado.id,
                  warning: 'conversacion_feedback_no_creada',
                  error: errConversacion.message,
                });
              }
            }

            if (!modoRescate && seleccionMIA?.exploracion) {
              try {
                await registrarExploracionDigest(supabase, {
                  userId: user.id,
                  digestId: digestInsertado.id,
                  alerta: seleccionMIA.exploracion,
                  origen: seleccionMIA.origen,
                  organizationId,
                });
              } catch (errExploracion) {
                console.warn(`[digest] No se pudo registrar exploracion user ${user.id}:`, errExploracion.message);
                errores.push({
                  userId: user.id,
                  digestId: digestInsertado.id,
                  warning: 'exploracion_no_registrada',
                  error: errExploracion.message,
                });
              }
            }

            if (modoRescate) rescatados++;
            generados++;
            console.log(`[digest] ✓ Generado para user ${user.id}`);
          }

        } catch (errIA) {
          console.error(`[digest] Error IA user ${user.id}:`, errIA.message);
          await registrarDigestAttempt(supabase, {
            userId: user.id,
            fecha: hoy,
            kind: attemptKind,
            status: 'failed',
            ...funnelActual(alertasFinales.length),
            motivoNoEnvio: 'error_generando_digest',
            errorMsg: errIA.message,
            metadata: {
              plan: plan.nombre,
              rescate: modoRescate,
            },
          });
          errores.push({ userId: user.id, error: errIA.message });
        }
      }

      return res.json({
        success: true,
        fecha: hoy,
        alertas_dia_total: totalAlertasDia,
        alertas_disponibles:  alertas.length,
        alertas_descartadas_calidad: alertasDescartadasCalidad.length,
        usuarios_procesados:  usuarios.length,
        usuarios_evaluados_batch: usuariosEvaluados,
        usuarios_pendientes: Math.max(0, usuariosPendientes.length - usuariosEvaluados),
        limite_digests:       limiteDigests,
        procesadas:           usuariosEvaluados,
        actualizadas:         usuariosEvaluados,
        digests_generados:    generados,
        rescates_generados:   rescatados,
        usuarios_sin_alertas: sinAlertas,
        usuarios_sin_telefono: sinTelefono,
        saltados,
        fallback_local:       0,
        rescate: {
          enabled: DIGEST_RESCUE_ENABLED,
          after_days: DIGEST_RESCUE_AFTER_DAYS,
          lookback_days: DIGEST_RESCUE_LOOKBACK_DAYS,
        },
        errores,
      });

    } catch (err) {
      console.error('Error en /alertas/preparar-digest', err);
      return res.status(500).json({ error: err.message });
    }
  };

  // ──────────────────────────────────────────────────────────────────
  // /alertas/enviar-digest
  // Lo invoca scripts/run_digest_workflow.js. No programar este endpoint como
  // un segundo cron independiente. Este endpoint solo encola; el mismo
  // workflow vacía mia_outbox a continuación.
  // ──────────────────────────────────────────────────────────────────
  const enviarDigestHandler = async (req, res) => {
    try {
      const hoy = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const encolado = await encolarDigestsPendientes(supabase, { fecha: hoy });
      return res.json({
        success: encolado.errores.length === 0,
        via: 'outbox',
        fecha: hoy,
        total: encolado.total,
        encolados: encolado.encolados,
        enviados: 0,
        ya_encolados: encolado.ya_encolados,
        sin_telefono: encolado.sin_telefono,
        bloqueados_validacion_final: encolado.bloqueados_validacion_final,
        errores: encolado.errores,
      });

    } catch (err) {
      console.error('Error en /alertas/enviar-digest', err);
      return res.status(500).json({ error: err.message });
    }
  };

  // Los procesos que escriben o envían usan POST; los diagnósticos usan GET.
  app.post('/alertas/preparar-digest', (req, res) => {
    if (!checkCronToken(req, res)) return;
    prepararDigestHandler(req, res);
  });

  app.get('/alertas/diagnosticar-digest', (req, res) => {
    if (!checkCronToken(req, res)) return;
    diagnosticarDigestHandler(req, res);
  });

  app.get('/alertas/preview-digest', (req, res) => {
    if (!checkCronToken(req, res)) return;
    previewDigestHandler(req, res);
  });
  // POST permite enviar phone/user_id en el cuerpo y evita exponerlos en la URL.
  app.post('/alertas/preview-digest', (req, res) => {
    if (!checkCronToken(req, res)) return;
    previewDigestHandler(req, res);
  });

  app.post('/alertas/enviar-digest', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarDigestHandler(req, res);
  });

};
