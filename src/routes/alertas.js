// src/routes/alertas.js
const { enviarWhatsAppResumen } = require('../whatsapp');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

module.exports = function alertasRoutes(app, supabase) {
  // 1) Crear alerta manual
  app.post('/alertas', async (req, res) => {
    const { titulo, resumen, url, fecha, region } = req.body;

    if (!titulo || !url || !fecha) {
      return res.status(400).json({
        error: 'Faltan campos obligatorios: titulo, url o fecha',
      });
    }

    const resumenFinal = resumen ?? 'Procesando con IA...';

    const { data, error } = await supabase
      .from('alertas')
      .insert([
        {
          titulo,
          resumen: resumenFinal,
          url,
          fecha,
          region,
        },
      ])
      .select();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, alerta: data[0] });
  });

  // 2) Listar alertas
  app.get('/alertas', async (req, res) => {
    const { data, error } = await supabase
      .from('alertas')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ count: data.length, alertas: data });
  });

  // 3) Procesar alertas pendientes con IA (solo resumen, sin WhatsApp)
  const procesarIAHandler = async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: 'Falta OPENAI_API_KEY en variables de entorno',
        });
      }

      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, region, fecha, resumen, contenido')
        .or('resumen.is.null,resumen.eq.Procesando con IA...')
        .order('created_at', { ascending: true })
        .limit(10);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (!alertas || alertas.length === 0) {
        return res.json({
          success: true,
          procesadas: 0,
          mensaje: 'No hay alertas pendientes de resumir',
        });
      }

      const lista = alertas
        .map((a) => {
          const texto = a.contenido ? a.contenido.slice(0, 4000) : '';
          return `ID ${a.id} | Fecha ${a.fecha} | Region ${
            a.region || 'NACIONAL'
          } | Titulo: ${a.titulo} | Texto: ${texto}`;
        })
        .join('\n\n');

      const prompt = `
(… aquí el mismo prompt largo que ya tenías, lo puedes dejar tal cual …)
Lista de alertas:
${lista}
      `.trim();

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
            'Eres un asistente experto en resumir disposiciones del BOE para el sector agrario y ganadero. Responde siempre SOLO con el JSON pedido.',
        }),
      });

      if (!aiRes.ok) {
        const text = await aiRes.text();
        console.error('Error OpenAI:', aiRes.status, text);
        return res.status(500).json({
          error: 'Error al llamar a OpenAI',
          detalle: text,
        });
      }

      const aiJson = await aiRes.json();

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
            const firstContent = item.content[0];
            if (typeof firstContent.text === 'string') {
              contenido = firstContent.text.trim();
              break;
            } else if (typeof firstContent.value === 'string') {
              contenido = firstContent.value.trim();
              break;
            }
          }
        }
      }

      if (!contenido) {
        console.error('Respuesta IA sin contenido de texto:', aiJson);
        return res.status(500).json({
          error: 'La IA no devolvió texto',
          bruto: aiJson,
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(contenido);
      } catch (e) {
        console.error('No se pudo parsear JSON de la IA:', contenido);
        return res.status(500).json({
          error: 'La respuesta de la IA no es JSON válido',
          bruto: contenido,
        });
      }

      const resumenes = parsed.resumenes || [];
      if (!Array.isArray(resumenes) || resumenes.length === 0) {
        return res.status(500).json({
          error: 'La IA no devolvió resumenes válidos',
          bruto: parsed,
        });
      }

      let actualizadas = 0;

      for (const item of resumenes) {
        if (!item.id || !item.resumen) continue;

        const { error: updError } = await supabase
          .from('alertas')
          .update({ resumen: item.resumen })
          .eq('id', item.id);

        if (!updError) {
          actualizadas++;
        } else {
          console.error(
            'Error actualizando alerta',
            item.id,
            updError.message
          );
        }
      }

      res.json({
        success: true,
        procesadas: alertas.length,
        actualizadas,
        ids: resumenes.map((r) => r.id),
      });
    } catch (err) {
      console.error('Error en /alertas/procesar-ia', err);
      res.status(500).json({ error: err.message });
    }
  };

  app.post('/alertas/procesar-ia', procesarIAHandler);
  app.get('/alertas/procesar-ia', procesarIAHandler);

  // 4) NUEVO: enviar WhatsApp de forma manual
  app.post('/alertas/enviar-whatsapp', async (req, res) => {
    try {
      // Cargamos alertas con resumen ya generado,
      // que no sean "Procesando con IA..." ni "NO IMPORTA"
      // y que aún no tengan whatsapp_enviado = true
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select(
          'id, titulo, resumen, region, fecha, url, contenido, whatsapp_enviado'
        )
        .order('created_at', { ascending: true });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const candidatas = (alertas || []).filter((a) => {
        if (a.whatsapp_enviado === true) return false;
        if (!a.resumen) return false;

        const r = String(a.resumen).trim();
        if (r === 'Procesando con IA...') return false;
        if (r.toUpperCase() === 'NO IMPORTA') return false;

        return true;
      });

      if (!candidatas.length) {
        return res.json({
          success: true,
          enviadas: 0,
          mensaje: 'No hay alertas pendientes de enviar por WhatsApp',
        });
      }

      let enviadas = 0;

      for (const alerta of candidatas) {
        await enviarWhatsAppResumen(alerta, supabase);

        const { error: updError } = await supabase
          .from('alertas')
          .update({ whatsapp_enviado: true })
          .eq('id', alerta.id);

        if (!updError) {
          enviadas++;
        } else {
          console.error(
            'Error marcando whatsapp_enviado',
            alerta.id,
            updError.message
          );
        }
      }

      res.json({
        success: true,
        enviadas,
        ids: candidatas.map((a) => a.id),
      });
    } catch (err) {
      console.error('Error en /alertas/enviar-whatsapp', err);
      res.status(500).json({ error: err.message });
    }
  });
};
