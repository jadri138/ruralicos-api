const { checkCronToken } = require('../utils/checkCronToken');
const { getFechaMadridISO } = require('../utils/fechaMadrid');
const { normalizePhone } = require('../utils/phoneNormalizer');
const {
  aplicarFeedbackAlPerfil,
  extraerTextoEntrante,
  extraerTelefonoEntrante,
  leerPerfilIntereses,
  parsearVotosDigest,
  analizarFeedbackCompleto,
} = require('../brain');
const { enviarDigestPro } = require('../whatsapp');

function validarWebhookToken(req, res) {
  const esperado = process.env.ULTRAMSG_WEBHOOK_TOKEN;
  if (!esperado) return true;

  const recibido =
    req.query.token ||
    req.headers['x-ruralicos-webhook-token'] ||
    req.headers['x-ultramsg-token'];

  if (recibido && String(recibido) === esperado) return true;
  res.status(401).json({ error: 'Webhook token invalido' });
  return false;
}

async function sumarTagPerfil(supabase, userId, tema, delta) {
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
    .upsert({
      user_id: userId,
      tag: tema,
      score: (Number(actual?.score) || 0) + delta,
      positivos: (Number(actual?.positivos) || 0) + (delta > 0 ? 1 : 0),
      negativos: (Number(actual?.negativos) || 0) + (delta < 0 ? 1 : 0),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,tag' });

  if (upsertError) {
    console.warn(`[feedback] Error actualizando tag ${tema}:`, upsertError.message);
    return false;
  }

  return true;
}

module.exports = function feedbackRoutes(app, supabase) {
  async function guardarWebhookEvent(req, result = null, error = null) {
    const query = { ...(req.query || {}) };
    if (query.token) query.token = '[redacted]';

    try {
      const { data, error: insertError } = await supabase
        .from('webhook_events')
        .insert({
          source: 'ultramsg',
          path: req.path,
          method: req.method,
          content_type: req.headers['content-type'] || null,
          query_json: query,
          body_json: req.body || {},
          processed: Boolean(result?.ok && !result?.ignored),
          result_json: result,
          error_msg: error ? String(error.message || error).slice(0, 1000) : null,
        })
        .select('id')
        .single();

      if (insertError) {
        console.warn('[webhook_events] No se pudo guardar evento:', insertError.message);
        return null;
      }
      return data?.id || null;
    } catch (err) {
      console.warn('[webhook_events] Error inesperado guardando evento:', err.message);
      return null;
    }
  }

  async function guardarFeedbackDesdeTexto({ phone, texto }) {
    const telefono = normalizePhone(phone);
    const rawText = String(texto || '').trim();

    if (!telefono) return { ok: false, error: 'Telefono invalido' };
    if (!rawText) return { ok: true, ignored: true, reason: 'texto_vacio' };

    const { data: user, error: errUser } = await supabase
      .from('users')
      .select('id, phone')
      .eq('phone', telefono)
      .maybeSingle();

    if (errUser) throw errUser;
    if (!user) return { ok: true, ignored: true, reason: 'usuario_no_encontrado', phone: telefono };

    const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: digest, error: errDigest } = await supabase
      .from('digests')
      .select('id, user_id, fecha, alerta_ids, enviado_at, created_at')
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
      .select('id, titulo, resumen, resumen_final, provincias, sectores, subsectores, tipos_alerta, fuente')
      .in('id', alertaIds);

    if (errAlertas) throw errAlertas;
    const alertasPorId = new Map((alertas || []).map((alerta) => [Number(alerta.id), alerta]));
    if (alertasPorId.size === 0) {
      return { ok: true, ignored: true, reason: 'sin_alertas_en_digest', user_id: user.id, digest_id: digest.id };
    }

    const votos = parsearVotosDigest(rawText, alertaIds.length)
      .filter((voto) => voto.item >= 1 && voto.item <= alertaIds.length);

    if (votos.length > 0) {
      const filas = votos
        .map((voto) => {
          const alertaId = alertaIds[voto.item - 1];
          if (!alertasPorId.has(alertaId)) return null;
          return {
            user_id: user.id,
            digest_id: digest.id,
            alerta_id: alertaId,
            item_numero: voto.item,
            valor: voto.valor,
            canal: 'whatsapp',
            raw_text: rawText,
            updated_at: new Date().toISOString(),
          };
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
      if (await sumarTagPerfil(supabase, user.id, tema, 1)) aprendizajesPositivos++;
    }

    for (const tema of analisis.aprende_negativo || []) {
      if (await sumarTagPerfil(supabase, user.id, tema, -1)) aprendizajesNegativos++;
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
      const votos = parsearVotosDigest(texto, Number(req.body?.totalItems || req.query?.totalItems || 0) || null);
      const resultado = votos.length > 0
        ? { tipo: 'votos_digest', votos }
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
        .select('id, name, phone')
        .eq('phone', phone)
        .maybeSingle();

      if (errUser) return res.status(500).json({ error: errUser.message });
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado para ese telefono' });

      const { data: alertas, error: errAlertas } = await supabase
        .from('alertas')
        .select('id, titulo, url, fuente, resumen_final, resumen')
        .eq('estado_ia', 'listo')
        .order('fecha', { ascending: false })
        .order('id', { ascending: false })
        .limit(2);

      if (errAlertas) return res.status(500).json({ error: errAlertas.message });
      if (!alertas || alertas.length === 0) {
        return res.status(404).json({ error: 'No hay alertas listas para construir la prueba' });
      }

      const fecha = req.body?.fecha || req.query.fecha || getFechaMadridISO();
      const nombre = user.name ? ` *${user.name}*` : '';
      const bloques = alertas.map((a, index) => {
        const resumen = (a.resumen_final || a.resumen || a.titulo || '').replace(/\s+/g, ' ').slice(0, 280);
        return [
          `*${index + 1}. ${a.titulo || 'Alerta Ruralicos'}*`,
          resumen,
          a.url || '',
        ].filter(Boolean).join('\n');
      });

      const mensaje = [
        `Hola${nombre}`,
        '',
        '*Ruralicos - prueba de valoracion*',
        '',
        'Este es un digest simulado para comprobar que el sistema aprende de tus respuestas.',
        '',
        ...bloques.flatMap((bloque) => [bloque, '']),
        'Cuales te han interesado?',
        'Responde: *1*, *2*, *ambas* o *ninguna*',
      ].join('\n').trim();

      const { data: digest, error: digestError } = await supabase
        .from('digests')
        .upsert({
          user_id: user.id,
          fecha,
          mensaje,
          alerta_ids: alertas.map((a) => a.id),
          enviado: true,
          enviado_at: new Date().toISOString(),
          error_msg: null,
        }, { onConflict: 'user_id,fecha' })
        .select('id, user_id, fecha, alerta_ids')
        .single();

      if (digestError) return res.status(500).json({ error: digestError.message });

      await enviarDigestPro(phone, mensaje);

      return res.json({
        ok: true,
        mensaje: 'Digest de prueba enviado. Responde por WhatsApp 1, 2, ambas o ninguna.',
        phone,
        digest,
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
        .select('id, phone, name')
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
        .select('id, phone, name, subscription')
        .eq('phone', phone)
        .maybeSingle();

      if (errUser) return res.status(500).json({ error: errUser.message });
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado', phone });

      const [
        { data: digests, error: errDigests },
        { data: feedback, error: errFeedback },
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
      if (errPerfil) return res.status(500).json({ error: errPerfil.message });
      if (errEventos) return res.status(500).json({ error: errEventos.message });

      return res.json({
        ok: true,
        user,
        digests: digests || [],
        feedback: feedback || [],
        perfil: perfil || [],
        webhook_events: eventos || [],
      });
    } catch (err) {
      console.error('Error en /feedback/diagnostico:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.all('/webhooks/ultramsg/feedback', async (req, res) => {
    if (!validarWebhookToken(req, res)) return;

    try {
      const texto = extraerTextoEntrante(req.body);
      const telefono = normalizePhone(extraerTelefonoEntrante(req.body));
      const result = await guardarFeedbackDesdeTexto({ phone: telefono, texto });
      await guardarWebhookEvent(req, result, null);

      const enviarConfirmacion = (process.env.FEEDBACK_CONFIRMATION_ENABLED || 'false').toLowerCase() === 'true';

      if (enviarConfirmacion && result.ok && result.feedbacks_guardados > 0) {
        enviarDigestPro(telefono, 'Gracias. He guardado tu respuesta y afinare las proximas alertas.')
          .catch((err) => console.error('[feedback] Error enviando confirmacion:', err.message));
      }

      return res.json(result);
    } catch (err) {
      console.error('Error en /webhooks/ultramsg/feedback:', err);
      await guardarWebhookEvent(req, null, err);
      return res.status(500).json({ error: err.message });
    }
  });
};
