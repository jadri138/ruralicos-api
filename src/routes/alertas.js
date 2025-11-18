// src/routes/alertas.js

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const { enviarWhatsAppResumen } = require('../whatsapp');

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

    // Lo que se ve en la BD antes de que la IA lo procese
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

      // 3.2) Construir texto para el prompt
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
Analiza el contenido del BOE que aparece en "Texto:" y decide si es RELEVANTE o NO para:
- agricultores
- ganaderos
- cooperativas agrarias
- autónomos rurales
- ayuntamientos pequeños
- explotaciones agroganaderas.

RELEVANTE si:
- Trata sobre ayudas, subvenciones, bases reguladoras, convocatorias, resoluciones que afecten a explotaciones.
- Normativa agraria o ganadera, medio ambiente ligado al campo, agua para riego o ganadería, energía en entornos rurales, infraestructuras rurales, fiscalidad o trámites que afecten al sector primario.

NO RELEVANTE si:
- Es pura administración general (oposiciones, sanciones no ligadas al sector, becas genéricas, movimientos internos del Estado, tribunales, concursos de méritos, etc.) sin impacto claro en el medio rural o el sector agrario/ganadero.

SI UNA ALERTA NO ES RELEVANTE:
Devuelve EXACTAMENTE este JSON (sin texto extra):

{
  "resumenes": [
    {
      "id": <id>,
      "resumen": "NO IMPORTA"
    }
  ]
}

SI UNA ALERTA ES RELEVANTE:
Genera un mensaje estilo WhatsApp con esta estructura EXACTA:

*Ruralicos te avisa* 🌾🚜

*📄 ¿Qué ha pasado?*
1–3 frases explicando qué dice el BOE, con lenguaje sencillo.

*⚠️ ¿A quién afecta?*
Quién podría verse afectado (agricultores, ganaderos, ayuntamientos, cooperativas, etc.).
Si el BOE no especifica, escribe: “El BOE no indica destinatarios concretos.”

*📌 Punto clave*
Detalle más importante (si se aprueba, se modifica, se deniega algo, plazos si aparecen).
Si NO hay plazos, escribe: “El BOE no menciona plazos concretos.”

Al final del mensaje añade 1–2 emojis (por ejemplo: 🌾📢⚠️🚜📄).

REGLAS DE ESTILO:
- Entre 4 y 7 frases en total.
- Lenguaje claro y sencillo, sin tecnicismos.
- Formato WhatsApp con saltos de línea.
- Títulos y subtítulos SIEMPRE en **negrita**.
- No inventes fechas, importes ni plazos.
- No añadas nada fuera del mensaje.

FORMATO OBLIGATORIO DE SALIDA:
Devuelve SOLO este JSON válido:

{
  "resumenes": [
    {
      "id": <id>,
      "resumen": "<mensaje WhatsApp completo con negritas, subtítulos y emojis>"
    }
  ]
}

Nada de texto antes o después, solo el JSON.

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

      // 3.4) Extraer el texto de la respuesta
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

  // 4) Rutas para lanzar el procesado con IA
  app.post('/alertas/procesar-ia', procesarIAHandler);
  app.get('/alertas/procesar-ia', procesarIAHandler);

  // =========================================
  // 5) Enviar alertas de hoy por WhatsApp
  // =========================================
  const enviarWhatsAppHandler = async (req, res) => {
    try {
      // Fecha de hoy en formato YYYY-MM-DD
      const hoy = new Date().toISOString().slice(0, 10);

      // Alertas que queremos enviar:
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('*')
        .eq('fecha', hoy)
        .neq('resumen', 'NO IMPORTA')
        .neq('resumen', 'Procesando con IA...')
        .or('whatsapp_enviado.is.null,whatsapp_enviado.eq.false');

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (!alertas || alertas.length === 0) {
        return res.json({
          success: true,
          enviadas: 0,
          mensaje: 'No hay alertas nuevas para enviar hoy',
          fecha: hoy,
        });
      }

      let enviadas = 0;
      const errores = [];

      for (const alerta of alertas) {
        try {
          // Envía la alerta a todos los usuarios activos (whatsapp.js)
          await enviarWhatsAppResumen(alerta, supabase);

          // Marca en la tabla que ya se ha enviado por WhatsApp
          await supabase
            .from('alertas')
            .update({ whatsapp_enviado: true })
            .eq('id', alerta.id);

          enviadas++;
        } catch (err) {
          console.error(
            'Error enviando WhatsApp para alerta',
            alerta.id,
            err
          );
          errores.push({ id: alerta.id, error: err.message });
        }
      }

      res.json({
        success: true,
        fecha: hoy,
        total: alertas.length,
        enviadas,
        errores,
      });
    } catch (err) {
      console.error('Error en /alertas/enviar-whatsapp', err);
      res.status(500).json({ error: err.message });
    }
  };

  // 6) Rutas para enviar WhatsApp
  app.get('/alertas/enviar-whatsapp', enviarWhatsAppHandler);
  app.post('/alertas/enviar-whatsapp', enviarWhatsAppHandler);
};
