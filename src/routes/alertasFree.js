// src/routes/alertasFree.js

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

module.exports = function alertasFreeRoutes(app, supabase) {

  // ============================================================
  //   RUTA: Generar y guardar el RESUMEN FREE en cada alerta HOY
  // ============================================================
  app.post("/alertas/generar-resumen-free", async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: "Falta OPENAI_API_KEY en variables de entorno",
        });
      }

      const hoy = new Date().toISOString().slice(0, 10);

      // 1) Obtener alertas relevantes HOY con su resumen PRO
      const { data: alertas, error } = await supabase
        .from("alertas")
        .select("id, titulo, resumen, url, fecha")
        .eq("fecha", hoy)
        .neq("resumen", "NO IMPORTA")
        .neq("resumen", "Procesando con IA...");

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (!alertas || alertas.length === 0) {
        return res.json({
          success: true,
          mensaje: "No hay alertas relevantes hoy para generar resumen FREE",
        });
      }

      // 2) Preparar lista para el prompt
      const lista = alertas
        .map((a) => {
          const corto = (a.resumen || "").slice(0, 200);
          return `ID ${a.id} | Titulo: ${a.titulo} | ResumenPro: ${corto} | Url: ${a.url}`;
        })
        .join("\n");

      // 3) Prompt especial FREE
      const prompt = `
Te paso una lista de alertas del BOE ya analizadas y resumidas por la IA PRO.

Cada línea tiene:
ID <id> | Titulo: <titulo> | ResumenPro: <resumen corto> | Url: <url>

TU TAREA:
Genera un mensaje ÚNICO de WhatsApp para usuarios GRATUITOS de Ruralicos.

Formato EXACTO:
*RURALICOS INFORMA* · Resumen BOE de hoy (agricultura y ganadería)

1 frase introductoria.

Lista numerada:
*1)* mini resumen claro (basado en ResumenPro) → BOE: <url>
*2)* ...
*3)* ...

NO inventes nada.
NO pongas emojis.
Texto muy sencillo para agricultores.

Termina el mensaje poniendo: Alertas mas extensas y personalizadas en la version PRO. en negrita con 1 asterisco al principio y otro al final de la frase
Devuelve EXACTAMENTE este JSON:

{
  "mensaje": "<mensaje final>"
}

Lista:
${lista}
`.trim();

      // 4) Llamada a OpenAI, igual que en alertas.js
      const aiRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-5-nano",
          input: prompt,
          instructions:
            "Eres un asistente experto en resumir en formato lista para WhatsApp. Responde SOLO con el JSON pedido.",
        }),
      });

      if (!aiRes.ok) {
        const txt = await aiRes.text();
        console.error("Error IA FREE:", aiRes.status, txt);
        return res.status(500).json({
          error: "Error OpenAI en resumen FREE",
          detalle: txt,
        });
      }

      const aiJson = await aiRes.json();

      // 5) Extraer texto igual que alertas.js
      let contenido = "";

      if (typeof aiJson.output_text === "string" && aiJson.output_text.trim()) {
        contenido = aiJson.output_text.trim();
      } else if (Array.isArray(aiJson.output)) {
        for (const item of aiJson.output) {
          if (
            item &&
            item.type === "message" &&
            Array.isArray(item.content) &&
            item.content[0]
          ) {
            const c = item.content[0];
            if (typeof c.text === "string") contenido = c.text.trim();
            else if (typeof c.value === "string") contenido = c.value.trim();
            break;
          }
        }
      }

      if (!contenido) {
        return res.status(500).json({
          error: "La IA no devolvió texto válido en FREE",
          bruto: aiJson,
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(contenido);
      } catch (e) {
        return res.status(500).json({
          error: "El JSON generado por IA FREE no es válido",
          bruto: contenido,
        });
      }

      if (!parsed.mensaje) {
        return res.status(500).json({
          error: "La IA FREE no devolvió 'mensaje'",
          bruto: parsed,
        });
      }

      const resumenFree = parsed.mensaje;

      // 6) Guardar en una nueva columna ResumenFree (crea la columna en Supabase)
      for (const a of alertas) {
        await supabase
          .from("alertas")
          .update({ ResumenFree: resumenFree })
          .eq("id", a.id);
      }

      res.json({
        success: true,
        resumen_guardado_en: alertas.length,
        mensaje_free: resumenFree,
      });
    } catch (err) {
      console.error("Error FREE:", err);
      res.status(500).json({ error: err.message });
    }
  });
};
