// src/modules/digest/digestOutbox.js
//
// Envio del digest diario VIA COLA (patron outbox), reutilizando mia_outbox:
// en vez de mandar N WhatsApps dentro de una unica request larga (fragil en
// Render: proxy corta a ~55s, sin reintentos), /alertas/enviar-digest encola
// los pendientes y el drenador de /tareas/mia-outbox los envia con reintentos,
// backoff y recuperacion de atascados que ya existen para MIA.
//
// Activacion: DIGEST_VIA_OUTBOX=true (default false: comportamiento actual de
// envio sincrono intacto hasta decidir el cutover).
//
// Dedupe: ademas del chequeo en codigo, la migracion 20260708_add_digest
// _outbox_dedupe crea un unique parcial sobre (channel, to_phone,
// metadata_json->>'digest_id'), asi que reencolar el mismo digest es no-op
// aunque dos crons se solapen.

const { actualizarDigestAttemptPorDigest } = require('../mia/digestAttempts');

const UNIQUE_VIOLATION = '23505';

function digestViaOutboxHabilitado(env = process.env) {
  return String(env.DIGEST_VIA_OUTBOX || 'false').toLowerCase() === 'true';
}

function digestIdDeOutboxItem(item) {
  const raw = item?.metadata_json?.digest_id;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Encola en mia_outbox los digests del dia pendientes de envio. Idempotente:
// los ya encolados (unique de digest_id) se cuentan como `ya_encolados`.
async function encolarDigestsPendientes(supabase, { fecha, ahora = () => new Date() } = {}) {
  const { data: digests, error } = await supabase
    .from('digests')
    .select('id, user_id, fecha, mensaje, organization_id')
    .eq('fecha', fecha)
    .eq('enviado', false)
    .order('created_at', { ascending: true });
  if (error) throw error;

  if (!digests || digests.length === 0) {
    return { total: 0, encolados: 0, ya_encolados: 0, sin_telefono: 0, errores: [] };
  }

  const userIds = digests.map((d) => d.user_id);
  const { data: usuarios, error: errUsers } = await supabase
    .from('users')
    .select('id, phone')
    .in('id', userIds)
    .or('phone_verified.is.null,phone_verified.eq.true');
  if (errUsers) throw errUsers;

  const telefonoPorUserId = new Map((usuarios || []).map((u) => [Number(u.id), (u.phone || '').trim()]));

  let encolados = 0;
  let yaEncolados = 0;
  let sinTelefono = 0;
  const errores = [];

  for (const digest of digests) {
    const telefono = telefonoPorUserId.get(Number(digest.user_id));

    if (!telefono) {
      sinTelefono++;
      await actualizarDigestAttemptPorDigest(supabase, digest.id, {
        status: 'failed',
        motivoNoEnvio: 'usuario_sin_telefono_envio',
        errorMsg: 'Usuario sin telefono verificable en envio',
      });
      continue;
    }

    const { error: insError } = await supabase.from('mia_outbox').insert({
      user_id: digest.user_id,
      channel: 'whatsapp',
      to_phone: telefono,
      body: digest.mensaje,
      status: 'queued',
      attempts: 0,
      next_attempt_at: ahora().toISOString(),
      organization_id: digest.organization_id || null,
      metadata_json: {
        source: 'digest_diario',
        digest_id: digest.id,
        fecha: digest.fecha,
      },
    });

    if (!insError) {
      encolados++;
    } else if (insError.code === UNIQUE_VIOLATION) {
      yaEncolados++;
    } else {
      errores.push({ digestId: digest.id, error: insError.message });
    }
  }

  return { total: digests.length, encolados, ya_encolados: yaEncolados, sin_telefono: sinTelefono, errores };
}

// Hook post-proceso del drenador de mia_outbox: si el item era un digest,
// refleja el resultado en digests (enviado/error_msg) y en digest_attempts.
// No-op para items que no vienen del digest.
async function procesarResultadoDigestOutbox(supabase, item, resultado) {
  const digestId = digestIdDeOutboxItem(item);
  if (!digestId || !resultado) return { digest: false };

  if (resultado.status === 'sent') {
    await supabase
      .from('digests')
      .update({ enviado: true, enviado_at: new Date().toISOString(), error_msg: null })
      .eq('id', digestId);
    await actualizarDigestAttemptPorDigest(supabase, digestId, {
      status: 'sent',
      motivoNoEnvio: null,
      errorMsg: null,
    });
    return { digest: true, digestId, marcado: 'sent' };
  }

  if (resultado.status === 'failed') {
    await supabase
      .from('digests')
      .update({ error_msg: String(resultado.error || 'fallo_envio_whatsapp').slice(0, 500) })
      .eq('id', digestId);
    // Solo se marca el attempt como failed cuando la cola agota reintentos;
    // mientras queden, el estado del dia sigue siendo "pendiente de envio".
    if (resultado.retryable === false) {
      await actualizarDigestAttemptPorDigest(supabase, digestId, {
        status: 'failed',
        motivoNoEnvio: 'fallo_envio_whatsapp',
        errorMsg: String(resultado.error || '').slice(0, 500),
      });
      return { digest: true, digestId, marcado: 'failed_final' };
    }
    return { digest: true, digestId, marcado: 'failed_retryable' };
  }

  return { digest: true, digestId, marcado: null };
}

module.exports = {
  digestViaOutboxHabilitado,
  digestIdDeOutboxItem,
  encolarDigestsPendientes,
  procesarResultadoDigestOutbox,
};
