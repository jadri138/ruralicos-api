// src/routes/alertasFree.js

module.exports = function alertasFreeRoutes(app, supabase, enviarWhatsapp, openai) {

  const FREE_DIGEST_PROMPT = `
Te paso una lista de alertas RELEVANTES del BOE sobre agricultura y ganadería, una por línea, con este formato:

ID <id> | Fecha <fecha> | Titulo: <titulo> | Texto: <texto> | Url: <url>

TU TAREA:
Redacta UN SOLO mensaje de WhatsApp para usuarios GRATUITOS de un servicio llamado Ruralicos.

REQUISITOS DEL MENSAJE:
- Empieza con esta línea:
RURALICOS · Resumen BOE de hoy (agricultura y ganadería)
- Después, una frase muy corta explicando que es un resumen de las novedades del día.
- Luego, una lista numerada 1), 2), 3)... con una línea por alerta:
  - Resume cada alerta en una sola frase sencilla (máx. 20 palabras).
  - Al final de cada línea pon el enlace al BOE con este formato: "→ BOE: <url>".
- No repitas el texto completo del BOE, solo ideas clave.
- No inventes plazos ni importes.
- Usa lenguaje muy sencillo.

FORMATO DE SALIDA OBLIGATORIO:
Devuelve SOLO este JSON válido:

{
  "mensaje": "<mensaje de WhatsApp completo>"
}
`;

  async function generarMensajeFreeDesdeIA(alertas, openai) {
    const lineas = alertas.map(a => {
      const textoCorto = (a.texto || '').slice(0, 400);
      return `ID ${a.id} | Fecha ${a.fecha} | Titulo: ${a.titulo} | Texto: ${textoCorto} | Url: ${a.url}`;
    });

    const lista = lineas.join('\n');

    const contenido = `
${FREE_DIGEST_PROMPT}

AQUÍ VAN LAS ALERTAS:

${lista}
`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'Eres un asistente que hace resúmenes muy cortos y claros para WhatsApp.' },
        { role: 'user', content: contenido }
      ],
      temperature: 0.3
    });

    const raw = completion.choices[0].message.content;

    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      console.error('Error parseando JSON del resumen FREE:', e, raw);
      throw new Error('La IA no devolvió JSON válido');
    }

    return json.mensaje;
  }

  app.post('/alertas/enviar-whatsapp-free', async (req, res) => {
    try {
      const hoyISO = new Date().toISOString().slice(0, 10);

      const { data: alertas, error: errAlertas } = await supabase
        .from('alertas')
        .select('id, fecha, titulo, texto, url, resumen')
        .eq('fecha', hoyISO)
        .eq('fuente', 'BOE')
        .neq('resumen', 'NO IMPORTA');

      if (errAlertas) {
        console.error(errAlertas);
        return res.status(500).json({ error: 'Error obteniendo alertas' });
      }

      if (!alertas || alertas.length === 0) {
        return res.json({ ok: true, mensaje: 'Hoy no hay alertas relevantes para FREE' });
      }

      const seleccion = alertas.slice(0, 10);

      const mensajeWhatsApp = await generarMensajeFreeDesdeIA(seleccion, openai);

      const { data: usuarios, error: errUsers } = await supabase
        .from('users')
        .select('phone')
        .eq('subscription', 'free');

      if (errUsers) {
        console.error(errUsers);
        return res.status(500).json({ error: 'Error obteniendo usuarios FREE' });
      }

      if (!usuarios || usuarios.length === 0) {
        return res.json({ ok: true, mensaje: 'No hay usuarios FREE' });
      }

      for (const u of usuarios) {
        try {
          await enviarWhatsapp(u.phone, mensajeWhatsApp);
        } catch (e) {
          console.error('Error enviando WhatsApp FREE a', u.phone, e);
        }
      }

      res.json({
        ok: true,
        alertas_usadas: seleccion.length,
        usuarios_free: usuarios.length
      });

    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error interno enviando resumen FREE' });
    }
  });

};
