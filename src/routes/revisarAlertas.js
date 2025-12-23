// src/routes/revisarAlertas.js
const { checkCronToken } = require("../utils/checkCronToken");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function extractOutputText(aiJson) {
  if (typeof aiJson?.output_text === "string" && aiJson.output_text.trim()) {
    return aiJson.output_text.trim();
  }

  if (Array.isArray(aiJson?.output)) {
    for (const item of aiJson.output) {
      if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;

      for (const c of item.content) {
        if (typeof c?.text === "string" && c.text.trim()) return c.text.trim();
        if (typeof c?.text?.value === "string" && c.text.value.trim()) return c.text.value.trim();
        if (typeof c?.value === "string" && c.value.trim()) return c.value.trim();
      }
    }
  }

  return "";
}

// Limpieza defensiva por si la IA mete metatexto/instrucciones internas
function sanitizeResumen(resumen) {
  if (!resumen || typeof resumen !== "string") return resumen;

  const bannedPatterns = [
    /Añade\s*1\s*[–-]\s*2\s*emojis\s*finales\.?/gi,
    /Añade\s+.*emojis.*\.?/gi,
    /Reglas del mensaje:.*$/gims,
    /^REGLAS:.*$/gims,
    /^ENTRADA:.*$/gims,
    /^SALIDA.*$/gims,
    /^Debes.*$/gims,
    /^No añadas.*$/gims,
  ];

  let out = resumen;
  for (const re of bannedPatterns) out = out.replace(re, "");

  // Limpieza de líneas vacías múltiples
  out = out
    .split("\n")
    .map((l) => l.replace(/\s+$/g, "")) // trimEnd manual
    .filter((l, idx, arr) => !(l === "" && arr[idx - 1] === ""))
    .join("\n")
    .trim();

  return out;
}

module.exports = function revisarAlertasRoutes(app, supabase) {
  const revisarFinalHandler = async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: "Falta OPENAI_API_KEY en variables de entorno",
        });
      }

      // 1) Seleccionar resúmenes válidos NO revisados (más recientes primero)
      let query = supabase
        .from("alertas")
        .select("id, titulo, url, fecha, resumen, provincias, sectores, subsectores, tipos_alerta, created_at")
        .neq("resumen", "NO IMPORTA")
        .neq("resumen", "Procesando con IA...")
        .or("revision_final.is.null,revision_final.eq.false");

      query = query
        .order("fecha", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(10);

      const { data: alertas, error } = await query;

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

      // 2) Input para IA
      const input = {
        alertas: alertas.map((a) => ({
          id: a.id,
          titulo: a.titulo,
          url: a.url,
          fecha: a.fecha,
          resumen: a.resumen,
          provincias: Array.isArray(a.provincias) ? a.provincias : [],
          sectores: Array.isArray(a.sectores) ? a.sectores : [],
          subsectores: Array.isArray(a.subsectores) ? a.subsectores : [],
          tipos_alerta: Array.isArray(a.tipos_alerta) ? a.tipos_alerta : [],
        })),
      };

      // 3) Prompt revisor (ENDURECIDO)
      const prompt = `
Eres el REVISOR FINAL de Ruralicos (antes de enviar WhatsApp).

VAS A RECIBIR alertas YA resumidas. Para CADA alerta:
A) Decide si aporta valor real para agricultores/ganaderos:
   - enviar: true/false
   - Si es genérica, redundante o no aporta utilidad práctica -> enviar=false

B) Si enviar=true:
   - corrige ortografía y claridad
   - reduce paja
   - NO inventes datos (si falta algo: "El BOE no lo indica")
   - conserva el formato del WhatsApp Ruralicos y sus apartados

C) Corrige si hace falta la clasificación:
   - provincias, sectores, subsectores, tipos_alerta

REGLAS DURAS (OBLIGATORIAS):
- PROHIBIDO incluir instrucciones internas o metatexto en el mensaje final.
  Ejemplos prohibidos: "Añade 1–2 emojis finales", "Reglas del mensaje", "SALIDA", "ENTRADA", "Debes...".
  Si aparecen en el resumen, ELIMÍNALOS.
- Si enviar=true:
  - El mensaje final debe incluir 1 línea con 1–2 emojis (solo emojis) antes del enlace.
  - NO escribas la frase "Añade 1–2 emojis finales." (nunca).
- Si enviar=false:
  - resumen_corregido debe ser "" (vacío) y arrays [].

SALIDA OBLIGATORIA (SOLO JSON VÁLIDO):
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

REGLAS DE CONSISTENCIA:
- Exactamente 1 objeto en "revisiones" por cada alerta de entrada.
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
          bruto: aiJson,
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
      if (!Array.isArray(revisiones) || revisiones.length !== alertas.length) {
        return res.status(500).json({
          error: "La IA no devolvió revisiones válidas (cantidad incorrecta)",
          esperado: alertas.length,
          devuelto: Array.isArray(revisiones) ? revisiones.length : null,
          bruto: parsed,
        });
      }

      // 4) Actualizar BD
      let actualizadas = 0;
      const errores = [];

      for (const rev of revisiones) {
        if (!rev?.id) continue;

        const updateData = { revision_final: true };

        if (rev.enviar === false) {
          updateData.resumen = "NO IMPORTA";
          updateData.provincias = [];
          updateData.sectores = [];
          updateData.subsectores = [];
          updateData.tipos_alerta = [];
        } else {
          if (typeof rev.resumen_corregido === "string" && rev.resumen_corregido.trim()) {
            updateData.resumen = sanitizeResumen(rev.resumen_corregido).trim();
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
        actualizadas,
        errores,
        ids: alertas.map((a) => a.id),
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
