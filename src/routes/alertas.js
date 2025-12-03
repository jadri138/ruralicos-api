// src/routes/alertas.js
const { checkCronToken } = require('../utils/checkCronToken');
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

      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, region, fecha, resumen, contenido')
        .or('resumen.is.null,resumen.eq.Procesando con IA...')
        .order('created_at', { ascending: true })
        .limit(1);

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
          return `ID ${a.id} | Fecha ${a.fecha} | Region ${a.region} | URL ${a.url} | Titulo: ${a.titulo} | Texto: ${texto}`;
        })
        .join('\n\n');

            const prompt = `
Te paso una lista de alertas del BOE para agricultores y ganaderos, una por línea, con este formato:
"ID <id> | Fecha <fecha> | Region <region> | URL <url> | Titulo: <titulo> | Texto: <contenido>"

TU TAREA:
1) Analiza el contenido del BOE que aparece en "Texto:" y decide si es RELEVANTE o NO para:
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

2) CLASIFICACIÓN POR PROVINCIA Y TIPO:
Para cada alerta RELEVANTE, además debes clasificarla así:

- "provincias": lista de provincias españolas afectadas, por ejemplo ["Huesca","Zaragoza"].
  Si es algo de ámbito estatal y el texto no menciona provincias concretas, usa [] (array vacío).

- "sectores": lista con una o varias de estas palabras:
  ["ganaderia","agricultura","mixto","otros"].

- "subsectores": lista de palabras MÁS concretas, escogidas de aquí:
  ["ovino","vacuno","caprino","porcino","avicultura","cunicultura",
  "equinocultura","apicultura","trigo","cebada","cereal","maiz","hortalizas","frutales","olivar",
   "viñedo","forrajes","forestal","agua","energia","medio_ambiente"].

- "tipos_alerta": lista de uno o varios de estos tipos:
  ["ayudas_subvenciones","normativa_general","agua_infraestructuras",
   "fiscalidad","medio_ambiente"].

3) MENSAJE WHATSAPP (solo si es RELEVANTE):
Genera un mensaje estilo WhatsApp con esta estructura EXACTA:

IMPORTANTE: NO consideres RELEVANTES las concesiones de agua individuales, modificaciones de riego de explotaciones particulares, cambios de superficie, cambios de cultivo o renovaciones de pozos cuando solo afectan a un titular concreto. 
Esos casos deben devolverse como "NO IMPORTA".
Solo considera relevantes asuntos de impacto general: ayudas, normativa, convocatorias, obras públicas, planes hidrológicos o disposiciones que afecten a un conjunto amplio de agricultores/ganaderos.


*Ruralicos te avisa* 🌾🚜

*📄 ¿Qué ha pasado?*
1–3 frases explicando qué dice el BOE, con lenguaje sencillo.

*⚠️ ¿A quién afecta?*
Quién podría verse afectado (agricultores, ganaderos, ayuntamientos, cooperativas, etc.).
Si el BOE no especifica, escribe: “El BOE no indica destinatarios concretos.”

*📌 Punto clave*
Detalle más importante (si se aprueba, se modifica, se deniega algo, plazos si aparecen).
Si NO hay plazos, escribe: “El BOE no menciona plazos concretos.”

Al final del mensaje añade 1–2 emojis (por ejemplo: 🌾📢⚠️🚜📄🐖🐷🐑🐓).

Al final del mensaje añade SIEMPRE esta línea:
🔗 *Enlace al BOE completo:* <url>

donde <url> es exactamente el valor de la propiedad "URL" de esa alerta.
NO inventes URLs.

REGLAS DE ESTILO:
- Entre 4 y 7 frases en total.
- Lenguaje claro y sencillo, sin tecnicismos.
- Formato WhatsApp con saltos de línea.
- Títulos y subtítulos SIEMPRE en *negrita*.
- No inventes fechas, importes ni plazos.
- No añadas nada fuera del mensaje.

SI UNA ALERTA NO ES RELEVANTE:
Devuelve EXACTAMENTE este JSON (sin texto extra):

{
  "resumenes": [
    {
      "id": <id>,
      "resumen": "NO IMPORTA",
      "provincias": [],
      "sectores": [],
      "subsectores": [],
      "tipos_alerta": []
    }
  ]
}

SI UNA ALERTA ES RELEVANTE:
Devuelve EXACTAMENTE este JSON (sin texto extra):

{
  "resumenes": [
    {
      "id": <id>,
      "resumen": "<mensaje WhatsApp completo con negritas, subtítulos y emojis>",
      "provincias": [...],
      "sectores": [...],
      "subsectores": [...],
      "tipos_alerta": [...]
    }
  ]
}

Nada de texto antes o después, solo el JSON.

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

            // 3.5) Actualizar en BD cada alerta con su resumen y clasificación
      let actualizadas = 0;

      for (const item of resumenes) {
        if (!item.id || !item.resumen) continue;

        const updateData = { resumen: item.resumen };

        if (Array.isArray(item.provincias)) {
          updateData.provincias = item.provincias;
        }
        if (Array.isArray(item.sectores)) {
          updateData.sectores = item.sectores;
        }
        if (Array.isArray(item.subsectores)) {
          updateData.subsectores = item.subsectores;
        }
        if (Array.isArray(item.tipos_alerta)) {
          updateData.tipos_alerta = item.tipos_alerta;
        }

        const { error: updError } = await supabase
          .from('alertas')
          .update(updateData)
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

  app.get('/alertas/procesar-ia', (req, res) => {
    if (!checkCronToken(req, res)) return;
    procesarIAHandler(req, res);
  });

  // =========================================
  // 5) Enviar alertas de hoy por WhatsApp
  // =========================================
  const enviarWhatsAppHandler = async (req, res) => {
    try {
      const hoy = new Date().toISOString().slice(0, 10);

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
          await enviarWhatsAppResumen(alerta, supabase);

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
  app.get('/alertas/enviar-whatsapp', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarWhatsAppHandler(req, res);
  });

  app.post('/alertas/enviar-whatsapp', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarWhatsAppHandler(req, res);
  });
};


