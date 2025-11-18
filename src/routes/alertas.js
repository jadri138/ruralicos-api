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

  // 3) Procesar alertas pendientes con IA y mandar WhatsApp
  const procesarIAHandler = async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: 'Falta OPENAI_API_KEY en variables de entorno',
        });
      }

      // 3.1 Cargar alertas pendientes (resumen null o "Procesando con IA...")
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

      // 3.2 Construir prompt
      const lista = alertas
        .map((a) => {
          const texto = a.contenido ? a.contenido.slice(0, 4000) : '';
          return `ID ${a.id} | Fecha ${a.fecha} | Region ${
            a.region || 'NACIONAL'
          } | Titulo: ${a.titulo} | Texto: ${texto}`;
        })
        .join('\n\n');

      const prompt = `
Te paso una lista de alertas del BOE para agricultores y ganaderos, una por línea, con este formato:
"ID <id> | Fecha <fecha> | Region <region> | Titulo: <titulo> | Texto: <contenido>"

TU TAREA:
Analiza el contenido del BOE que aparece en "Texto:" y decide si es RELEVANTE o NO para agricultores, ganaderos, cooperativas agrarias, autónomos rurales, ayuntamientos pequeños o explotaciones agroganaderas.

RELEVANCIA:
- RELEVANTE si habla para la comunidad agraria y ganadera sobre: ayudas, subvenciones, bases reguladoras, convocatorias, resoluciones que afecten a explotaciones, normativa agraria/ganadera, medio ambiente, agua para uso agrario, energía rural, infraestructuras rurales, fiscalidad o trámites que afecten al sector primario.
- NO RELEVANTE si es algo administrativo general: oposiciones, sanciones ajenas al sector primario, becas, movimientos internos del Estado, tribunales, correcciones de errores sin impacto, energía no rural, transportes no rurales, urbanismo puro, concursos de méritos, anuncios que no afecten al medio rural.

SI NO ES RELEVANTE:
Devuelve EXACTAMENTE este JSON:
{
  "resumenes": [
    {
      "id": <id>,
      "resumen": "NO IMPORTA"
    }
  ]
}

SI ES RELEVANTE:
Genera un mensaje estilo WhatsApp con esta estructura EXACTA:

*Ruralicos te avisa* 🌾🚜

*📄 ¿Qué ha pasado?*
Explica en 1–3 frases qué dice el BOE, con lenguaje sencillo.

*⚠️ ¿A quién afecta?*
Quién podría verse afectado (agricultores, ganaderos, ayuntamientos, cooperativas).
Si no se especifica: “El BOE no indica destinatarios concretos.”

*📌 Punto clave*
Detalle más importante (si se aprueba, se modifica, se deniega, plazos si aparecen).
Si NO hay plazos: “El BOE no menciona plazos concretos.”

Al final del mensaje pon 1–2 emojis: 🌾📢⚠️🚜📄

REGLAS:
- Entre 4 y 7 frases.
- Lenguaje claro y sencillo.
- Formato WhatsApp con saltos de línea.
- Títulos y subtítulos SIEMPRE en **negrita**.
- No inventes fechas, importes ni plazos.
- No añadas nada fuera del mensaje.

FORMATO DE SALIDA:
Devuelve SOLO este JSON válido:

{
  "resumenes": [
    {
      "id": <id>,
      "resumen": "<mensaje WhatsApp completo>"
    }
  ]
}

Nada de texto antes o después, solo el JSON.

Lista de alertas:
${lista}
      `.trim();

      // 3.3 Llamar a OpenAI /v1/responses
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

      // 3.4 Extraer texto de la respuesta
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

      // 3.5 Actualizar BD y disparar WhatsApp
      let actualizadas = 0;

      for (const item of resumenes) {
        if (!item.id || !item.resumen) continue;

        const { error: updError } = await supabase
          .from('alertas')
          .update({ resumen: item.resumen })
          .eq('id', item.id);

        if (!updError) {
          actualizadas++;

          const alertaOriginal = alertas.find((a) => a.id === item.id);
          const alertaParaWhatsApp = {
            ...alertaOriginal,
            resumen: item.resumen,
          };

          await enviarWhatsAppResumen(alertaParaWhatsApp, supabase);
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

  // Endpoints para lanzar el procesado
  app.post('/alertas/procesar-ia', procesarIAHandler);
  app.get('/alertas/procesar-ia', procesarIAHandler);
};
