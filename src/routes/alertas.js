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
Te paso una LISTA de alertas de boletines oficiales, una por línea, con este formato EXACTO:
"ID=<id> | Fecha=<fecha> | Fuente=<fuente> | Region=<region> | URL=<url> | Titulo=<titulo> | Texto=<contenido>"

TU TAREA:

1) Para CADA alerta, analiza si es RELEVANTE PARA EL SECTOR AGRARIO O GANADERO.
Debe ser información realmente útil para agricultores, ganaderos, cooperativas, comunidades de regantes, industrias agroalimentarias o explotaciones rurales.

Una alerta será RELEVANTE si cumple al menos UNA de estas dos vías:

────────────────────────────
VÍA A — AGRARIO EXPLÍCITO
────────────────────────────
El texto menciona claramente:
- agricultores
- ganaderos
- explotaciones agrarias o ganaderas
- comunidades de regantes
- regadíos o infraestructuras de riego
- titulares de explotaciones
- cooperativas agrarias
- sociedades agrarias de transformación (SAT)
- industria agroalimentaria ligada al sector primario

────────────────────────────
VÍA B — AGRARIO IMPLÍCITO PERO EVIDENTE
────────────────────────────
Aunque no mencione literalmente "agricultores" o "ganaderos", el contenido trata claramente sobre:

- PAC, FEGA, Solicitud Única, SIGPAC
- sanidad animal, movimientos de animales, bienestar animal
- plagas, fitosanitarios, fertilización, cuaderno de campo
- modernización de regadíos, balsas, infraestructuras agrarias
- ayudas al sector agroalimentario
- vitivinicultura, olivar, frutales, cereal, ganadería específica
- licitaciones de obras rurales o agrarias
- cursos obligatorios para el sector (bienestar animal, transporte, aplicador fitosanitario, etc.)
- normativa que afecte directamente a la actividad agrícola o ganadera

────────────────────────────

🚫 UNA ALERTA SERÁ "NO IMPORTA" SI:

- Es ayuda generalista para PYMEs o autónomos sin mención al sector agrario.
- Es subvención multisectorial sin referencia clara al campo.
- Es administración general (oposiciones, tribunales, becas, nombramientos).
- Es concesión individual a un único titular concreto.
- Es contenido relacionado exclusivamente con PESCA.
- No guarda relación clara con la actividad agrícola o ganadera.

Regla clave:
Si el contenido no tiene relación directa o evidente con la actividad agrícola o ganadera → "NO IMPORTA".

---

CLASIFICACIÓN POR ALERTA (solo si es relevante):

"provincias": lista de provincias mencionadas.
Si se refiere a toda la comunidad autónoma → incluir todas sus provincias.
Si es estatal o no menciona ninguna → [].

"sectores": elegir obligatoriamente entre:
["ganaderia","agricultura","mixto","otros"].

"subsectores": elegir entre:
["ovino","vacuno","caprino","porcino","avicultura","cunicultura","equinocultura","apicultura",
"trigo","cebada","cereal","maiz","arroz","hortalizas","frutales","olivar","trufas","viñedo",
"almendro","citricos","frutos_secos","leguminosas","patata","forrajes",
"forestal","agua","energia","medio_ambiente"].

"tipos_alerta": elegir obligatoriamente entre:
["ayudas_subvenciones","normativa_general","agua_infraestructuras","fiscalidad","medio_ambiente"].

---

MENSAJE WHATSAPP (solo si ESA alerta es relevante):

El campo "resumen" debe tener SIEMPRE este formato EXACTO:

"*Ruralicos te avisa* 🌾🚜

📄 *¿Qué ha pasado?*
<1–3 frases claras explicando la alerta del boletín.>

⚠️ *¿A quién afecta?*
<colectivos afectados. Si no especifica: “El boletín no indica destinatarios concretos.”>

📌 *Punto clave*
<dato más relevante. Si no hay plazos: “El boletín no menciona plazos concretos.”>

Añade 1–2 emojis finales en esta línea siempre.

🔗 Enlace al *<fuente>* completo: <url>"

Reglas del mensaje:
- Entre 4–7 frases.
- Lenguaje sencillo.
- No inventar datos.
- Mantener EXACTAMENTE los asteriscos y estructura.
- Sustituir <fuente> por el valor real de Fuente=<fuente> (BOE, BOA, BOJA, BOCYL, etc.).

---

SALIDA ÚNICA:

Debes devolver SIEMPRE un ÚNICO objeto JSON con esta forma:

{
  "resumenes": [
    {
      "id": "ID real",
      "fuente": "valor real de Fuente",
      "resumen": "NO IMPORTA" o "<mensaje WhatsApp completo>",
      "provincias": [],
      "sectores": [],
      "subsectores": [],
      "tipos_alerta": []
    }
  ]
}

REGLAS FINALES IMPORTANTES:
- Cada alerta de entrada debe tener EXACTAMENTE un objeto dentro de "resumenes".
- Si NO es relevante → "resumen": "NO IMPORTA" y todos los arrays vacíos.
- Si ES relevante → resumen completo + clasificación rellenada.
- NO añadir texto fuera del JSON.
- NO usar valores genéricos como <id> o <url>; usar siempre los reales.

IMPORTANTE:
- RESPONDE ÚNICAMENTE CON JSON VÁLIDO.
- NO escribas explicaciones.
- NO escribas texto fuera del objeto JSON.
- Si no devuelves JSON válido, la respuesta será inválida.


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


