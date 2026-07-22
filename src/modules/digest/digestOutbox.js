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
const FINAL_SEND_GATE_VERSION = 'final_send_gate_v1';

function digestViaOutboxHabilitado(env = process.env) {
  return String(env.DIGEST_VIA_OUTBOX || 'false').toLowerCase() === 'true';
}

function digestIdDeOutboxItem(item) {
  const raw = item?.metadata_json?.digest_id;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function evaluarDigestItemsParaEnvio(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return { allowed: false, reason: 'digest_items_missing' };
  }

  for (const item of items) {
    const tags = item?.tags_json && typeof item.tags_json === 'object' ? item.tags_json : {};
    const selection = item?.selection_decision && typeof item.selection_decision === 'object'
      ? item.selection_decision
      : (tags.selection_decision || tags.decision_digest || {});
    const finalValidation = tags.final_validation_decision || tags.contexto_mia_digest?.final_validation || {};
    const effectiveDecision = tags.effective_send_decision;
    const gateVersion = tags.effective_gate_version;

    if ((selection.action || item.selection_action) !== 'include') {
      return { allowed: false, reason: 'selection_decision_not_include', alerta_id: item.alerta_id || null };
    }
    if (finalValidation.status !== 'send') {
      return {
        allowed: false,
        reason: `final_validation_${finalValidation.status || 'missing'}`,
        alerta_id: item.alerta_id || null,
      };
    }
    if (
      effectiveDecision !== 'send'
      || tags.automatic_send_allowed !== true
      || gateVersion !== FINAL_SEND_GATE_VERSION
    ) {
      return { allowed: false, reason: 'effective_send_gate_invalid', alerta_id: item.alerta_id || null };
    }
  }

  return { allowed: true, reason: 'automatic_send_allowed', items: items.length };
}

async function filtrarDigestsPorAutoridadFinal(supabase, digests = []) {
  if (!Array.isArray(digests) || digests.length === 0) {
    return { enviables: [], bloqueados: [] };
  }

  const digestIds = digests.map((digest) => digest.id).filter(Boolean);
  const { data: items, error } = await supabase
    .from('digest_items')
    .select('digest_id, alerta_id, selection_action, selection_decision, tags_json')
    .in('digest_id', digestIds);
  if (error) throw error;

  const itemsByDigest = new Map();
  for (const item of items || []) {
    const key = String(item.digest_id);
    if (!itemsByDigest.has(key)) itemsByDigest.set(key, []);
    itemsByDigest.get(key).push(item);
  }

  const enviables = [];
  const bloqueados = [];
  for (const digest of digests) {
    const decision = evaluarDigestItemsParaEnvio(itemsByDigest.get(String(digest.id)) || []);
    if (decision.allowed) enviables.push(digest);
    else bloqueados.push({ digest, ...decision });
  }
  return { enviables, bloqueados };
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
    return { total: 0, encolados: 0, ya_encolados: 0, sin_telefono: 0, bloqueados_validacion_final: 0, errores: [] };
  }

  const finalAuthority = await filtrarDigestsPorAutoridadFinal(supabase, digests);
  for (const blocked of finalAuthority.bloqueados) {
    await actualizarDigestAttemptPorDigest(supabase, blocked.digest.id, {
      status: 'no_send',
      motivoNoEnvio: blocked.reason,
      errorMsg: null,
    });
  }
  const digestsEnviables = finalAuthority.enviables;
  if (digestsEnviables.length === 0) {
    return {
      total: digests.length,
      encolados: 0,
      ya_encolados: 0,
      sin_telefono: 0,
      bloqueados_validacion_final: finalAuthority.bloqueados.length,
      errores: [],
    };
  }

  const userIds = digestsEnviables.map((d) => d.user_id);
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

  for (const digest of digestsEnviables) {
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

  return {
    total: digests.length,
    encolados,
    ya_encolados: yaEncolados,
    sin_telefono: sinTelefono,
    bloqueados_validacion_final: finalAuthority.bloqueados.length,
    errores,
  };
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
  evaluarDigestItemsParaEnvio,
  filtrarDigestsPorAutoridadFinal,
  encolarDigestsPendientes,
  procesarResultadoDigestOutbox,
};
