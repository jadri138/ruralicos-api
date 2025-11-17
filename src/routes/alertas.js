// src/routes/alertas.js

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

module.exports = function alertasRoutes(app, supabase) {
  // Insertar alerta manualmente
  app.post('/alertas', async (req, res) => {
    const { titulo, resumen, url, fecha, region } = req.body;

    if (!titulo || !url || !fecha) {
      return res.status(400).json({
        error: 'Faltan campos obligatorios: titulo, url o fecha'
      });
    }

    const { data, error } = await supabase
      .from('alertas')
      .insert([{ titulo, resumen, url, fecha, region }])
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

  // Procesar alertas pendientes con IA (resumen corto)
  app.post('/alertas/procesar-ia', async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: 'Falta OPENAI_API_KEY en variables de entorno'
        });
      }

      // 1) Coger alertas con resumen pendiente (máx 10 cada vez)
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, region, fecha, resumen')
        .eq('resumen', 'Procesando con IA...')
        .order('created_at', { ascending: true })
        .limit(10);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (!alertas || alertas.length === 0) {
        return res.json({
          success: true,
          procesadas: 0,
          mensaje: 'No hay alertas pendientes de resumir'
        });
      }

      // 2) Montar texto para la IA
      const lista = alertas
        .map(
          (a) =>
            `ID ${a.id} | Fecha ${a.fecha} | Region ${a.region || 'NACIONAL'} | Titulo: ${a.titulo}`
        )
        .join('\n');

      const prompt = `
Eres un asistente que resume disposiciones del BOE para agricultores y ganaderos.

Te paso una lista de alertas, una por línea, con este formato:
"ID <id> | Fecha <fecha> | Region <region> | Titulo: <titulo>"

TU TAREA:
- Para cada alerta, decide un resumen corto, claro y útil para enviar por WhatsApp.
- No te inventes cosas que no estén en el título.
- Usa un lenguaje sencillo, pensando en agricultores y ganaderos.
- Máximo 3 frases por resumen.

Devuélveme SOLO un JSON con este formato EXACTO:

{
  "resumenes": [
    {
      "id": <id>,
      "resumen": "<texto corto para WhatsApp>"
    },
    ...
  ]
}

Lista de alertas:
${lista}
      `.trim();

      // 3) Llamada a OpenAI (chat completions clásico, modelo ligero)
      const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Eres un asistente experto en BOE rural.' },
            { role: 'user', content: prompt }
          ]
        })
      });

      if (!aiRes.ok) {
        const text = await aiRes.text();
        console.error('Error OpenAI:', aiRes.status, text);
        return res.status(500).json({
          error: 'Error al llamar a OpenAI',
          detalle: text
        });
      }

      const aiJson = await aiRes.json();
      const contenido =
        aiJson.choices?.[0]?.message?.content?.trim() || '';

      let parsed;
      try {
        parsed = JSON.parse(contenido);
      } catch (e) {
        console.error('No se pudo parsear JSON de la IA:', contenido);
        return res.status(500).json({
          error: 'La respuesta de la IA no es JSON válido',
          bruto: contenido
        });
      }

      const resumenes = parsed.resumenes || [];
      if (!Array.isArray(resumenes) || resumenes.length === 0) {
        return res.status(500).json({
          error: 'La IA no devolvió resumenes válidos',
          bruto: parsed
        });
      }

      // 4) Actualizar cada alerta en Supabase
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
          console.error('Error actualizando alerta', item.id, updError.message);
        }
      }

      res.json({
        success: true,
        procesadas: alertas.length,
        actualizadas,
        ids: resumenes.map((r) => r.id)
      });
    } catch (err) {
      console.error('Error en /alertas/procesar-ia', err);
      res.status(500).json({ error: err.message });
    }
  });
};
