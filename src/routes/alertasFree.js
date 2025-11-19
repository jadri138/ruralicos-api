// src/routes/alertasFree.js

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

module.exports = function alertasFreeRoutes(app, supabase, enviarWhatsapp) {

  const FREE_DIGEST_PROMPT = `
Te paso una lista de alertas RELEVANTES del BOE sobre agricultura y ganadería, una por línea, con este formato:

ID <id> | Fecha <fecha> | Titulo: <titulo> | Texto: <texto> | Url: <url>

TU TAREA:
Redacta UN SOLO mensaje de WhatsApp para usuarios GRATUITOS de un servicio llamado Ruralicos.

REQUISITOS:
- Empieza con: "RURALICOS · Resumen BOE de hoy (agricultura y ganadería)"
- 1 frase introductoria.
- Lista numerada 1), 2), 3)..., 1 línea por alerta.
- Cada línea: mini resumen (máx. 20 palabras) + "→ BOE: <url>"
- Lenguaje sencillo. Nada inventado.

FORMATO OBLIGATORIO DE SALIDA:
{
  "mensaje": "<mensaje completo>"
}
`;

  async function generarMensajeFreeDesdeIA(alertas) {
    const lineas = alertas.map(a => {
      const textoCorto = (a.texto || '').slice(0, 400);
      return `ID ${a.id} | Fecha ${a.fecha} | Titulo: ${a.titulo} | Texto: ${textoCorto} | Url: ${a.url}`;
    }).join("\n");

    const promptFinal = `${FREE_DIGEST_PROMPT}\n\nALERTAS:\n${lineas}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "Eres un asistente experto en resúmenes muy breves." },
        { role: "user", content: promptFinal }
      ],
      temperature: 0.3
    });

    const raw = completion.choices[0].message.content;

    const json = JSON.parse(raw);
    return json.mensaje;
  }

  app.post("/alertas/enviar-whatsapp-free", async (req, res) => {
    try {
      const hoy = new Date().toISOString().slice(0, 10);

      const { data: alertas, error: errAlertas } = await supabase
        .from("alertas")
        .select("id, fecha, titulo, texto, url, resumen")
        .eq("fecha", hoy)
        .neq("resumen", "NO IMPORTA");

      if (errAlertas) return res.status(500).json({ error: "Error obteniendo alertas" });
      if (!alertas || alertas.length === 0)
        return res.json({ ok: true, mensaje: "Hoy no hay alertas relevantes para FREE" });

      const seleccion = alertas.slice(0, 10);

      const mensaje = await generarMensajeFreeDesdeIA(seleccion);

      const { data: usuarios, error: errUsers } = await supabase
        .from("users")
        .select("phone")
        .eq("subscription", "free");

      if (errUsers) return res.status(500).json({ error: "Error obteniendo usuarios FREE" });
      if (!usuarios || usuarios.length === 0)
        return res.json({ ok: true, mensaje: "No hay usuarios FREE" });

      for (const u of usuarios) {
        try {
          await enviarWhatsapp(u.phone, mensaje);
        } catch (e) {
          console.error("Error enviando WhatsApp FREE:", u.phone, e);
        }
      }

      res.json({
        ok: true,
        alertas_usadas: seleccion.length,
        usuarios_free: usuarios.length
      });

    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Error interno enviando FREE" });
    }
  });

};
