// src/routes/revisarAlertas.js
const { checkCronToken } = require("../utils/checkCronToken");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

module.exports = function revisarAlertasRoutes(app, supabase) {
  /**
   * CRON: Revisión final de calidad antes de enviar WhatsApp
   * - Selecciona alertas del día (o recientes) ya resumidas
   * - La IA decide: enviar / no enviar + corrige el texto + impacto
   * - Si NO enviar => resumen = "NO IMPORTA" (para que tu /enviar-whatsapp la ignore sin cambios)
   *
   * Endpoint:
   *   GET /alertas/revisar-final   (protegido con token de cron)
   */

  const revisarFinalHandler = async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: "Falta OPENAI_API_KEY en variables de entorno",
        });
      }

      // Ajusta esto si quieres revisar otra ventana temporal
      const hoy = new Date().toISOString().slice(0, 10);

      // Selecciona alertas candidatas:
      // - fecha hoy
      // - que ya tengan resumen real (no procesando / no NO IMPORTA)
      // - que aún no se hayan enviado
      // - y que no hayan pasado ya por revisión final (si tienes el campo)
      //
      // Si NO tienes columnas revision_final/impacto, no pasa nada:
      // este update seguirá funcionando si las columnas existen;
      // si no existen, quita esas líneas del updateData.
      const { data: alertas, error } = await supabase
        .from("alertas")
        .select("id, titulo, url, fecha, region, resumen, provincias, sectores, subsectores, tipos_alerta")
        .eq("fecha", hoy)
        .neq("resumen", "NO IMPORTA")
        .neq("resumen", "Procesando con IA...")
        .or("whatsapp_enviado.is.null,whatsapp_enviado.eq.false")
        .limit(10);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (!alertas || alertas.length === 0) {
        return res.json({
          success: true,
          revisadas: 0,
          mensaje: "No hay alertas para revisar (hoy)",
          fecha: hoy,
        });
      }

      // Prompt revisor (2º filtro): corto, estricto y operativo
      const input = {
        fecha: hoy,
        alertas: alertas.map((a) => ({
          id: a.id,
          titulo: a.titulo,
          url: a.url,
          region: a.region,
          resumen: a.resumen,
          provincias: a.provincias ?? [],
          sectores: a.sectores ?? [],
          subsectores: a.subsectores ?? [],
          tipos_alerta: a.tipos_alerta ?? [],
        })),
      };

      const prompt = `
Eres el revisor final de calidad de Ruralicos antes de enviar WhatsApp.

TAREA (por cada alerta):
1) Revisa el "resumen" (mensaje WhatsApp) y corrige:
   - ortografía, claridad y concisión
   - elimina paja
   - que no invente datos (si algo no está, debe decir "El BOE no lo indica")
2) Decide si merece enviarse a agricultores/ganaderos:
   - enviar: true/false
   - Si el mensaje es genérico, confuso, redundante o sin utilidad práctica -> enviar=false
3) Asigna impacto: "bajo" | "medio" | "alto"
   - alto: cambia obligaciones, plazos, ayudas relevantes, normativa con efecto claro
   - medio: relevante pero sin acción inmediata
   - bajo: informativo y de poco efecto

REGLAS:
- NO inventes datos.
- Mantén el formato del WhatsApp: "*Ruralicos te avisa* 🌾🚜" y los apartados.
- Si enviar=false, no hace falta mejorar el texto: puedes devolver resumen_corregido vacío o igual.
- Devuelve SOLO JSON válido, sin texto extra.

ENTRADA (JSON):
${JSON.stringify(input)}
`.trim();

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
            "Devuelve únicamente JSON válido. No añadas explicaciones. No añadas Markdown.",
        }),
      });

      if (!aiRes.ok) {
        const text = await aiRes.text();
        console.error("Error OpenAI:", aiRes.status, text);
        return res.status(500).json({
          error: "Error al llamar a OpenAI",
          detalle: text,
        });
      }

      const aiJson = await aiRes.json();

      // Extraer texto del Responses API
      let contenido = "";
      if (typeof aiJson.output_text === "string" && aiJson.output_text.trim()) {
        contenido = aiJson.output_text.trim();
      } else if (Array.isArray(aiJson.output)) {
        for (const item of aiJson.output) {
          if (
            item &&
            item.type === "message" &&
            Array.isArray(item.content) &&
            item.content.length > 0
          ) {
            const first = item.content[0];
            if (typeof first.text === "string") {
              contenido = first.text.trim();
              break;
            } else if (typeof first.value === "string") {
              contenido = first.value.trim();
              break;
            }
          }
        }
      }

      if (!contenido) {
        console.error("Respuesta IA sin contenido de texto:", aiJson);
        return res.status(500).json({
          error: "La IA no devolvió texto",
          bruto: aiJson,
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(contenido);
      } catch (e) {
        console.error("No se pudo parsear JSON de la IA:", contenido);
        return res.status(500).json({
          error: "La respuesta de la IA no es JSON válido",
          bruto: contenido,
        });
      }

      const revisiones = parsed.revisiones;
      if (!Array.isArray(revisiones) || revisiones.length === 0) {
        return res.status(500).json({
          error: "La IA no devolvió revisiones válidas",
          bruto: parsed,
        });
      }

      let actualizadas = 0;
      const errores = [];

      for (const rev of revisiones) {
        if (!rev.id) continue;

        // Si no enviar => lo dejamos como NO IMPORTA para que tu envío actual lo ignore.
        const updateData = {};

        if (rev.enviar === false) {
          updateData.resumen = "NO IMPORTA";
        } else if (typeof rev.resumen_corregido === "string" && rev.resumen_corregido.trim()) {
          updateData.resumen = rev.resumen_corregido.trim();
        }

        // Campos opcionales (si existen en tu tabla)
        if (typeof rev.impacto === "string") updateData.impacto = rev.impacto;
        updateData.revision_final = true;
        updateData.revisado_at = new Date().toISOString();

        const { error: updError } = await supabase
          .from("alertas")
          .update(updateData)
          .eq("id", rev.id);

        if (updError) {
          console.error("Error actualizando alerta revisada", rev.id, updError.message);
          errores.push({ id: rev.id, error: updError.message });
        } else {
          actualizadas++;
        }
      }

      return res.json({
        success: true,
        fecha: hoy,
        candidatas: alertas.length,
        revisadas: revisiones.length,
        actualizadas,
        errores,
      });
    } catch (err) {
      console.error("Error en /alertas/revisar-final", err);
      return res.status(500).json({ error: err.message });
    }
  };

  // Rutas cron (GET protegido + POST opcional si quieres)
  app.get("/alertas/revisar-final", (req, res) => {
    if (!checkCronToken(req, res)) return;
    revisarFinalHandler(req, res);
  });

  app.post("/alertas/revisar-final", (req, res) => {
    if (!checkCronToken(req, res)) return;
    revisarFinalHandler(req, res);
  });
};
