// src/routes/alertasFree.js

const { checkCronToken } = require('../utils/checkCronToken');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const { enviarWhatsAppFree } = require('../whatsapp');

module.exports = function alertasFreeRoutes(app, supabase) {
  // ================================================
  // 1) Generar resumen FREE general a partir de resumen (PRO)
  // ================================================
  const generarResumenFreeHandler = async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: 'Falta OPENAI_API_KEY en variables de entorno',
        });
      }

      const hoy = new Date().toISOString().slice(0, 10);

      // Alertas de HOY ya filtradas por la IA PRO (resumen listo y relevante)
      const { data: alertas, error } = await supabase
  
      .from('alertas')
        .select('id, titulo, resumen, url, fecha, resumenfree')
        .eq('fecha', hoy)
        .neq('resumen', 'NO IMPORTA')
        .neq('resumen', 'Procesando con IA...');
        // sin .or → generamos/actualizamos resumenfree siempre


      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (!alertas || alertas.length === 0) {
        return res.json({
          success: true,
          procesadas: 0,
          mensaje:
            'No hay alertas con resumen PRO hoy pendientes de generar resumen FREE',
          fecha: hoy,
        });
      }

      // Construir lista para el prompt usando el RESUMEN ya generado
      const lista = alertas
        .map((a) => {
          const corto = (a.resumen || '').slice(0, 400);
          return `ID ${a.id} | Titulo: ${a.titulo} | ResumenPro: ${corto} | Url: ${a.url}`;
        })
        .join('\n');

      const prompt = `
Te paso una lista de alertas del BOE ya analizadas y resumidas para usuarios PRO.

Cada línea tiene:
ID <id> | Titulo: <titulo> | ResumenPro: <resumen corto> | Url: <url>

TU TAREA:
Genera UN ÚNICO mensaje de WhatsApp para usuarios GRATUITOS de Ruralicos (versión FREE).

Formato EXACTO:

*RURALICOS INFORMA* · Resumen BOE de hoy (agricultura y ganadería)

1 frase introductoria.

Luego, una lista numerada:
*1)* mini resumen muy claro (basado en ResumenPro) → BOE: <url>
*2)* ...
*3)* ...

- NO inventes información.
- NO pongas emojis.
- Usa frases cortas y muy sencillas para agricultores y ganaderos.
- Si hay muchas alertas, agrúpalas por temas (ayudas, normativa, plazos, etc.) pero mantén el formato numerado.
- Termina SIEMPRE con esta frase literal:
*Alertas más extensas y personalizadas en la versión PRO.*

FORMATO DE SALIDA OBLIGATORIO:
Devuelve SOLO este JSON válido:

{
  "mensaje": "<mensaje final>"
}

Nada de texto fuera del JSON.

Lista de alertas:
${lista}
      `.trim();

      // Llamada a OpenAI (igual que en alertas.js)
      const aiRes = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-5-nano',
          input: prompt,
          instructions:
            'Eres un asistente experto en resumir información compleja en mensajes de WhatsApp muy claros. Responde SIEMPRE solo con el JSON pedido.',
        }),
      });

      if (!aiRes.ok) {
        const txt = await aiRes.text();
        console.error('Error IA FREE:', aiRes.status, txt);
        return res.status(500).json({
          error: 'Error OpenAI en resumen FREE',
          detalle: txt,
        });
      }

      const aiJson = await aiRes.json();

      // Extraer texto, igual patrón que en alertas.js
      let contenido = '';

      if (typeof aiJson.output_text === 'string' && aiJson.output_text.trim()) {
        contenido = aiJson.output_text.trim();
      } else if (Array.isArray(aiJson.output)) {
        for (const item of aiJson.output) {
          if (
            item &&
            item.type === 'message' &&
            Array.isArray(item.content) &&
            item.content.length > 0
          ) {
            const c = item.content[0];
            if (typeof c.text === 'string') contenido = c.text.trim();
            else if (typeof c.value === 'string')
              contenido = c.value.trim();
            break;
          }
        }
      }

      if (!contenido) {
        return res.status(500).json({
          error: 'La IA FREE no devolvió texto',
          bruto: aiJson,
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(contenido);
      } catch (e) {
        console.error('JSON FREE inválido:', contenido);
        return res.status(500).json({
          error: 'El JSON generado por la IA FREE no es válido',
          bruto: contenido,
        });
      }

      if (!parsed.mensaje || typeof parsed.mensaje !== 'string') {
        return res.status(500).json({
          error: "La IA FREE no devolvió la clave 'mensaje'",
          bruto: parsed,
        });
      }

      const resumenFree = parsed.mensaje.trim();

      // Guardar resumenFree en TODAS las alertas de hoy usadas en la lista
      let actualizadas = 0;
      for (const a of alertas) {
        const { error: updError } = await supabase
          .from('alertas')
          .update({ resumenfree: resumenFree })
          .eq('id', a.id);

        if (!updError) {
          actualizadas++;
        } else {
          console.error(
            'Error actualizando resumenfree en alerta',
            a.id,
            updError.message
          );
        }
      }

      return res.json({
        success: true,
        fecha: hoy,
        procesadas: alertas.length,
        actualizadas,
        resumenfree,
      });
    } catch (err) {
      console.error('Error en /alertas/generar-resumen-free', err);
      return res.status(500).json({ error: err.message });
    }
  };

  // Rutas para generar resumen FREE (POST normal y GET con token para cron)
  app.post('/alertas/generar-resumen-free', generarResumenFreeHandler);
  app.get('/alertas/generar-resumen-free', (req, res) => {
    if (!checkCronToken(req, res)) return;
    generarResumenFreeHandler(req, res);
  });

  // ============================================================
  // 2) Enviar el RESUMEN FREE por WhatsApp a usuarios FREE
  // ============================================================
  const enviarResumenFreeHandler = async (req, res) => {
    try {
      const hoy = new Date().toISOString().slice(0, 10);

      // Una alerta de hoy que tenga resumenfree
      const { data, error } = await supabase
        .from("alertas")
        .select("id, resumenfree")
        .eq("fecha", hoy)
        .not("resumenfree", "is", null)
        .or('whatsapp_enviado_free.is.null,whatsapp_enviado_free.eq.false')
        .limit(1);


      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (!data || data.length === 0 || !data[0].resumenfree) {
        return res.status(404).json({
          error:
            'No hay resumenfree generado hoy. Ejecuta antes /alertas/generar-resumen-free',
        });
      }

      const mensajeFree = data[0].resumenfree;

      await enviarWhatsAppFree(supabase, mensajeFree);

      await supabase
       .from("alertas")
       .update({ whatsapp_enviado_free: true })
       .eq("fecha", hoy);

      return res.json({
        ok: true,
        fecha: hoy,
        mensaje: 'Resumen FREE enviado por WhatsApp a usuarios FREE',
      });
    } catch (e) {
      console.error('Error enviar-resumen-free:', e);
      return res.status(500).json({ error: 'Error interno enviando FREE' });
    }
  };

  app.post('/alertas/enviar-resumen-free', enviarResumenFreeHandler);
  app.get('/alertas/enviar-resumen-free', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarResumenFreeHandler(req, res);
  });
};
