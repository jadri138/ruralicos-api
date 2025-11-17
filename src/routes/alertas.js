// src/routes/alertas.js

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

module.exports = function alertasRoutes(app, supabase) {
  // ==========================
  // 1) Insertar alerta manual
  // ==========================
  app.post('/alertas', async (req, res) => {
    const { titulo, resumen, url, fecha, region } = req.body;

    if (!titulo || !url || !fecha) {
      return res.status(400).json({
        error: 'Faltan campos obligatorios: titulo, url o fecha',
      });
    }

    // Si no envías resumen, la marcamos como pendiente de IA
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

  // ==========================
  // 2) Listar todas las alertas
  // ==========================
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

  // =========================================
  // 3) Procesar alertas pendientes con la IA
  // =========================================
  const procesarIAHandler = async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: 'Falta OPENAI_API_KEY en variables de entorno',
        });
      }

      // 3.1) Cargar alertas pendientes (máx 10)
      //     - resumen = NULL
      //     - o resumen = 'Procesando con IA...'
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, region, fecha, resumen')
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

      // 3.2) Construir texto para el prompt
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
- IMPORTANTE: responde ÚNICAMENTE en formato JSON válido con la estructura indicada.

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

      // 3.3) Llamar a la API nueva de OpenAI: /v1/responses
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
            'Eres un asistente experto en resumir disposiciones del BOE para el sector agrario. Devuelve SIEMPRE solo JSON válido con la clave "resumenes".',
          temperature: 0.2,
          text: {
            // JSON mode en Responses API
            format: { type: 'json_object' },
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

      // 3.4) Extraer el texto JSON de la respuesta
      let contenido = '';

      if (Array.isArray(aiJson.output) && aiJson.output.length > 0) {
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

      // 3.5) Actualizar en BD cada alerta con su resumen
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
            item
