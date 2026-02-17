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
          return `ID=${a.id} | Fecha=${a.fecha} | Region=${a.region} | URL=${a.url} | Titulo=${a.titulo} | Texto=${texto}`;
        })
        .join('\n\n');
        
            const prompt = ` 
Te paso una LISTA de alertas del BOE para agricultores y ganaderos, una por línea, con este formato EXACTO:
"ID=<id> | Fecha=<fecha> | Region=<region> | URL=<url> | Titulo=<titulo> | Texto=<contenido>"

TU TAREA:

1) Para CADA alerta, analiza si es RELEVANTE PARA EL SECTOR AGRARIO O GANADERO (importante para agricultores, ganaderos, cooperativas o explotaciones agroganaderas).

✨ UNA ALERTA SERÁ RELEVANTE SOLO SI SE CUMPLE TODO ESTO:

1) Trata específicamente sobre AGRICULTURA, GANADERÍA, REGADÍO o EXPLOTACIONES RURALES.  
2) El texto menciona de forma explícita alguno de estos conceptos o destinatarios:
   - agricultores
   - ganaderos
   - explotaciones agrarias o ganaderas
   - comunidades de regantes, regadíos o infraestructuras de riego
   - titulares de explotaciones
   - cooperativas agrarias
   - sociedades agrarias de transformación (SAT)
   - industrias agroalimentarias ligadas al campo
3) Y además pertenece a una de estas categorías:
   - ayudas o subvenciones AGRARIAS o GANADERAS
   - bases reguladoras o convocatorias para explotaciones agrarias/ganaderas
   - normativa agraria o ganadera
   - agua para riego o ganadería (incluye modernización, infraestructuras, usos colectivos)
   - energía para explotaciones (bombeo, autoconsumo en granjas, regadío)
   - fiscalidad o trámites aplicables solo al sector primario
   - medio ambiente relacionado directamente con el campo (plagas, fertilización, suelos, bienestar animal)

🚫 UNA ALERTA SERÁ "NO IMPORTA" (DESCARTADA) SI:

- Es una ayuda para PYMEs, autónomos, innovación, transformación territorial o despoblación SIN mencionar directamente actividades agrarias o ganaderas.
- Es una subvención generalista o multisectorial donde el sector agrario NO aparece como destinatario explícito.
- Trata de administración general (oposiciones, sanciones, becas, tribunales, concursos, anuncios judiciales).
- Habla de una concesión de agua individual, modificación de riego, cambio de cultivo o superficie que afecta SOLO a un titular concreto.
- Cualquier contenido relacionado con PESCA (siempre NO IMPORTA).
- Nombres, cambios administrativos o trámites que no afectan a la actividad agrícola o ganadera.

⚠️ Regla clave:
SI EL TEXTO NO MENCIONA EXPLÍCITAMENTE AGRICULTURA, GANADERÍA, EXPLOTACIONES, REGADÍO O DESTINATARIOS AGRARIOS → SIEMPRE ES "NO IMPORTA".

---

CLASIFICACIÓN POR ALERTA (solo si es relevante):

"provincias": lista de provincias mencionadas (si se refiere a la comunidad autonoma, poner todas las provincias). Si es estatal o no menciona ninguna → [].

"sectores": elegir obligatoriamente entre: ["ganaderia","agricultura","mixto","otros"].

"subsectores": elegir entre:
["ovino","vacuno","caprino","porcino","avicultura","cunicultura","equinocultura","apicultura",
"trigo","cebada","cereal","maiz","arroz","hortalizas","frutales","olivar","trufas","viñedo",
"almendro","citricos","frutos_secos","leguminosas","patata","forrajes",
"forestal","agua","energia","medio_ambiente"].

"tipos_alerta": elegir obligatoriamente entre:
["ayudas_subvenciones","normativa_general","agua_infraestructuras","fiscalidad","medio_ambiente"].

---

MENSAJE WHATSAPP (solo si ESA alerta es relevante):

EL CAMPO "resumen" DEBE TENER SIEMPRE ESTE FORMATO EXACTO (respetando asteriscos y líneas):

"*Ruralicos te avisa* 🌾🚜

📄 *¿Qué ha pasado?*
<1–3 frases claras explicando la alerta del boletin.>

⚠️ *¿A quién afecta?*
<colectivos afectados. Si no especifica: “El Boletin no indica destinatarios concretos.”>

📌 *Punto clave*
<dato más relevante. Si no hay plazos: “El Boletin no menciona plazos concretos.”>

En esta linea Añade 1–2 emojis finales siempre.

🔗 Enlace al Boletin completo: <url>"

Reglas del mensaje:
- Entre 4–7 frases.
- Lenguaje sencillo.
- Sin inventar datos.
- Mantén EXACTAMENTE los asteriscos y textos fijos de la plantilla.

---

SALIDA ÚNICA:

Debes devolver SIEMPRE un ÚNICO objeto JSON con la forma:

{
  "resumenes": [
    {
      "id": "ID de la alerta 1",
      "fuente": "BOE",
      "resumen": "NO IMPORTA" o "<mensaje WhatsApp completo>",
      "provincias": [ ... ],
      "sectores": [ ... ],
      "subsectores": [ ... ],
      "tipos_alerta": [ ... ]
    },
    {
      "id": "ID de la alerta 2",
      "fuente": "BOE",
      "resumen": "NO IMPORTA" o "<mensaje WhatsApp completo>",
      "provincias": [ ... ],
      "sectores": [ ... ],
      "subsectores": [ ... ],
      "tipos_alerta": [ ... ]
    }
    ...
  ]
}

REGLAS FINALES IMPORTANTES:
- Cada alerta de la lista de entrada debe tener EXACTAMENTE un objeto dentro de "resumenes".
- Si una alerta NO es relevante → "resumen": "NO IMPORTA" y todos los arrays vacíos.
- Si una alerta ES relevante → "resumen": mensaje WhatsApp con el formato indicado y clasificación rellenada.
- El campo "fuente" SIEMPRE debe ser exactamente: "BOE".
- Respeta SIEMPRE los asteriscos y el formato del mensaje WhatsApp.
- NO añadas ningún texto fuera del JSON.
- NO uses valores genéricos como <id> o <url>; usa siempre los reales.

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


