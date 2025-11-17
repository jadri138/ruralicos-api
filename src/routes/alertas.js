// src/routes/alertas.js

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

module.exports = function alertasRoutes(app, supabase) {
  // Insertar alerta manualmente
  app.post('/alertas', async (req, res) => {
    const { titulo, resumen, url, fecha, region } = req.body;

    if (!titulo || !url || !fecha) {
      return res.status(400).json({
        error: 'Faltan campos obligatorios: titulo, url o fecha',
      });
    }

    // Si no envías resumen, lo marcamos como pendiente de IA
    const resumenFinal = resumen ?? 'Procesando con IA.';

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

  // Listar alertas (todas)
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

  // ---- Procesar alertas pendientes con IA (handler reutilizable) ----
  const procesarIAHandler = async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: 'Falta OPENAI_API_KEY en variables de entorno',
        });
      }

      // 1) Alertas con resumen pendiente (máx 10)
      //    - resumen NULL
      //    - o resumen = 'Procesando con IA.'
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, region, fecha, resumen')
        .or('resumen.is.null,resumen.eq.Procesando con IA.')
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

      // Montamos la lista para el prompt
      const lista = alertas
        .map(
          (a) =>
            `ID ${a.id} | Fecha ${a.fecha} | Region ${a.region || 'NACIONAL'} | Titulo: ${a.titulo}`
        )
        .join('\n');

      const prompt = `
Te paso una lista de alertas del BOE para agricultores y ganaderos, una por línea, con este formato:
"ID <id> | Fecha <fecha> | Region <region> | Titulo: <titulo>"

TU TAREA:
- Para cada alerta, escribe un resumen corto, claro y útil para enviar por WhatsApp.
- No inventes detalles que no estén en el título.
- Máximo 3 frases por resumen.
- Escribe en español sencillo.

Devuélveme SOLO un JSON con este formato EXACTO:

{
  "resumenes": [
    {
      "id": <id>,
      "resumen": "<texto corto para WhatsApp>"
    }
  ]
}

Lista de alertas:
${lista}
      `.trim();

      // 2) Llamada a la API nueva de OpenAI: /v1/responses con gpt-5-nano
      const aiRes = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-5-nano',
          input: prompt, // texto entero
          instructions:
            'Eres un asistente experto en resumir disposiciones del BOE para el sector agrario. Responde SIEMPRE solo con JSON válido según el esquema indicado.',
          temperature: 0.2,
          response_format: {
            type: 'json_object', // forzamos JSON
          },
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

      // 3) Sacar el texto JSON de la respuesta de la Responses API
      let contenido = '';

      // Algunos clientes exponen output_text, por si acaso
      if (typeof aiJson.output_text === 'string') {
        contenido = aiJson.output_text;
      } else if (Array.isArray(aiJson.output) && aiJson.output.length > 0) {
        const firstOutput = aiJson.output[0];
        if (
          firstOutput &&
          Array.isArray(firstOutput.content) &&
          firstOutput.content.length > 0
        ) {
          const firstContent = firstOutput.content[0];
          if (typeof firstContent.text === 'string') {
            contenido = firstContent.text;
          } else if (typeof firstContent.value === 'string') {
            contenido = firstContent.value;
          }
        }
      }

      contenido = (contenido || '').trim();

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

      // 4) Actualizar en BD
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

  // Acepta POST y GET para que no dé "Not Found"
  app.post('/alertas/procesar-ia', procesarIAHandler);
  app.get('/alertas/procesar-ia', procesarIAHandler);
};
