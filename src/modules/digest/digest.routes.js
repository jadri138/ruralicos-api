// src/modules/digest/digest.routes.js
//
// Capa HTTP del digest: registra los 7 endpoints (/alertas/preparar-digest,
// enviar-digest, preview-digest, diagnosticar-digest) sobre Express. La logica
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


const crypto = require('crypto');
const { checkCronToken }           = require('../../middleware/cronToken');
const { llamarIA }                 = require('../../platform/ia/llamarIA');
const { enviarDigestPro, maskPhone } = require('../../platform/whatsapp');
const { getPlan }                  = require('../../config/planes');
const { alertaCoincideConUsuario, diagnosticarAlertaUsuario } = require('../alertas/seleccion/alertaMatcher');
const { fusionarAlertasUnicas }     = require('../alertas/seleccion/alertCandidateMerge');
const {
  decidirAlertaParaDigest,
  filtrarAlertasParaDigest,
  seleccionarAlertasParaDigest,
} = require('../alertas/seleccion/alertSelectionGate');
const { getFechaMadridISO, getRangoDiaMadridUTC } = require('../../shared/fechaMadrid');
const { leerPerfilIntereses, ordenarAlertasPorPerfil, clasificarPrioridadAlerta, pesoPrioridad } = require('../aprendizaje');
const { similitudCoseno }          = require('../../platform/ia/embeddings');
const { registrarDigestItemsMIA }  = require('../mia/digestItems');
const {
  actualizarDigestAttemptPorDigest,
  registrarDigestAttempt,
} = require('../mia/digestAttempts');
const {
  cargarPerfilOperativoMIA,
  aplicarPerfilOperativoAUsuario,
  ordenarAlertasConPerfilOperativoMIA,
} = require('../mia/userProfile');
const { evaluarCalidadAlerta }     = require('../mia/alertQuality');
const {
  conOrganizationId,
  extraerOrganizationId,
  filtrarAlertasPorOrganization,
  cargarOrganizationContextMIA,
  aplicarOrganizationContextAUsuario,
  obtenerMiaBranding,
} = require('../mia/organizationContext');

const {
  numeroConfig,
  PREPARAR_DIGEST_BATCH_SIZE,
  DIGEST_LOCAL_FALLBACK,
  DIGEST_QUALITY_GATE,
  DIGEST_INCLUDE_REVIEW,
  DIGEST_INCLUDE_INDIVIDUAL_PROVINCIAL,
  DIGEST_REVIEW_MIN_QUALITY_SCORE,
  DIGEST_MAX_ALERTAS_NORMAL,
  DIGEST_MAX_ALERTAS_COOPERATIVA,
  DIGEST_MAX_ALERTAS_USUARIO,
  DIGEST_RESCUE_ENABLED,
  DIGEST_RESCUE_AFTER_DAYS,
  DIGEST_RESCUE_LOOKBACK_DAYS,
  DIGEST_RESCUE_MAX_ALERTAS,
  DIGEST_RESCUE_MESSAGE_MAX_CHARS,
  DIGEST_VECTOR_BACKFILL_MIN,
  DIGEST_FINAL_VALIDATION_ENFORCEMENT,
  norm,
  intersecta,
  ALERTA_DIGEST_SELECT,
  ALERTA_DIGEST_SELECT_WITH_EMBEDDING,
  getMaxAlertasDigestUsuario,
  sumarDiasFechaISO,
  diasEntreFechas,
  motivoUsuarioNoRecibeDigest,
  alertaNoExcluidaPorPreferencias,
  aplicarFiltroFechaAlertas,
  cargarAlertasListasDigest,
  cargarUsuariosPagoDigest,
  cargarUltimosDigestEnviados,
  necesitaRescateSemanal,
  extraerExclusionesDesdeTexto,
  aplicarExclusionesPreferenciasExtra,
  alertaExcluidaPorPreferenciasExtra,
  extraerTextoObligatorioDesdePreferencias,
  aplicarTextoObligatorio,
  anadirInstruccionFeedback,
  limpiarLineaDigest,
  lineaBoletinPocoUtilDigest,
  extraerExtractoOficialDigest,
  parsearFichaDigest,
  campoDigestUtil,
  construirLecturaBoletinDigest,
  quitarPrefijoBoletinDigest,
  construirResumenOficialDigest,
  construirTextoAlertaDigest,
  construirTituloFacilDigest,
  construirResumenPorPatronDigest,
  construirResumenFacilDigest,
  grupoDigestAlerta,
  relevanciaDigestAlerta,
  valoresPrefsTiposActivos,
  interseccionTexto,
  coincidenciasUsuarioDigest,
  explicarCoincidenciasDigest,
  construirContextoInternoDigest,
  prepararAlertasFinalesDigest,
  resumirValidacionFinalDigest,
  prepararValidacionFinalDigestShadow,
  guardarFactSheetsDigestShadow,
  filtrarAlertasPorValidacionFinalDigest,
  filtrarAlertasEnviablesAutomaticamente,
  agruparAlertasDigest,
  obtenerNombreCortoDigest,
  construirSaludoDigest,
  limpiarMensajeDigestIA,
  mensajeDigestPareceGenerico,
  filtrarAlertasPorCalidadDigest,
  generarMensajeDigestFallback,
  construirAccionRescate,
  recortarTextoRescate,
  construirResumenRescate,
  construirMotivoRescate,
  construirBloqueRescate,
  generarMensajeDigestRescate,
  getClickBaseUrl,
  generarTokenClick,
  escaparRegExp,
  reemplazarUrlEnMensaje,
  construirUrlTracking,
  prepararMensajeConLinksTracking,
  alertasParaUsuario,
  obtenerAprendizajeUsuario,
  ordenarPorAprendizaje,
  seleccionarAlertasRescate,
  parseVector,
  vectorToSql,
  ordenarPorPerfilVectorial,
  obtenerIdAlerta,
  completarSeleccionConFallback,
  completarCandidatoMIA,
  seleccionarAlertasConMIA,
  abrirConversacionFeedbackDigest,
  registrarExploracionDigest,
  generarMensajeDigest,
  construirPreviewDigestUsuario,
} = require('./digest.service');

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
        .select('id, titulo, url, fecha, region, fuente, resumen, resumen_final, contenido, provincias, sectores, subsectores, tipos_alerta, estado_ia, duplicado_de, organization_id, embedding_generated_at, created_at')
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

      if (!force) {
        const { count: pendientesIA, error: errPendientes } = await supabase
          .from('alertas')
          .select('id', { count: 'exact', head: true })
          .eq('fecha', hoy)
          .in('estado_ia', ['pendiente_clasificar', 'pendiente_resumir', 'pendiente_revisar']);

        if (errPendientes) return res.status(500).json({ error: errPendientes.message });

        if ((pendientesIA || 0) > 0) {
          return res.status(409).json({
            success: false,
            fecha: hoy,
            pendientes_ia: pendientesIA,
            mensaje: 'Quedan alertas pendientes de IA. No se prepara el digest para evitar un envio incompleto. Revisa /alertas/estado-pipeline o usa force=true si quieres saltarte esta proteccion.',
          });
        }
      }

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
      const { data: digestsExistentes } = await supabase
        .from('digests')
        .select('id, user_id, enviado')
        .eq('fecha', hoy);

      const digestsPorUsuario = new Map((digestsExistentes || []).map((d) => [d.user_id, d]));
      const userIds = usuarios.map((user) => user.id).filter(Boolean);
      const fechaCorteRescate = sumarDiasFechaISO(hoy, -DIGEST_RESCUE_AFTER_DAYS);
      const desdeRescate = sumarDiasFechaISO(hoy, -(DIGEST_RESCUE_LOOKBACK_DAYS - 1));
      const ultimosEnviadosPorUsuario = await cargarUltimosDigestEnviados(
        supabase,
        userIds,
        fechaCorteRescate
      );
      let alertasRescateCache = null;

      let generados  = 0;
      let sinAlertas = 0;
      let saltados   = 0;
      let rescatados = 0;
      let sinTelefono = 0;
      let fallbackLocal = 0;
      const errores  = [];

      // 4) Procesar usuario a usuario
      for (const user of usuarios) {
        if (generados >= limiteDigests) break;

        // Ya tiene digest hoy → saltar
        // Con force=true se rehace solo si aun no fue enviado.
        const digestExistente = digestsPorUsuario.get(user.id);
        const plan = getPlan(user.subscription);

        if (digestExistente && (!force || digestExistente.enviado)) {
          await registrarDigestAttempt(supabase, {
            userId: user.id,
            fecha: hoy,
            kind: 'daily',
            status: 'skipped_existing',
            digestId: digestExistente.id,
            totalAlertasDia,
            trasQualityGate: alertas.length,
            metadata: {
              plan: plan.nombre,
              enviado: Boolean(digestExistente.enviado),
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
        const aprendizaje = await obtenerAprendizajeUsuario(supabase, user.id);
        const perfilOperativoMIA = await cargarPerfilOperativoMIA(supabase, user.id, { user: userConOrganization });
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
        const seleccionFinal = seleccionarAlertasParaDigest(alertasOrdenadas, userConPerfilMIA, {
          qualityGate: DIGEST_QUALITY_GATE,
          allowReview: DIGEST_INCLUDE_REVIEW,
          minReviewQualityScore: DIGEST_REVIEW_MIN_QUALITY_SCORE,
          allowIndividualWithoutMunicipio: DIGEST_INCLUDE_INDIVIDUAL_PROVINCIAL,
          minItems: Math.min(DIGEST_VECTOR_BACKFILL_MIN, maxAlertasUsuario),
          targetItems: maxAlertasUsuario,
          maxItems: maxAlertasUsuario,
          origen: usandoMIA ? seleccionMIA.origen : 'perfil_tags_prioridad',
          exclusionPreferencias: (item) => alertaExcluidaPorPreferenciasExtra(item, user.preferencias_extra),
        });
        let alertasFinales = seleccionFinal.alertas;
        let modoRescate = null;

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
                  total: 0,
                  descartadasCalidad: 0,
                  error: errRescate.message,
                };
              } else if (DIGEST_QUALITY_GATE) {
                const calidadRescate = filtrarAlertasPorCalidadDigest(alertasVentana || [], { minScore: 65 });
                alertasRescateCache = {
                  alertas: calidadRescate.aceptadas,
                  total: (alertasVentana || []).length,
                  descartadasCalidad: calidadRescate.rechazadas.length,
                };
              } else {
                alertasRescateCache = {
                  alertas: alertasVentana || [],
                  total: (alertasVentana || []).length,
                  descartadasCalidad: 0,
                };
              }
            }

            const rescate = seleccionarAlertasRescate({
              alertas: alertasRescateCache.alertas,
              user: userConPerfilMIA,
              aprendizaje,
              perfilOperativoMIA,
              organizationId,
              maxItems: Math.min(DIGEST_RESCUE_MAX_ALERTAS, getMaxAlertasDigestUsuario(userConPerfilMIA)),
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
            console.log(`[digest:rescue] User ${user.id} (${plan.nombre}) → rescate ${rescate.tipo} con ${alertasFinales.length} alertas`);
          } else {
            const motivoNoEnvio = totalAlertasDia === 0
              ? 'no_habia_alertas'
              : alertas.length === 0
                ? 'calidad_baja'
                : alertasUsuario.length === 0
                  ? 'perfil_sin_coincidencias'
                  : alertasOrdenadas.length === 0
                    ? 'scoring_sin_candidatas'
                    : 'sin_alertas_para_usuario';

            await registrarDigestAttempt(supabase, {
              userId: user.id,
              fecha: hoy,
              kind: 'daily',
              status: 'no_send',
              totalAlertasDia,
              trasQualityGate: alertas.length,
              trasFiltroUsuario: alertasUsuario.length,
              trasScoring: alertasOrdenadas.length,
              alertasFinales: 0,
              motivoNoEnvio,
              metadata: {
                plan: plan.nombre,
                rescate_enabled: DIGEST_RESCUE_ENABLED,
                rescate_elegible: false,
              },
            });

            sinAlertas++;
            console.log(`[digest] User ${user.id} (${plan.nombre}) → 0 alertas relevantes → sin digest`);
            continue;
          }
        }

        const origenDigest = modoRescate
          ? `rescate_semanal_${modoRescate.tipo}`
          : (usandoMIA ? seleccionMIA.origen : 'perfil_tags_prioridad');
        alertasFinales = prepararAlertasFinalesDigest(alertasFinales, userConPerfilMIA, {
          origenDigest,
          modoRescate,
          fecha: hoy,
        });

        // Gate de envio automatico: review_only / blocked / exclude no se autoenvian aunque
        // hayan entrado como relleno (incoherencia review_only). Defensa en profundidad,
        // independiente del enforcement de la validacion final.
        const { enviables: alertasEnviables, retenidas: alertasRetenidasReview } =
          filtrarAlertasEnviablesAutomaticamente(alertasFinales);
        if (alertasRetenidasReview.length > 0) {
          console.log(`[digest] User ${user.id} → ${alertasRetenidasReview.length} alerta(s) review_only/no enviables retenidas (sin autoenvio)`);
        }
        alertasFinales = alertasEnviables;

        if (alertasFinales.length === 0) {
          await registrarDigestAttempt(supabase, {
            userId: user.id,
            fecha: hoy,
            kind: modoRescate ? 'rescue' : 'daily',
            status: 'no_send',
            totalAlertasDia,
            totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
            trasQualityGate: modoRescate?.alertasVentanaTrasCalidad || alertas.length,
            trasFiltroUsuario: modoRescate?.trasFiltroUsuario || alertasUsuario.length,
            trasScoring: modoRescate?.trasScoring || alertasOrdenadas.length,
            alertasFinales: 0,
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
          let mensajeRaw;
          try {
            if (modoRescate) {
              mensajeRaw = generarMensajeDigestRescate({
                user: userConPerfilMIA,
                alertas: alertasFinales,
                fecha: hoy,
                desde: modoRescate.desde,
                tipo: modoRescate.tipo,
                organizationContext,
              });
            } else {
              mensajeRaw = await generarMensajeDigest({
                user: userConPerfilMIA,
                alertas: alertasFinales,
                fecha:   hoy,
                plan,
                aprendizaje,
                organizationContext,
              });
            }
          } catch (errGenerar) {
            if (!DIGEST_LOCAL_FALLBACK) throw errGenerar;
            console.warn(`[digest] Fallback local user ${user.id}:`, errGenerar.message);
            mensajeRaw = generarMensajeDigestFallback({
              user: userConPerfilMIA,
              alertas: alertasFinales,
              fecha: hoy,
              organizationContext,
            });
            fallbackLocal++;
            errores.push({ userId: user.id, warning: 'digest_local_fallback', error: errGenerar.message });
          }

          if (!mensajeRaw || mensajeRaw.trim() === 'SIN_ALERTAS') {
            await registrarDigestAttempt(supabase, {
              userId: user.id,
              fecha: hoy,
              kind: 'daily',
              status: 'no_send',
              totalAlertasDia,
              trasQualityGate: alertas.length,
              trasFiltroUsuario: alertasUsuario.length,
              trasScoring: alertasOrdenadas.length,
              alertasFinales: alertasFinales.length,
              motivoNoEnvio: 'ia_sin_alertas',
              metadata: { plan: plan.nombre },
            });
            sinAlertas++;
            console.log(`[digest] User ${user.id} → IA descartó todas las alertas → sin digest`);
            continue;
          }

          let mensaje = anadirInstruccionFeedback(
            aplicarTextoObligatorio(mensajeRaw, user.preferencias_extra),
            alertasFinales
          );

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
            });
            if (!initialFactSheetStore.ok) {
              errores.push({
                userId: user.id,
                warning: 'fact_sheet_shadow_inicial_no_registrado',
              });
            }
          } catch (errShadow) {
            console.warn(`[digest:shadow] No se pudo validar digest final user ${user.id}:`, errShadow.message);
            errores.push({ userId: user.id, warning: 'final_validation_shadow_error', error: errShadow.message });
          }

          let finalValidationEnforcement = null;
          if (DIGEST_FINAL_VALIDATION_ENFORCEMENT) {
            if (!finalValidationShadow) {
              await registrarDigestAttempt(supabase, {
                userId: user.id,
                fecha: hoy,
                kind: modoRescate ? 'rescue' : 'daily',
                status: 'no_send',
                totalAlertasDia,
                totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
                trasQualityGate: modoRescate?.alertasVentanaTrasCalidad || alertas.length,
                trasFiltroUsuario: modoRescate?.trasFiltroUsuario || alertasUsuario.length,
                trasScoring: modoRescate?.trasScoring || alertasOrdenadas.length,
                alertasFinales: alertasFinales.length,
                motivoNoEnvio: 'final_validation_error',
                metadata: { plan: plan.nombre, origen: origenDigest, rescate: modoRescate },
              });
              sinAlertas++;
              continue;
            }

            finalValidationEnforcement = filtrarAlertasPorValidacionFinalDigest(alertasFinales, finalValidationShadow);
            if (finalValidationEnforcement.aceptadas.length === 0) {
              await registrarDigestAttempt(supabase, {
                userId: user.id,
                fecha: hoy,
                kind: modoRescate ? 'rescue' : 'daily',
                status: 'no_send',
                totalAlertasDia,
                totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
                trasQualityGate: modoRescate?.alertasVentanaTrasCalidad || alertas.length,
                trasFiltroUsuario: modoRescate?.trasFiltroUsuario || alertasUsuario.length,
                trasScoring: modoRescate?.trasScoring || alertasOrdenadas.length,
                alertasFinales: 0,
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

            if (finalValidationEnforcement.rechazadas.length > 0) {
              alertasFinales = finalValidationEnforcement.aceptadas;
              mensajeRaw = modoRescate
                ? generarMensajeDigestRescate({
                  user: userConPerfilMIA,
                  alertas: alertasFinales,
                  fecha: hoy,
                  desde: modoRescate.desde,
                  tipo: modoRescate.tipo,
                  organizationContext,
                })
                : generarMensajeDigestFallback({
                  user: userConPerfilMIA,
                  alertas: alertasFinales,
                  fecha: hoy,
                  organizationContext,
                });
              mensaje = anadirInstruccionFeedback(
                aplicarTextoObligatorio(mensajeRaw, user.preferencias_extra),
                alertasFinales
              );

              const shadow = await prepararValidacionFinalDigestShadow({
                supabase,
                mensaje: mensaje.trim(),
                alertas: alertasFinales,
                user: userConPerfilMIA,
                organizationId,
              });
              alertasFinales = shadow.alertas;
              finalValidationShadow = shadow.validation;
              for (const warning of shadow.warnings || []) {
                errores.push({
                  userId: user.id,
                  warning: warning.warning,
                  alertaId: warning.alerta_id,
                  error: warning.error,
                });
              }

              finalValidationEnforcement = filtrarAlertasPorValidacionFinalDigest(alertasFinales, finalValidationShadow);
              if (finalValidationEnforcement.aceptadas.length === 0) {
                await registrarDigestAttempt(supabase, {
                  userId: user.id,
                  fecha: hoy,
                  kind: modoRescate ? 'rescue' : 'daily',
                  status: 'no_send',
                  totalAlertasDia,
                  totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
                  trasQualityGate: modoRescate?.alertasVentanaTrasCalidad || alertas.length,
                  trasFiltroUsuario: modoRescate?.trasFiltroUsuario || alertasUsuario.length,
                  trasScoring: modoRescate?.trasScoring || alertasOrdenadas.length,
                  alertasFinales: 0,
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
                await registrarDigestAttempt(supabase, {
                  userId: user.id,
                  fecha: hoy,
                  kind: modoRescate ? 'rescue' : 'daily',
                  status: 'no_send',
                  totalAlertasDia,
                  totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
                  trasQualityGate: modoRescate?.alertasVentanaTrasCalidad || alertas.length,
                  trasFiltroUsuario: modoRescate?.trasFiltroUsuario || alertasUsuario.length,
                  trasScoring: modoRescate?.trasScoring || alertasOrdenadas.length,
                  alertasFinales: 0,
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
                console.log(`[digest] User ${user.id} -> validacion final inestable tras regenerar -> sin digest`);
                continue;
              }

              alertasFinales = finalValidationEnforcement.aceptadas;
            }
          }

          const alertaIdsDigest = alertasFinales.map((a) => a.id);
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
              }, organizationId))
              .eq('id', digestExistente.id)
              .eq('enviado', false)
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
                kind: modoRescate ? 'rescue' : 'daily',
                status: 'skipped_existing',
                totalAlertasDia,
                totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
                trasQualityGate: modoRescate?.alertasVentanaTrasCalidad || alertas.length,
                trasFiltroUsuario: modoRescate?.trasFiltroUsuario || alertasUsuario.length,
                trasScoring: modoRescate?.trasScoring || alertasOrdenadas.length,
                alertasFinales: alertasFinales.length,
                metadata: { plan: plan.nombre, rescate: modoRescate },
              });
              saltados++;
            } else {
              console.error(`[digest] Error guardando digest user ${user.id}:`, writeError.message);
              await registrarDigestAttempt(supabase, {
                userId: user.id,
                fecha: hoy,
                kind: modoRescate ? 'rescue' : 'daily',
                status: 'failed',
                totalAlertasDia,
                totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
                trasQualityGate: modoRescate?.alertasVentanaTrasCalidad || alertas.length,
                trasFiltroUsuario: modoRescate?.trasFiltroUsuario || alertasUsuario.length,
                trasScoring: modoRescate?.trasScoring || alertasOrdenadas.length,
                alertasFinales: alertasFinales.length,
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

            await registrarDigestAttempt(supabase, {
              userId: user.id,
              fecha: hoy,
              kind: 'daily',
              status: modoRescate ? 'rescued' : 'generated',
              digestId: digestInsertado.id,
              totalAlertasDia,
              totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
              trasQualityGate: alertas.length,
              trasFiltroUsuario: alertasUsuario.length,
              trasScoring: alertasOrdenadas.length,
              alertasFinales: alertasFinales.length,
              motivoNoEnvio: modoRescate ? 'sin_alertas_hoy_rescate_semanal_generado' : null,
              metadata: {
                plan: plan.nombre,
                origen: origenDigest,
                rescate: modoRescate,
                final_validation: resumirValidacionFinalDigest(finalValidationShadow),
                final_validation_enforcement: finalValidationEnforcement?.summary || null,
              },
            });

            if (modoRescate) {
              await registrarDigestAttempt(supabase, {
                userId: user.id,
                fecha: hoy,
                kind: 'rescue',
                status: 'generated',
                digestId: digestInsertado.id,
                totalAlertasDia,
                totalAlertasVentana: modoRescate.totalAlertasVentana,
                trasQualityGate: modoRescate.alertasVentanaTrasCalidad,
                trasFiltroUsuario: modoRescate.trasFiltroUsuario,
                trasScoring: modoRescate.trasScoring,
                alertasFinales: alertasFinales.length,
                metadata: {
                  plan: plan.nombre,
                  tipo: modoRescate.tipo,
                  desde: modoRescate.desde,
                  descartadas_calidad: modoRescate.descartadasCalidad,
                },
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
              const { error: updateMensajeError } = await supabase
                .from('digests')
                .update({ mensaje: mensaje.trim() })
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
            kind: modoRescate ? 'rescue' : 'daily',
            status: 'failed',
            totalAlertasDia,
            totalAlertasVentana: modoRescate?.totalAlertasVentana || 0,
            trasQualityGate: modoRescate?.alertasVentanaTrasCalidad || alertas.length,
            trasFiltroUsuario: modoRescate?.trasFiltroUsuario || alertasUsuario.length,
            trasScoring: modoRescate?.trasScoring || alertasOrdenadas.length,
            alertasFinales: alertasFinales.length,
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
        limite_digests:       limiteDigests,
        procesadas:           generados,
        actualizadas:         generados,
        digests_generados:    generados,
        rescates_generados:   rescatados,
        usuarios_sin_alertas: sinAlertas,
        usuarios_sin_telefono: sinTelefono,
        saltados,
        fallback_local:       fallbackLocal,
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
  // Cron recomendado: 08:00h
  // Variable de entorno: DIGEST_DELAY_MS (default: 3000ms)
  // ──────────────────────────────────────────────────────────────────
  const enviarDigestHandler = async (req, res) => {
    try {
      const hoy = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();
      const DELAY_MS = parseInt(process.env.DIGEST_DELAY_MS || '3000', 10);

      // 1) Digests pendientes de hoy
      const { data: digests, error } = await supabase
        .from('digests')
        .select('id, user_id, fecha, mensaje')
        .eq('fecha', hoy)
        .eq('enviado', false)
        .order('created_at', { ascending: true });

      if (error) return res.status(500).json({ error: error.message });

      if (!digests || digests.length === 0) {
        return res.json({
          success: true,
          enviados: 0,
          mensaje:  'No hay digests pendientes hoy',
          fecha:    hoy,
        });
      }

      // 2) Teléfonos en una sola query
      const userIds = digests.map((d) => d.user_id);

      const { data: usuarios, error: errUsers } = await supabase
        .from('users')
        .select('id, phone')
        .in('id', userIds)
        .or('phone_verified.is.null,phone_verified.eq.true');

      if (errUsers) return res.status(500).json({ error: errUsers.message });

      const telefonoPorUserId = Object.fromEntries(
        (usuarios || []).map((u) => [u.id, (u.phone || '').trim()])
      );

      let enviados  = 0;
      const errores = [];

      // 3) Enviar uno a uno con delay anti-ban
      for (let i = 0; i < digests.length; i++) {
        const digest   = digests[i];
        const telefono = telefonoPorUserId[digest.user_id];

        if (!telefono) {
          console.warn(`[digest] User ${digest.user_id} sin teléfono → saltando`);
          await actualizarDigestAttemptPorDigest(supabase, digest.id, {
            status: 'failed',
            motivoNoEnvio: 'usuario_sin_telefono_envio',
            errorMsg: 'Usuario sin telefono verificable en envio',
          });
          continue;
        }

        try {
          await enviarDigestPro(telefono, digest.mensaje);

          await supabase
            .from('digests')
            .update({
              enviado:    true,
              enviado_at: new Date().toISOString(),
              error_msg:  null,
            })
            .eq('id', digest.id);

          await actualizarDigestAttemptPorDigest(supabase, digest.id, {
            status: 'sent',
            motivoNoEnvio: null,
            errorMsg: null,
          });

          enviados++;
          console.log(`[digest] ✓ Enviado a ${maskPhone(telefono)} [${i + 1}/${digests.length}]`);

          // Delay entre mensajes (no tras el último)
          if (i < digests.length - 1) {
            await new Promise((r) => setTimeout(r, DELAY_MS));
          }

        } catch (errEnvio) {
          console.error(`[digest] ✗ Error enviando a ${maskPhone(telefono)}:`, errEnvio.message);
          errores.push({ digestId: digest.id, userId: digest.user_id, error: errEnvio.message });

          await supabase
            .from('digests')
            .update({ error_msg: errEnvio.message })
            .eq('id', digest.id);

          await actualizarDigestAttemptPorDigest(supabase, digest.id, {
            status: 'failed',
            motivoNoEnvio: 'fallo_envio_whatsapp',
            errorMsg: errEnvio.message,
          });
        }
      }

      return res.json({
        success: true,
        fecha:   hoy,
        total:   digests.length,
        enviados,
        errores,
      });

    } catch (err) {
      console.error('Error en /alertas/enviar-digest', err);
      return res.status(500).json({ error: err.message });
    }
  };

  // Registrar rutas (GET y POST para compatibilidad con crons)
  app.post('/alertas/preparar-digest', (req, res) => {
    if (!checkCronToken(req, res)) return;
    prepararDigestHandler(req, res);
  });
  app.get('/alertas/preparar-digest', (req, res) => {
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
  app.post('/alertas/preview-digest', (req, res) => {
    if (!checkCronToken(req, res)) return;
    previewDigestHandler(req, res);
  });

  app.post('/alertas/enviar-digest', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarDigestHandler(req, res);
  });
  app.get('/alertas/enviar-digest', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarDigestHandler(req, res);
  });

};
