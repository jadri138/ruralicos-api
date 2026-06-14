// src/routes/revisarAlertas.js
const { checkCronToken } = require("../../middleware/cronToken");
const { llamarIA, parsearJSON } = require("../../platform/ia/llamarIA");

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
        .limit(5);

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
Eres el REVISOR FINAL DE CALIDAD de Ruralicos.

Vas a recibir alertas YA PROCESADAS previamente:
- ya tienen un resumen en formato WhatsApp Ruralicos
- ya tienen provincias, sectores, subsectores y tipos_alerta

Tu función NO es reinterpretar el BOE desde cero.
Tu función es decidir si el mensaje FINAL es digno de enviarse a agricultores y ganaderos.

────────────────────────────
OBJETIVO DEL REVISOR
────────────────────────────

Para CADA alerta debes:

1) DECIDIR SI SE ENVÍA O NO
2) CORREGIR el resumen si se envía
3) CORREGIR la clasificación si es necesario

Tú tienes la ÚLTIMA PALABRA.

────────────────────────────
CRITERIO CLAVE DE ENVÍO
────────────────────────────

Una alerta SOLO debe enviarse si:
- Aporta VALOR REAL al conjunto del sector
- Informa de algo que un agricultor o ganadero medio debería conocer

DEBE MARCARSE COMO enviar = false SI:
- Afecta únicamente a un TITULAR CONCRETO
  (concesión individual, expediente individual, explotación concreta)
- Es puramente informativa sin utilidad práctica
- No genera obligación, oportunidad, riesgo ni cambio relevante
- Es ruido legal sin impacto general

⚠️ Regla importante:
Concesiones de agua INDIVIDUALES → normalmente NO SE ENVÍAN.
Solo envíalas si tienen valor excepcional (ej. cambio de criterio, doctrina, precedente relevante).

────────────────────────────
SI enviar = true
────────────────────────────

Debes:

A) CORREGIR EL RESUMEN
- Lenguaje claro y profesional
- Eliminar paja
- NO inventar datos
- Si algo no consta en el BOE, escribe:
  “El BOE no indica destinatarios concretos.”
  “El BOE no menciona plazos concretos.”

B) LIMPIAR TEXTO BASURA
- Elimina CUALQUIER instrucción interna o metatexto.
- NUNCA debe aparecer texto como:
  “Añade 1–2 emojis finales”
  “Reglas del mensaje”
  “Formato”
  “Debes…”
  “SALIDA / ENTRADA”

C) FORMATO WHATSAPP (OBLIGATORIO)
El resumen DEBE respetar EXACTAMENTE esta estructura:

"*Ruralicos te avisa* 🌾🚜

📄 *¿Qué ha pasado?*
<1–3 frases claras>

⚠️ *¿A quién afecta?*
<colectivos afectados o texto estándar si no se indica>

📌 *Punto clave*
<dato más relevante o texto estándar>

<UNA línea con 1–2 emojis, solo emojis>

🔗 Enlace al BOE completo: <url>"

- NO escribas la frase “Añade 1–2 emojis finales”.
- Los emojis deben ir solos en su propia línea.

────────────────────────────
CLASIFICACIÓN (OBLIGATORIA)
────────────────────────────

Puedes CORREGIR libremente:
- provincias
- sectores
- subsectores
- tipos_alerta

Si enviar = false:
- provincias = []
- sectores = []
- subsectores = []
- tipos_alerta = []

────────────────────────────
SALIDA OBLIGATORIA
────────────────────────────

Devuelve SIEMPRE y SOLO JSON válido con este formato exacto:

{
  "revisiones": [
    {
      "id": "id_real",
      "enviar": true | false,
      "resumen_corregido": "texto o string vacío",
      "provincias": [],
      "sectores": [],
      "subsectores": [],
      "tipos_alerta": []
    }
  ]
}

REGLAS FINALES:
- Exactamente UNA revisión por cada alerta de entrada
- NO añadas texto fuera del JSON
- NO expliques decisiones
- NO inventes información

ENTRADA:
${JSON.stringify(input)}
`.trim();

      let contenido;
      try {
        contenido = await llamarIA(prompt, "Devuelve SOLO JSON válido, sin texto adicional.", "gpt-5");
      } catch (e) {
        return res.status(500).json({ error: "Error al llamar a OpenAI", detalle: e.message });
      }

      let parsed;
      try {
        parsed = parsearJSON(contenido);
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
          updateData.estado_ia = "descartado";
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
