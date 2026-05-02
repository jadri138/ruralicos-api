const { extraerTextoEntrante, extraerTelefonoEntrante, parsearVotosDigest } = require('../utils/feedbackParser');
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
