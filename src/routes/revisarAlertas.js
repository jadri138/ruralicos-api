// src/routes/revisarAlertas.js
const { checkCronToken } = require("../utils/checkCronToken");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function extractOutputText(aiJson) {
  // 1) output_text (a veces viene)
  if (typeof aiJson?.output_text === "string" && aiJson.output_text.trim()) {
    return aiJson.output_text.trim();
  }

  // 2) Recorremos output[] (Responses API)
  if (Array.isArray(aiJson?.output)) {
    for (const item of aiJson.output) {
      if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;

      for (const c of item.content) {
        // Formato: { text: "..." }
        if (typeof c?.text === "string" && c.text.trim()) return c.text.trim();

        // Formato: { text: { value: "..." } }
        if (typeof c?.text?.value === "string" && c.text.value.trim()) return c.text.value.trim();

        // Formato alterno: { value: "..." }
        if (typeof c?.value === "string" && c.value.trim()) return c.value.trim();
      }
    }
  }

  // 3) Nada encontrado
  return "";
}

module.exports = function revisarAlertasRoutes(app, supabase) {
  const revisarFinalHandler = async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: "Falta OPENAI_API_KEY en variables de entorno",
        });
      }

      // 1) Seleccionar TODO lo que tenga resumen válido y NO esté revisado
      const { data: alertas, error } = await supabase
        .from("alertas")
        .select("id, titulo, url, resumen, provincias, sectores, subsectores, tipos_alerta")
        .neq("resumen", "NO IMPORTA")
        .neq("resumen", "Procesando con IA...")
        .or("revision_final.is.null,revision_final.eq.false")
        .order("created_at", { ascending: true })
        .limit(10);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (!alertas || alertas.length === 0) {
        return res.json({
          success: true,
          revisadas: 0,
          mensaje: "No hay alertas pendientes de revisión",
        });
      }

      // 2) Input para IA (solo lo necesario)
      const input = {
        alertas: alertas.map((a) => ({
          id: a.id,
          titulo: a.titulo,
          url: a.url,
          resumen: a.resumen,
          provincias: Array.isArray(a.provincias) ? a.provincias : [],
          sectores: Array.isArray(a.sectores) ? a.sectores : [],
          subsectores: Array.isArray(a.subsectores) ? a.subsectores : [],
          tipos_alerta: Array.isArray(a.tipos_alerta) ? a.tipos_alerta : [],
        })),
      };

      // 3) Prompt revisor total
      const prompt = `
Eres el REVISOR FINAL de Ruralicos.

OBJETIVO:
Revisar TODO lo que ya tiene resumen (no "NO IMPORTA" ni "Procesando con IA...") y corregir:
- resumen (mensaje WhatsApp)
- provincias
- sectores
- subsectores
- tipos_alerta

PARA CADA ALERTA:
1) Decide si aporta valor real para agricultores/ganaderos:
   - enviar: true/false
   - Si el mensaje es genérico, redundante o no aporta utilidad práctica -> enviar=false
2) Si enviar=true:
   - corrige ortografía y claridad
   - reduce paja
   - NO inventes datos (si falta algo: "El BOE no lo indica")
   - Mantén el formato del WhatsApp y sus apartados
3) Corrige clasificación si procede (puedes añadir/quitar elementos)

SALIDA (OBLIGATORIA, SOLO JSON VÁLIDO):
{
  "revisiones": [
    {
      "id": "id",
      "enviar": true,
      "resumen_corregido": "texto",
      "provincias": [],
      "sectores": [],
      "subsectores": [],
      "tipos_alerta": []
    }
  ]
}

REGLAS:
- Devuelve exactamente 1 objeto en "revisiones" por cada alerta de entrada.
- Si enviar=false:
  - "resumen_corregido" puede ser "" (vacío)
  - y los arrays deben ser []
- NO añadas nada fuera del JSON.

ENTRADA:
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
          // Añadimos instructions para forzar JSON
          instructions: "Devuelve SOLO JSON válido, sin texto adicional.",
        }),
      });

      if (!aiRes.ok) {
        const text = await aiRes.text();
        return res.status(500).json({
          error: "Error al llamar a OpenAI",
          detalle: text,
        });
      }

      const aiJson = await aiRes.json();
      const contenido = extractOutputText(aiJson);

      if (!contenido) {
        return res.status(500).json({
          error: "La IA no devolvió contenido",
          bruto: aiJson, // ayuda a depurar
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(contenido);
      } catch (e) {
        return res.status(500).json({
          error: "JSON inválido devuelto por la IA",
          bruto: contenido,
        });
      }

      const revisiones = parsed?.revisiones;
      if (!Array.isArray(revisiones) || revisiones.length === 0) {
        return res.status(500).json({
          error: "La IA no devolvió revisiones válidas",
          bruto: parsed,
        });
      }

      // 4) Actualizar BD
      let actualizadas = 0;
      const errores = [];

      for (const rev of revisiones) {
        if (!rev || !rev.id) continue;

        const updateData = { revision_final: true };

        if (rev.enviar === false) {
          updateData.resumen = "NO IMPORTA";
          updateData.provincias = [];
          updateData.sectores = [];
          updateData.subsectores = [];
          updateData.tipos_alerta = [];
        } else {
          // Validaciones mínimas para no meter nulls raros
          if (typeof rev.resumen_corregido === "string" && rev.resumen_corregido.trim()) {
            updateData.resumen = rev.resumen_corregido.trim();
          }

          if (Array.isArray(rev.provincias)) updateData.provincias = rev.provincias;
          if (Array.isArray(rev.sectores)) updateData.sectores = rev.sectores;
          if (Array.isArray(rev.subsectores)) updateData.subsectores = rev.subsectores;
          if (Array.isArray(rev.tipos_alerta)) updateData.tipos_alerta = rev.tipos_alerta;
        }

        const { error: updError } = await supabase
          .from("alertas")
          .update(updateData)
          .eq("id", rev.id);

        if (updError) {
          errores.push({ id: rev.id, error: updError.message });
        } else {
          actualizadas++;
        }
      }

      return res.json({
        success: true,
        candidatas: alertas.length,
        revisiones: revisiones.length,
        actualizadas,
        errores,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  };

  // Rutas CRON
  app.get("/alertas/revisar-final", (req, res) => {
    if (!checkCronToken(req, res)) return;
    revisarFinalHandler(req, res);
  });

  app.post("/alertas/revisar-final", (req, res) => {
    if (!checkCronToken(req, res)) return;
    revisarFinalHandler(req, res);
  });
};
