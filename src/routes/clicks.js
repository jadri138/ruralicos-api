const crypto = require('crypto');
const { checkCronToken } = require('../utils/checkCronToken');

function hashIp(ip) {
  const salt = process.env.JWT_SECRET || process.env.CRON_TOKEN || 'ruralicos';
  return crypto
    .createHash('sha256')
    .update(`${salt}:${ip || ''}`)
    .digest('hex')
    .slice(0, 32);
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}

function isSafeRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

async function guardarMemoriaClickSiPrimero(supabase, link) {
  const { count, error: countError } = await supabase
    .from('alerta_clicks')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', link.user_id)
    .eq('digest_id', link.digest_id)
    .eq('alerta_id', link.alerta_id);

  if (countError) {
    console.warn('[clicks] No se pudo contar clicks previos:', countError.message);
    return;
  }

  if ((count || 0) > 0) return;

  const { data: alerta, error: alertaError } = await supabase
    .from('alertas')
    .select('titulo')
    .eq('id', link.alerta_id)
    .maybeSingle();

  if (alertaError) {
    console.warn('[clicks] No se pudo cargar alerta para memoria:', alertaError.message);
  }

  const { error: memoriaError } = await supabase
    .from('user_memory')
    .insert({
      user_id: link.user_id,
      tipo: 'feedback_positivo',
      contenido: `Hizo click en la alerta: ${alerta?.titulo || link.url_destino}`,
      alerta_id: link.alerta_id,
      digest_id: link.digest_id,
      peso_inicial: 0.45,
    });

  if (memoriaError) {
    console.warn('[clicks] No se pudo guardar memoria de click:', memoriaError.message);
  }
}

module.exports = function clicksRoutes(app, supabase) {
  const clickHandler = async (req, res) => {
    const token = String(req.params.token || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(token)) {
      return res.status(404).send('Enlace no encontrado');
    }

    try {
      const { data: link, error } = await supabase
        .from('alerta_click_links')
        .select('token, user_id, digest_id, alerta_id, url_destino, click_count')
        .eq('token', token)
        .maybeSingle();

      if (error) throw error;
      if (!link || !isSafeRedirectUrl(link.url_destino)) {
        return res.status(404).send('Enlace no encontrado');
      }

      await guardarMemoriaClickSiPrimero(supabase, link);

      const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
      const referer = String(req.headers.referer || req.headers.referrer || '').slice(0, 500);
      const ipHash = hashIp(getClientIp(req));
      const now = new Date().toISOString();

      const { error: insertError } = await supabase
        .from('alerta_clicks')
        .insert({
          token: link.token,
          user_id: link.user_id,
          digest_id: link.digest_id,
          alerta_id: link.alerta_id,
          url_destino: link.url_destino,
          user_agent: userAgent,
          referer,
          ip_hash: ipHash,
        });

      if (insertError) {
        console.warn('[clicks] No se pudo registrar click:', insertError.message);
      }

      const { error: updateError } = await supabase
        .from('alerta_click_links')
        .update({
          click_count: Number(link.click_count || 0) + 1,
          last_clicked_at: now,
        })
        .eq('token', link.token);

      if (updateError) {
        console.warn('[clicks] No se pudo actualizar contador de click:', updateError.message);
      }

      return res.redirect(302, link.url_destino);
    } catch (err) {
      console.error('[clicks] Error procesando click:', err.message);
      return res.status(500).send('No se pudo abrir el enlace');
    }
  };

  const recientesHandler = async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const hours = Math.max(1, Math.min(168, Number(req.query.hours || 24)));
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const desde = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    try {
      const { data, error } = await supabase
        .from('alerta_clicks')
        .select(`
          id,
          token,
          user_id,
          digest_id,
          alerta_id,
          url_destino,
          created_at,
          users(id, name, phone, subscription),
          alertas(id, titulo, fuente, provincias, sectores, subsectores, tipos_alerta),
          digests(id, fecha, enviado_at)
        `)
        .gte('created_at', desde)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      return res.json({
        ok: true,
        hours,
        total: (data || []).length,
        clicks: data || [],
      });
    } catch (err) {
      console.error('[clicks] Error en /clicks/recientes:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  };

  app.get('/a/:token', clickHandler);
  app.get('/alerta/:token', clickHandler);
  app.get('/clicks/recientes', recientesHandler);
};
