const { checkCronToken } = require("../utils/checkCronToken");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

module.exports = function revisarAlertasRoutes(app, supabase) {

  const revisarFinalHandler = async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: "Falta OPENAI_API_KEY en variables de entorno",
        });
      }

      // 1️⃣ Seleccionar TODO lo que tenga resumen válido y NO esté revisado
      const { data: alertas, error } = await supabase
        .from("alertas")
        .select("id, titulo, url, resumen, provincias, sectores, subsectores, tipos_alerta")
        .neq("resumen", "NO IMPORTA")
        .neq("resumen", "Procesando con IA...")
        .or("revision_final.is.null,revision_final.eq.false")
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

      // 2️⃣ Preparar input para la IA
      const input = {
        alertas: alertas.map((a) => ({
          id: a.id,
          titulo: a.titulo,
          url: a.url,
          resumen: a.resumen,
          provincias: a.provincias ?? [],
          sectores: a.sectores ?? [],
          subsectores: a.subsectores ?? [],
          tipos_alerta: a.tipos_alerta ?? [],
        })),
      };

      // 3️⃣ PROMPT FINAL (revisor total)
      const prompt = `
Eres el REVISOR FINAL de Ruralicos.

Para CADA alerta debes:
1) Revisar y mejorar el resumen WhatsApp:
   - lenguaje claro
   - sin paja
   - sin inventar datos
2) Decidir si aporta valor real:
   - enviar = false si no sirve
3) Corregir si es necesario:
   - provincias
   - sectores
   - subsectores
   - tipos_alerta

REGLAS:
- Si NO aporta valor → enviar=false y no inventes nada.
- Si enviar=true → devuelve el resumen completo en formato WhatsApp Ruralicos.
- Devuelve SOLO JSON válido.
- No añadas texto fuera del JSON.

FORMATO DE SALIDA OBLIGATORIO:

{
  "revisiones": [
    {
      "id": "id",
      "enviar": true | false,
      "resumen_corregido": "texto",
      "provincias": [],
      "sectores": [],
      "subsectores": [],
      "tipos_alerta": []
    }
  ]
}

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
        }),
      });

      if (!aiRes.ok) {
        const text = await aiRes.text();
        return res.status(500).json({ error: text });
      }

      const aiJson = await aiRes.json();

      const contenido =
        aiJson.output_text ||
        aiJson.output?.[0]?.content?.[0]?.text ||
        "";

      if (!contenido) {
        return res.status(500).json({
          error: "La IA no devolvió contenido",
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

      const revisiones = parsed.revisiones || [];
      let actualizadas = 0;

      // 4️⃣ Actualizar BD
      for (const rev of revisiones) {
        if (!rev.id) continue;

        const updateData = { revision_final: true };

        if (rev.enviar === false) {
          updateData.resumen = "NO IMPORTA";
        } else {
          updateData.resumen = rev.resumen_corregido;
          updateData.provincias = rev.provincias ?? [];
          updateData.sectores = rev.sectores ?? [];
          updateData.subsectores = rev.subsectores ?? [];
          updateData.tipos_alerta = rev.tipos_alerta ?? [];
        }

        const { error: updError } = await supabase
          .from("alertas")
          .update(updateData)
          .eq("id", rev.id);

        if (!updError) actualizadas++;
      }

      return res.json({
        success: true,
        candidatas: alertas.length,
        actualizadas,
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
