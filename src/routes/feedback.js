const { checkCronToken } = require('../middleware/cronToken');
const crypto = require('crypto');
const { getFechaMadridISO, getRangoDiaMadridUTC } = require('../shared/fechaMadrid');
const { normalizePhone } = require('../shared/phoneNormalizer');
const {
  aplicarFeedbackAlPerfil,
  extraerTextoEntrante,
  extraerTelefonoEntrante,
  leerPerfilIntereses,
  parsearVotosDigest,
  parsearVotosNaturalesPorAlertas,
  analizarFeedbackCompleto,
} = require('../brain');
const { enviarDigestPro } = require('../platform/whatsapp');
const { extraerUltraMsg, esEventoMensajeUltraMsg } = require('../shared/ultramsgParser');
const { registrarInboundMIA, actualizarInboundMIA } = require('../modules/mia/inbound');
const { decidirMensajeMIA, esRespuestaOrigenCaptacionMIA } = require('../modules/mia/decisionCore');
const { cargarDigestItemsMIA } = require('../modules/mia/digestItems');
const { registrarMemoriaEstructuradaMIA } = require('../modules/mia/structuredMemory');
const {
  ejecutarAccionesMIA,
  registrarCasoAgenteMIA,
  abrirConversacionAgenteMIA,
} = require('../modules/mia/actionExecutor');
const {
  resolverPreguntaConBaseConocimientoMIA,
  aplicarRespuestaConocimientoADecision,
} = require('../modules/mia/knowledgeBase');
const {
  registrarDecisionYAccionesMIA,
  actualizarDecisionResultadoMIA,
  actualizarAccionesPorTipoMIA,
} = require('../modules/mia/decisionStore');
const {
  encolarRespuestaMIA,
  procesarOutboxItemMIA,
} = require('../modules/mia/outbox');
const { guardarWebhookEventSeguro } = require('../modules/mia/webhookEvent');
const {
  cargarPerfilOperativoMIA,
  aplicarPerfilOperativoAUsuario,
} = require('../modules/mia/userProfile');
const { evaluarPoliticaDecisionMIA } = require('../modules/mia/policy');
const {
  conOrganizationId,
  extraerOrganizationId,
  filtrarAlertasPorOrganization,
  cargarOrganizationContextMIA,
  aplicarOrganizationContextAUsuario,
  obtenerMiaBranding,
} = require('../modules/mia/organizationContext');

function comprobarWebhookToken(req) {
  const esperado = String(process.env.ULTRAMSG_WEBHOOK_TOKEN || '').trim();
  const tokenObligatorio =
    process.env.NODE_ENV === 'production' ||
    process.env.RENDER === 'true' ||
    Boolean(process.env.RENDER_SERVICE_ID) ||
    String(process.env.REQUIRE_ULTRAMSG_WEBHOOK_TOKEN || '').toLowerCase() === 'true';

  if (!esperado) {
    if (!tokenObligatorio) return { ok: true };
    console.error('[webhook] Falta ULTRAMSG_WEBHOOK_TOKEN con validacion obligatoria');
    return {
      ok: false,
      status: 503,
      reason: 'webhook_token_no_configurado',
      error: 'Webhook no configurado',
    };
  }

  const authHeader = String(req.headers.authorization || '');
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const recibido =
    req.query.token ||
    req.headers['x-ruralicos-webhook-token'] ||
    req.headers['x-ultramsg-token'] ||
    bearerToken;

  const recibidoTexto = String(recibido || '').trim();
  if (recibidoTexto) {
    const esperadoBuffer = Buffer.from(esperado);
    const recibidoBuffer = Buffer.from(recibidoTexto);
    if (
      esperadoBuffer.length === recibidoBuffer.length &&
      crypto.timingSafeEqual(esperadoBuffer, recibidoBuffer)
    ) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    status: 401,
    reason: 'webhook_token_invalido',
    error: 'Webhook token invalido',
  };
}

function extraerFechaConversacionMIA(valor) {
  const match = String(valor || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function fechaMadridConversacionMIA(conversacion = {}) {
  const fechaContexto = extraerFechaConversacionMIA(conversacion.contexto_json?.fecha);
  if (fechaContexto) return fechaContexto;

  const abiertaAt = conversacion.abierta_at || conversacion.created_at || null;
  if (!abiertaAt) return '';

  const fecha = new Date(abiertaAt);
  if (Number.isNaN(fecha.getTime())) return '';
  return getFechaMadridISO(fecha);
}

function esConversacionMIADelDia(conversacion = {}, fechaHoy = getFechaMadridISO()) {
  return fechaMadridConversacionMIA(conversacion) === fechaHoy;
}

function getExpiracionFinDiaMadridISO(fecha = getFechaMadridISO()) {
  const fechaISO = extraerFechaConversacionMIA(fecha) || getFechaMadridISO();
  return getRangoDiaMadridUTC(fechaISO).fin;
}

function getClickBaseUrl() {
  return String(
    process.env.CLICK_BASE_URL ||
    process.env.PUBLIC_LINK_BASE_URL ||
    'https://ruralicos.es'
  ).replace(/\/+$/g, '');
}

function construirUrlTracking(token) {
  const baseUrl = getClickBaseUrl();
  const formato = String(process.env.CLICK_LINK_FORMAT || 'query').toLowerCase();
  const tokenSeguro = encodeURIComponent(token);
  return formato === 'path' ? `${baseUrl}/a/${tokenSeguro}` : `${baseUrl}/?a=${tokenSeguro}`;
}

function generarTokenClick() {
  return crypto.randomBytes(9).toString('base64url');
}

function escaparRegExp(texto) {
  return String(texto || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function aplicarLinksTrackingDigest(supabase, { mensaje, userId, digestId, alertas, organizationId = null }) {
  if ((process.env.CLICK_TRACKING_ENABLED || 'true').toLowerCase() === 'false') {
    return { mensaje, links: [], enabled: false };
  }

  let mensajeFinal = mensaje;
  const links = [];

  for (const alerta of alertas || []) {
    if (!alerta?.id || !alerta?.url || !mensajeFinal.includes(alerta.url)) continue;

    const token = generarTokenClick();
    const { data, error } = await supabase
      .from('alerta_click_links')
      .upsert(conOrganizationId({
        token,
        user_id: userId,
        digest_id: digestId,
        alerta_id: alerta.id,
        url_destino: alerta.url,
      }, organizationId), { onConflict: 'user_id,digest_id,alerta_id' })
      .select('token, alerta_id, url_destino')
      .single();

    if (error) {
      console.warn('[feedback:prueba] Tracking no disponible, manteniendo URLs oficiales:', error.message);
      return { mensaje, links, enabled: false, error: error.message };
    }

    const tokenFinal = data?.token || token;
    const urlTracking = construirUrlTracking(tokenFinal);
    mensajeFinal = mensajeFinal.replace(new RegExp(escaparRegExp(alerta.url), 'g'), urlTracking);
    links.push({
      alerta_id: alerta.id,
      token: tokenFinal,
      url_tracking: urlTracking,
      url_destino: alerta.url,
    });
  }

  return { mensaje: mensajeFinal, links, enabled: true };
}

async function abrirConversacionFeedbackPrueba(supabase, {
  userId,
  digestId,
  alertaIds,
  fecha,
  organizationId = null,
}) {
  const ahora = new Date().toISOString();

  const { error: cerrarError } = await supabase
    .from('user_conversations')
    .update({
      estado: 'expirada',
      cerrada_at: ahora,
    })
    .eq('user_id', userId)
    .eq('tipo', 'feedback_digest')
    .eq('estado', 'activa');

  if (cerrarError) {
    console.warn('[feedback:prueba] No se pudieron cerrar conversaciones previas:', cerrarError.message);
  }

  const { error } = await supabase
    .from('user_conversations')
    .insert(conOrganizationId({
      user_id: userId,
      tipo: 'feedback_digest',
      estado: 'activa',
      contexto_json: {
        digest_id: digestId,
        alerta_ids: alertaIds,
        fecha,
        origen: 'digest_prueba',
      },
      digest_id: digestId,
      expira_at: getExpiracionFinDiaMadridISO(fecha),
    }, organizationId));

  if (error) {
    console.warn('[feedback:prueba] No se pudo abrir conversacion de prueba:', error.message);
  }
}

async function sumarTagPerfil(supabase, userId, tema, delta, organizationId = null) {
  const { data: actual, error: selectError } = await supabase
    .from('user_interest_profile')
    .select('score, positivos, negativos')
    .eq('user_id', userId)
    .eq('tag', tema)
    .maybeSingle();

  if (selectError) {
    console.warn(`[feedback] Error leyendo tag ${tema}:`, selectError.message);
    return false;
  }

  const { error: upsertError } = await supabase
    .from('user_interest_profile')
    .upsert(conOrganizationId({
      user_id: userId,
      tag: tema,
      score: (Number(actual?.score) || 0) + delta,
      positivos: (Number(actual?.positivos) || 0) + (delta > 0 ? 1 : 0),
      negativos: (Number(actual?.negativos) || 0) + (delta < 0 ? 1 : 0),
      updated_at: new Date().toISOString(),
    }, organizationId), { onConflict: 'user_id,tag' });

  if (upsertError) {
    console.warn(`[feedback] Error actualizando tag ${tema}:`, upsertError.message);
    return false;
  }

  return true;
}

async function buscarConversacionActiva(supabase, userId, options = {}) {
  const fechaHoy = options.fechaHoy || getFechaMadridISO();
  const { data, error } = await supabase
    .from('user_conversations')
    .select('id, user_id, estado, tipo, contexto_json, digest_id, abierta_at, expira_at')
    .eq('user_id', userId)
    .eq('estado', 'activa')
    .gt('expira_at', new Date().toISOString())
    .order('abierta_at', { ascending: false })
    .limit(10);

  if (error) throw error;
  const conversaciones = Array.isArray(data) ? data : [];
  const obsoletas = conversaciones.filter((item) => !esConversacionMIADelDia(item, fechaHoy));
  const idsObsoletas = obsoletas.map((item) => item.id).filter(Boolean);

  if (idsObsoletas.length > 0) {
    const { error: cerrarError } = await supabase
      .from('user_conversations')
      .update({
        estado: 'expirada',
        cerrada_at: new Date().toISOString(),
      })
      .in('id', idsObsoletas);

    if (cerrarError) {
      console.warn('[mia:conversation] No se pudieron expirar conversaciones de dias anteriores:', cerrarError.message);
    }
  }

  return conversaciones.find((item) => esConversacionMIADelDia(item, fechaHoy)) || null;
}

async function cargarDigestYAlertas(supabase, userId, conversacionActiva, organizationId = null, options = {}) {
  let digest = null;
  const fechaHoy = options.fechaHoy || getFechaMadridISO();

  const digestId = conversacionActiva?.contexto_json?.digest_id || conversacionActiva?.digest_id;
  if (digestId) {
    const { data, error } = await supabase
      .from('digests')
      .select('id, user_id, fecha, alerta_ids, organization_id')
      .eq('id', digestId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    digest = data || null;
  }

  if (!digest) {
    const { data, error } = await supabase
      .from('digests')
      .select('id, user_id, fecha, alerta_ids, organization_id, enviado_at, created_at')
      .eq('user_id', userId)
      .eq('fecha', fechaHoy)
      .eq('enviado', true)
      .order('enviado_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    digest = data || null;
  }

  const digestItems = await cargarDigestItemsMIA(supabase, digest?.id);
  const alertaIds = Array.isArray(digestItems) && digestItems.length > 0
    ? digestItems.map((item) => Number(item.alerta_id)).filter(Boolean)
    : Array.isArray(digest?.alerta_ids)
      ? digest.alerta_ids.map(Number).filter(Boolean)
      : [];

  if (!digest || alertaIds.length === 0) {
    return { digest, alertaIds: [], alertasOrdenadas: [] };
  }

  const { data: alertas, error: errAlertas } = await supabase
    .from('alertas')
    .select('id, titulo, resumen, resumen_final, provincias, sectores, subsectores, tipos_alerta, fuente, organization_id')
    .in('id', alertaIds);

  if (errAlertas) throw errAlertas;

  const alertasPorId = new Map((alertas || []).map((alerta) => [Number(alerta.id), alerta]));
  const alertasVisibles = filtrarAlertasPorOrganization(
    alertaIds.map((id) => alertasPorId.get(id)).filter(Boolean),
    organizationId
  );
  return {
    digest,
    alertaIds,
    alertasOrdenadas: alertasVisibles,
  };
}

function candidatosTelefonoUsuario(telefono) {
  const normalizado = normalizePhone(telefono);
  const candidatos = new Set();

  if (normalizado) candidatos.add(normalizado);
  if (normalizado.length === 11 && normalizado.startsWith('34')) {
    candidatos.add(normalizado.slice(2));
  }
  if (normalizado.length === 9) {
    candidatos.add(`34${normalizado}`);
  }

  return [...candidatos].filter(Boolean);
}

async function buscarUsuarioPorTelefonoEntrante(supabase, telefono, select) {
  const candidatos = candidatosTelefonoUsuario(telefono);
  if (candidatos.length === 0) return null;

  const { data, error } = await supabase
    .from('users')
    .select(select)
    .in('phone', candidatos)
    .limit(candidatos.length);

  if (error) throw error;

  const users = data || [];
  if (users.length === 0) return null;

  return candidatos
    .map((candidato) => users.find((user) => String(user.phone || '') === candidato))
    .find(Boolean) || users[0];
}

function feedbackRoutes(app, supabase) {
  async function guardarWebhookEvent(req, result = null, error = null) {
    return guardarWebhookEventSeguro(supabase, req, result, error);
  }

  async function guardarFeedbackDesdeTexto({ phone, texto }) {
    const telefono = normalizePhone(phone);
    const rawText = String(texto || '').trim();

    if (!telefono) return { ok: false, error: 'Telefono invalido' };
    if (!rawText) return { ok: true, ignored: true, reason: 'texto_vacio' };

    const user = await buscarUsuarioPorTelefonoEntrante(supabase, telefono, 'id, phone, organization_id');
    if (!user) return { ok: true, ignored: true, reason: 'usuario_no_encontrado', phone: telefono };
    const organizationId = extraerOrganizationId(user);

    const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: digest, error: errDigest } = await supabase
      .from('digests')
      .select('id, user_id, fecha, alerta_ids, organization_id, enviado_at, created_at')
      .eq('user_id', user.id)
      .eq('enviado', true)
      .or(`enviado_at.gte.${desde},created_at.gte.${desde}`)
      .order('enviado_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (errDigest) throw errDigest;
    if (!digest) return { ok: true, ignored: true, reason: 'sin_digest_reciente', user_id: user.id };

    const alertaIds = Array.isArray(digest.alerta_ids) ? digest.alerta_ids.map(Number).filter(Boolean) : [];
    if (alertaIds.length === 0) {
      return { ok: true, ignored: true, reason: 'digest_sin_alertas', user_id: user.id, digest_id: digest.id };
    }

    const { data: alertas, error: errAlertas } = await supabase
      .from('alertas')
      .select('id, titulo, resumen, resumen_final, provincias, sectores, subsectores, tipos_alerta, fuente, organization_id')
      .in('id', alertaIds);

    if (errAlertas) throw errAlertas;
    const alertasPorId = new Map((alertas || []).map((alerta) => [Number(alerta.id), alerta]));
    if (alertasPorId.size === 0) {
      return { ok: true, ignored: true, reason: 'sin_alertas_en_digest', user_id: user.id, digest_id: digest.id };
    }
    const alertasOrdenadas = alertaIds.map((id) => alertasPorId.get(id)).filter(Boolean);

    let origenFeedback = 'numerico';
    let votos = parsearVotosDigest(rawText, alertaIds.length)
      .filter((voto) => voto.item >= 1 && voto.item <= alertaIds.length);

    if (votos.length === 0) {
      const natural = parsearVotosNaturalesPorAlertas(rawText, alertasOrdenadas);
      if (natural.matched) {
        origenFeedback = 'lenguaje_natural_alerta';
        votos = natural.votos;
      }
    }

    if (votos.length > 0) {
      const filas = votos
        .map((voto) => {
          const alertaId = alertaIds[voto.item - 1];
          if (!alertasPorId.has(alertaId)) return null;
          return conOrganizationId({
            user_id: user.id,
            digest_id: digest.id,
            alerta_id: alertaId,
            item_numero: voto.item,
            valor: voto.valor,
            canal: 'whatsapp',
            raw_text: rawText,
            updated_at: new Date().toISOString(),
          }, organizationId);
        })
        .filter(Boolean);

      if (filas.length === 0) {
        return { ok: true, ignored: true, reason: 'votos_fuera_de_rango', user_id: user.id, digest_id: digest.id };
      }

      const { error: upsertError } = await supabase
        .from('alerta_feedback')
        .upsert(filas, { onConflict: 'user_id,digest_id,alerta_id' });

      if (upsertError) throw upsertError;

      let tagsActualizados = 0;
      for (const fila of filas) {
        const resultado = await aplicarFeedbackAlPerfil(supabase, {
          userId: user.id,
          alerta: alertasPorId.get(Number(fila.alerta_id)),
          delta: fila.valor,
          rawText,
        });
        tagsActualizados += Number(resultado?.updated || 0);
      }

      return {
        ok: true,
        user_id: user.id,
        digest_id: digest.id,
        feedbacks_guardados: filas.length,
        tags_actualizados: tagsActualizados,
        raw_text: rawText,
        origen: origenFeedback,
        votos: filas.map((fila) => ({
          item: fila.item_numero,
          alerta_id: fila.alerta_id,
          valor: fila.valor,
        })),
      };
    }

    const analisis = await analizarFeedbackCompleto(rawText);
    if (!analisis.es_valido) {
      return {
        ok: true,
        ignored: true,
        reason: 'texto_cualitativo_sin_feedback_numerico',
        user_id: user.id,
        digest_id: digest.id,
        raw_text: rawText,
        confianza: analisis.confianza,
      };
    }

    let aprendizajesPositivos = 0;
    let aprendizajesNegativos = 0;

    for (const tema of analisis.aprende_positivo || []) {
      if (await sumarTagPerfil(supabase, user.id, tema, 1, organizationId)) aprendizajesPositivos++;
    }

    for (const tema of analisis.aprende_negativo || []) {
      if (await sumarTagPerfil(supabase, user.id, tema, -1, organizationId)) aprendizajesNegativos++;
    }

    return {
      ok: true,
      user_id: user.id,
      digest_id: digest.id,
      feedbacks_guardados: 0,
      raw_text: rawText,
      sentimiento: analisis.sentimiento,
      confianza: analisis.confianza,
      aprendizajes_positivos: aprendizajesPositivos,
      aprendizajes_negativos: aprendizajesNegativos,
      aprende_positivo: analisis.aprende_positivo,
      aprende_negativo: analisis.aprende_negativo,
      temas_mencionados: analisis.temas_mencionados,
    };
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

  const enviarDigestPruebaHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const phone = normalizePhone(req.body?.phone || req.query.phone);
      if (!phone || phone.length !== 11) {
        return res.status(400).json({ error: 'Indica phone en formato 34XXXXXXXXX o 6XXXXXXXX' });
      }

      const { data: user, error: errUser } = await supabase
        .from('users')
        .select('id, name, phone, organization_id')
        .eq('phone', phone)
        .maybeSingle();

      if (errUser) return res.status(500).json({ error: errUser.message });
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado para ese telefono' });
      const organizationContext = await cargarOrganizationContextMIA(supabase, user);
      const organizationId = organizationContext.organization_id || extraerOrganizationId(user);
      const branding = obtenerMiaBranding(organizationContext);

      const { data: alertasRaw, error: errAlertas } = await supabase
        .from('alertas')
        .select('id, titulo, url, fuente, resumen_final, resumen, organization_id')
        .eq('estado_ia', 'listo')
        .order('fecha', { ascending: false })
        .order('id', { ascending: false })
        .limit(2);

      if (errAlertas) return res.status(500).json({ error: errAlertas.message });
      const alertas = filtrarAlertasPorOrganization(alertasRaw || [], organizationId);
      if (!alertas || alertas.length === 0) {
        return res.status(404).json({ error: 'No hay alertas listas para construir la prueba' });
      }

      const fecha = req.body?.fecha || req.query.fecha || getFechaMadridISO();
      const digestPruebaRef = `${fecha}-prueba-${Date.now()}`;
      const nombre = user.name ? ` *${user.name}*` : '';
      const bloques = alertas.map((a, index) => {
        const resumen = (a.resumen_final || a.resumen || a.titulo || '').replace(/\s+/g, ' ').slice(0, 280);
        return [
          `*${index + 1}. ${a.titulo || `Alerta ${branding.reply_sender}`}*`,
          resumen,
          a.url || '',
        ].filter(Boolean).join('\n');
      });

      let mensaje = [
        `Hola${nombre}`,
        '',
        `*${branding.digest_title} - prueba de valoracion*`,
        '',
        'Este es un digest simulado para comprobar que el sistema aprende de tus respuestas.',
        '',
        ...bloques.flatMap((bloque) => [bloque, '']),
        'Cuales te han interesado?',
        'Responde: *1*, *2*, *ambas* o *ninguna*',
      ].join('\n').trim();

      const { data: digest, error: digestError } = await supabase
        .from('digests')
        .upsert(conOrganizationId({
          user_id: user.id,
          fecha,
          mensaje,
          alerta_ids: alertas.map((a) => a.id),
          enviado: true,
          enviado_at: new Date().toISOString(),
          error_msg: null,
        }, organizationId), { onConflict: 'user_id,fecha' })
        .select('id, user_id, fecha, alerta_ids, organization_id')
        .single();

      if (digestError) return res.status(500).json({ error: digestError.message });

      await supabase
        .from('alerta_click_links')
        .delete()
        .eq('user_id', user.id)
        .eq('digest_id', digest.id);

      const tracking = await aplicarLinksTrackingDigest(supabase, {
        mensaje,
        userId: user.id,
        digestId: digest.id,
        alertas,
        organizationId,
      });

      if (tracking.enabled && tracking.mensaje !== mensaje) {
        mensaje = tracking.mensaje;
        const { error: updateDigestError } = await supabase
          .from('digests')
          .update({ mensaje })
          .eq('id', digest.id);

        if (updateDigestError) {
          console.warn('[feedback:prueba] No se pudo actualizar digest con links tracking:', updateDigestError.message);
        }
      }

      await abrirConversacionFeedbackPrueba(supabase, {
        userId: user.id,
        digestId: digest.id,
        alertaIds: alertas.map((a) => a.id),
        fecha: digestPruebaRef,
        organizationId,
      });

      await enviarDigestPro(phone, mensaje);

      return res.json({
        ok: true,
        mensaje: 'Digest de prueba enviado. Responde por WhatsApp 1, 2, ambas o ninguna.',
        phone,
        digest,
        digest_prueba_ref: digestPruebaRef,
        tracking: {
          enabled: tracking.enabled,
          links: tracking.links,
          error: tracking.error || null,
        },
      });
    } catch (err) {
      console.error('Error en /feedback/enviar-digest-prueba:', err);
      return res.status(500).json({ error: err.message });
    }
  };

  app.post('/feedback/enviar-digest-prueba', enviarDigestPruebaHandler);
  app.get('/feedback/enviar-digest-prueba', enviarDigestPruebaHandler);

  app.get('/feedback/simular-respuesta', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const result = await guardarFeedbackDesdeTexto({
        phone: req.query.phone,
        texto: req.query.texto || req.query.body || '+1',
      });
      return res.json(result);
    } catch (err) {
      console.error('Error en /feedback/simular-respuesta:', err);
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
      const conversacionActiva = await buscarConversacionActiva(supabase, user.id);
      const { digest, alertasOrdenadas } = await cargarDigestYAlertas(
        supabase,
        user.id,
        conversacionActiva,
        organizationId
      );

      let decisionMIA = await decidirMensajeMIA({
        mensajeUsuario: texto,
        usuario: usuarioMIA,
        conversacionActiva,
        digest,
        alertasDelDigest: alertasOrdenadas,
      });
      decisionMIA = {
        ...decisionMIA,
        organization_context: organizationContext,
      };

      if (['pregunta_usuario', 'unknown'].includes(decisionMIA.intent)) {
        try {
          const respuestaConocimiento = await resolverPreguntaConBaseConocimientoMIA(supabase, {
            texto,
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
        texto,
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
          }, enviarDigestPro)
            .then((result) => {
              if (result.ok === false) console.error('[feedback] Error enviando respuesta MIA:', result.error);
            })
            .catch((err) => console.error('[feedback] Error inesperado procesando outbox MIA:', err.message));
        } else if (!outboxMIA.id && enviarInmediato) {
          enviarDigestPro(telefono, textoRespuesta)
            .catch((err) => console.error('[feedback] Error enviando respuesta MIA sin outbox:', err.message));
        }
      }

      const result = {
        ok: true,
        user_id: user.id,
        organization_id: organizationId,
        digest_id: digest?.id || null,
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

      const enviarConfirmacion = (process.env.FEEDBACK_CONFIRMATION_ENABLED || 'false').toLowerCase() === 'true';

      if (enviarConfirmacion && result.ok && result.feedbacks_guardados > 0 && !interpretacion.requiere_respuesta) {
        enviarDigestPro(telefono, 'Gracias. He guardado tu respuesta y afinare las proximas alertas.')
          .catch((err) => console.error('[feedback] Error enviando confirmacion:', err.message));
      }

      return res.json(result);
    } catch (err) {
      console.error('Error en /webhooks/ultramsg/feedback:', err);
      await actualizarInboundMIA(supabase, inboundMIA?.id, {
        status: 'failed',
        error_msg: err.message,
      });
      await guardarWebhookEvent(req, null, err);
      return res.status(500).json({ error: err.message });
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
};
