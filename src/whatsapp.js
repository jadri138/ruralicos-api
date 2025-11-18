// whatsapp.js

// UltraMsg config
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;

// URL API UltraMsg (chat message)
const ULTRAMSG_URL = ULTRAMSG_INSTANCE_ID
  ? `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`
  : null;

/**
 * Aquí decides qué usuarios reciben la alerta.
 * Ahora mismo: todos los usuarios activos.
 * En el futuro: filtrado por edad, terreno, tipo de actividad, región, etc.
 */
async function obtenerDestinatariosParaAlerta(alerta, supabase) {
  try {
    // TODO (futuro): usar alerta.region, alerta.fecha, etc. para segmentar.
    const { data, error } = await supabase
      .from('users')
      .select('id, nombre, telefono, activo, edad, region, tipo_actividad, hectareas')
      .eq('activo', true);

    if (error) {
      console.error('Error cargando destinatarios:', error.message);
      return [];
    }

    return (data || []).filter((u) => !!u.telefono);
  } catch (err) {
    console.error('Error inesperado en obtenerDestinatariosParaAlerta:', err);
    return [];
  }
}

/**
 * Envía el resumen de una alerta por WhatsApp a los destinatarios correspondientes.
 * NO envía nada si:
 *   - El resumen está en "Procesando con IA" (cualquier variante).
 *   - El resumen es "NO IMPORTA".
 */
async function enviarWhatsAppResumen(alerta, supabase) {
  try {
    if (!ULTRAMSG_URL || !ULTRAMSG_TOKEN) {
      console.warn(
        '[WhatsApp] Faltan ULTRAMSG_INSTANCE_ID o ULTRAMSG_TOKEN, no se envían mensajes.'
      );
      return;
    }

    if (!alerta || !alerta.resumen) {
      return;
    }

    const resumen = String(alerta.resumen).trim();

    // Evitar enviar mientras está en cola o marcado como irrelevante
    if (
      resumen.toUpperCase() === 'NO IMPORTA' ||
      resumen.startsWith('Procesando con IA...')
    ) {
      console.log(
        `[WhatsApp] Alerta ${alerta.id} no se envía (resumen = "${resumen}").`
      );
      return;
    }

    const destinatarios = await obtenerDestinatariosParaAlerta(alerta, supabase);

    if (!destinatarios.length) {
      console.log(
        `[WhatsApp] No hay destinatarios activos para la alerta ${alerta.id}.`
      );
      return;
    }

    console.log(
      `[WhatsApp] Enviando alerta ${alerta.id} a ${destinatarios.length} destinatarios...`
    );

    for (const user of destinatarios) {
      const telefono = String(user.telefono || '').trim();
      if (!telefono) continue;

      const body = new URLSearchParams();
      body.append('token', ULTRAMSG_TOKEN);
      body.append('to', telefono);
      body.append('body', resumen);

      try {
        const res = await fetch(ULTRAMSG_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        });

        if (!res.ok) {
          const txt = await res.text();
          console.error(
            `[WhatsApp] Error enviando a ${telefono} (status ${res.status}):`,
            txt
          );
        } else {
          const json = await res.json().catch(() => ({}));
          console.log(
            `[WhatsApp] Mensaje enviado a ${telefono}. Respuesta UltraMsg:`,
            json?.id || json
          );
        }
      } catch (err) {
        console.error(
          `[WhatsApp] Error de red enviando a ${telefono}:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error('[WhatsApp] Error general en enviarWhatsAppResumen:', err);
  }
}

module.exports = {
  enviarWhatsAppResumen,
};
