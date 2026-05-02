const { extraerTextoEntrante, extraerTelefonoEntrante, parsearVotosDigest } = require('../utils/feedbackParser');
const { checkCronToken } = require('../utils/checkCronToken');
const { getFechaMadridISO } = require('../utils/fechaMadrid');
const { normalizePhone } = require('../utils/phoneNormalizer');
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

module.exports = function feedbackRoutes(app, supabase) {
  app.post('/feedback/enviar-digest-prueba', async (req, res) => {
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
        '_Responde +1 -2 para probar la valoracion._',
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
        mensaje: 'Digest de prueba enviado. Responde por WhatsApp +1 -2.',
        phone,
        digest,
      });
    } catch (err) {
      console.error('Error en /feedback/enviar-digest-prueba:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/webhooks/ultramsg/feedback', async (req, res) => {
    if (!validarWebhookToken(req, res)) return;

    try {
      const texto = extraerTextoEntrante(req.body);
      const telefono = normalizePhone(extraerTelefonoEntrante(req.body));
      const votos = parsearVotosDigest(texto);

      if (!telefono || votos.length === 0) {
        return res.json({ ok: true, ignored: true, reason: 'sin_votos_digest' });
      }

      const { data: user, error: errUser } = await supabase
        .from('users')
        .select('id, phone')
        .eq('phone', telefono)
        .maybeSingle();

      if (errUser) return res.status(500).json({ error: errUser.message });
      if (!user) return res.json({ ok: true, ignored: true, reason: 'usuario_no_encontrado' });

      const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: digest, error: errDigest } = await supabase
        .from('digests')
        .select('id, user_id, fecha, alerta_ids')
        .eq('user_id', user.id)
        .eq('enviado', true)
        .gte('created_at', desde)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (errDigest) return res.status(500).json({ error: errDigest.message });
      if (!digest) return res.json({ ok: true, ignored: true, reason: 'sin_digest_reciente' });

      const alertaIds = Array.isArray(digest.alerta_ids) ? digest.alerta_ids : [];
      const registros = [];

      for (const voto of votos) {
        const alertaId = alertaIds[voto.item - 1];
        if (!alertaId) continue;
        registros.push({
          user_id: user.id,
          digest_id: digest.id,
          alerta_id: alertaId,
          item_numero: voto.item,
          valor: voto.valor,
          canal: 'whatsapp',
          raw_text: String(texto || '').slice(0, 500),
        });
      }

      if (registros.length === 0) {
        return res.json({ ok: true, ignored: true, reason: 'numeros_fuera_de_digest' });
      }

      const { error: upsertError } = await supabase
        .from('alerta_feedback')
        .upsert(registros, { onConflict: 'user_id,digest_id,alerta_id' });

      if (upsertError) return res.status(500).json({ error: upsertError.message });

      const positivos = registros.filter((r) => r.valor > 0).length;
      const negativos = registros.filter((r) => r.valor < 0).length;
      const enviarConfirmacion = (process.env.FEEDBACK_CONFIRMATION_ENABLED || 'false').toLowerCase() === 'true';

      if (enviarConfirmacion) {
        enviarDigestPro(
          user.phone,
          `Gracias. He guardado tu valoracion: ${positivos} util(es), ${negativos} poco util(es).`
        ).catch((err) => console.error('[feedback] Error enviando confirmacion:', err.message));
      }

      return res.json({
        ok: true,
        user_id: user.id,
        digest_id: digest.id,
        votos_guardados: registros.length,
        positivos,
        negativos,
      });
    } catch (err) {
      console.error('Error en /webhooks/ultramsg/feedback:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
