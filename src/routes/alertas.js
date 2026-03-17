// src/routes/alertas.js
const { checkCronToken } = require('../utils/checkCronToken');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const { enviarWhatsAppResumen } = require('../whatsapp');

// ─────────────────────────────────────────────
// fetch compatible con Node 18+ y versiones anteriores
// ─────────────────────────────────────────────
let _fetch;
if (typeof globalThis.fetch === 'function') {
  _fetch = globalThis.fetch.bind(globalThis);
} else {
  try {
    // node-fetch v2 (CommonJS)
    _fetch = require('node-fetch');
  } catch {
    throw new Error('No hay fetch disponible. Actualiza a Node 18+ o instala node-fetch v2.');
  }
}

// ─────────────────────────────────────────────
// Helper: llamar a OpenAI Responses API
// ─────────────────────────────────────────────
async function llamarIA(prompt, instructions, model = 'gpt-5-nano') {
  if (!OPENAI_API_KEY) throw new Error('Falta OPENAI_API_KEY en variables de entorno');

  const aiRes = await _fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, input: prompt, instructions }),
  });

  if (!aiRes.ok) {
    const text = await aiRes.text();
    throw new Error(`Error OpenAI ${aiRes.status}: ${text}`);
  }

  const aiJson = await aiRes.json();

  let contenido = '';
  if (typeof aiJson.output_text === 'string' && aiJson.output_text.trim()) {
    contenido = aiJson.output_text.trim();
  } else if (Array.isArray(aiJson.output)) {
    for (const item of aiJson.output) {
      if (item?.type === 'message' && Array.isArray(item.content) && item.content.length > 0) {
        const first = item.content[0];
        contenido = (typeof first.text === 'string' ? first.text : first.value ?? '').trim();
        if (contenido) break;
      }
    }
  }

  if (!contenido) throw new Error('La IA no devolvió texto');
  return contenido;
}

// ─────────────────────────────────────────────
// Helper: parsear JSON de la IA (limpia fences)
// ─────────────────────────────────────────────
function parsearJSON(texto) {
  const limpio = texto.replace(/```json|```/g, '').trim();
  return JSON.parse(limpio);
}

// ─────────────────────────────────────────────
// Helper: construir prompt de clasificación para 1 o N alertas
// ─────────────────────────────────────────────
function buildPromptClasificar(lista) {
  return `
Te paso una lista de alertas de boletines oficiales. Para CADA una debes:

1) Decidir si es RELEVANTE PARA EL SECTOR AGRARIO O GANADERO.

────────────────────────────
✅ SÍ IMPORTA — Una alerta ES relevante si trata sobre:
────────────────────────────
- Agricultores, ganaderos, explotaciones agrarias o ganaderas
- Comunidades de regantes, regadíos, infraestructuras de riego
- Cooperativas agrarias, SAT, industria agroalimentaria
- PAC, FEGA, Solicitud Única, SIGPAC
- Sanidad animal, movimientos de animales, bienestar animal (aunque sea muy técnico)
- Plagas, fitosanitarios, fertilización, cuaderno de campo
- Licitaciones de obras de riego o infraestructuras agrarias
- Vitivinicultura, olivar, frutales, cereal, ganadería específica
- Normativa que afecte directamente a la actividad agrícola o ganadera
- Cursos y formación obligatoria del sector (bienestar animal, transporte, aplicador fitosanitario…)
- Fiscalidad agraria: módulos, IRPF agrario, IVA agropecuario, regímenes especiales del campo
- Normativa medioambiental que afecte directamente a explotaciones agrarias o ganaderas
- Nombramientos de cargos con poder real sobre el sector: Ministro/a de Agricultura, Director/a General PAC, Consejero/a de Agricultura de una CCAA, Presidente/a de organismo agrario nacional o autonómico

────────────────────────────
🚫 NO IMPORTA — Una alerta NO es relevante si:
────────────────────────────
- Es una concesión o ayuda resuelta a favor de un único titular concreto (persona física o empresa individual), SALVO que afecte a una comunidad de regantes, a infraestructura pública agraria, o que abra un procedimiento con plazos de alegaciones que puedan afectar a terceros
- Es convocatoria de oposiciones, bolsa de empleo o proceso selectivo público
- Es nombramiento o cese de cargos administrativos menores: jefes de sección, delegados provinciales, registradores, notarios, funcionarios de oficinas concretas
- Es licitación de obras de construcción, urbanismo o infraestructuras no agrarias
- Es subvención o ayuda generalista para PYMEs/autónomos sin mención al sector agrario
- Trata exclusivamente de pesca o acuicultura
- Es de administración general sin impacto en el campo: becas universitarias, convenios colectivos no agrarios, tasas administrativas generales
- No guarda relación directa ni evidente con la actividad agrícola o ganadera

2) Si ES relevante, clasificarla con:
- "provincias": lista de provincias mencionadas. Si es toda una CCAA → todas sus provincias. Si es estatal → [].
- "sectores": uno o varios de ["ganaderia","agricultura","mixto","otros"]
- "subsectores": uno o varios de ["ovino","vacuno","caprino","porcino","avicultura","cunicultura","equinocultura","apicultura","trigo","cebada","cereal","maiz","arroz","hortalizas","frutales","olivar","trufas","viñedo","almendro","citricos","frutos_secos","leguminosas","patata","forrajes","forestal","agua","energia","medio_ambiente"]
- "tipos_alerta": uno o varios de ["ayudas_subvenciones","normativa_general","agua_infraestructuras","fiscalidad","medio_ambiente"]

SALIDA: devuelve ÚNICAMENTE este JSON válido, sin texto extra:

{
  "resultados": [
    {
      "id": "ID real",
      "es_relevante": true,
      "provincias": [],
      "sectores": [],
      "subsectores": [],
      "tipos_alerta": []
    }
  ]
}

Si NO es relevante → "es_relevante": false y todos los arrays vacíos.

Lista de alertas:
${lista}
`.trim();
}

// ─────────────────────────────────────────────
// Helper: clasificar alertas con reintento individual si falla
// ─────────────────────────────────────────────
async function clasificarConReintento(alertas) {
  const instructions = 'Eres un clasificador experto del sector agrario español. Responde SOLO con JSON válido, sin explicaciones.';

  const formatarAlerta = (a) => {
    const texto = a.contenido ? a.contenido.slice(0, 3000) : '';
    return `ID=${a.id} | Fecha=${a.fecha} | Region=${a.region} | URL=${a.url} | Titulo=${a.titulo} | Texto=${texto}`;
  };

  // Intento en lote
  const lista = alertas.map(formatarAlerta).join('\n\n');
  let resultados = [];

  try {
    const contenido = await llamarIA(buildPromptClasificar(lista), instructions, 'gpt-5-nano');
    const parsed = parsearJSON(contenido);
    resultados = parsed.resultados || [];
  } catch (err) {
    console.error('Error en clasificación en lote, pasando a reintentos individuales:', err.message);
  }

  // Detectar IDs que faltan en la respuesta
  const idsRecibidos = new Set(resultados.map((r) => String(r.id)));
  const alertasFallidas = alertas.filter((a) => !idsRecibidos.has(String(a.id)));

  if (alertasFallidas.length > 0) {
    console.warn(`Faltan ${alertasFallidas.length} IDs en la respuesta del lote. Reintentando uno a uno...`);

    for (const alerta of alertasFallidas) {
      try {
        const listaIndividual = formatarAlerta(alerta);
        const contenido = await llamarIA(buildPromptClasificar(listaIndividual), instructions, 'gpt-5-nano');
        const parsed = parsearJSON(contenido);
        const res = (parsed.resultados || [])[0];
        if (res && String(res.id) === String(alerta.id)) {
          resultados.push(res);
        } else {
          console.warn(`Reintento fallido para ID ${alerta.id}: respuesta no coincide. Se deja pendiente.`);
          // No se añade → quedará pendiente para el siguiente cron
        }
      } catch (err) {
        console.error(`Error en reintento individual ID ${alerta.id}:`, err.message);
        // Se deja pendiente para el siguiente cron
      }
    }
  }

  return resultados;
}

// ══════════════════════════════════════════════════════════════════════
// SQL PARA SUPABASE (ejecutar una vez en el SQL Editor de Supabase):
//
// ALTER TABLE alertas
//   ADD COLUMN IF NOT EXISTS estado_ia TEXT DEFAULT 'pendiente_clasificar',
//   ADD COLUMN IF NOT EXISTS resumen_borrador TEXT,
//   ADD COLUMN IF NOT EXISTS resumen_final TEXT;
//
// CREATE INDEX IF NOT EXISTS idx_alertas_estado_ia ON alertas(estado_ia);
//
// estados posibles de estado_ia:
//   'pendiente_clasificar' → recién insertada, esperando Paso 1
//   'descartado'           → la IA decidió que no es relevante
//   'pendiente_resumir'    → clasificada como relevante, esperando Paso 2
//   'pendiente_revisar'    → borrador listo, esperando Paso 3
//   'listo'                → revisada y lista para enviar por WhatsApp
// ══════════════════════════════════════════════════════════════════════

module.exports = function alertasRoutes(app, supabase) {

  // ══════════════════════════════════════════
  // 1) Insertar alerta manual
  // ══════════════════════════════════════════
  app.post('/alertas', async (req, res) => {
    const { titulo, resumen, url, fecha, region } = req.body;

    if (!titulo || !url || !fecha) {
      return res.status(400).json({ error: 'Faltan campos obligatorios: titulo, url o fecha' });
    }

    const { data, error } = await supabase
      .from('alertas')
      .insert([{
        titulo,
        resumen: resumen ?? null,
        url,
        fecha,
        region,
        estado_ia: 'pendiente_clasificar',
      }])
      .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, alerta: data[0] });
  });

  // ══════════════════════════════════════════
  // 2) Listar todas las alertas
  // ══════════════════════════════════════════
  app.get('/alertas', async (req, res) => {
    const { data, error } = await supabase
      .from('alertas')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ count: data.length, alertas: data });
  });

  // ══════════════════════════════════════════════════════════════
  // PASO 1 — /alertas/clasificar
  // IA 1: decide relevancia + clasificación. Descarta la paja.
  // Cron recomendado: cada 5-10 minutos durante el horario de ingesta
  // ══════════════════════════════════════════════════════════════
  const clasificarHandler = async (req, res) => {
    try {
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, region, fecha, contenido')
        .eq('estado_ia', 'pendiente_clasificar')
        .order('created_at', { ascending: true })
        .limit(5);

      if (error) return res.status(500).json({ error: error.message });
      if (!alertas || alertas.length === 0) {
        return res.json({ success: true, procesadas: 0, mensaje: 'No hay alertas pendientes de clasificar' });
      }

      const resultados = await clasificarConReintento(alertas);

      let clasificadas = 0;
      let descartadas = 0;

      for (const item of resultados) {
        if (!item.id) continue;

        if (!item.es_relevante) {
          await supabase
            .from('alertas')
            .update({
              estado_ia: 'descartado',
              resumen: 'NO IMPORTA',
              provincias: [],
              sectores: [],
              subsectores: [],
              tipos_alerta: [],
            })
            .eq('id', item.id);
          descartadas++;
        } else {
          await supabase
            .from('alertas')
            .update({
              estado_ia: 'pendiente_resumir',
              provincias: item.provincias ?? [],
              sectores: item.sectores ?? [],
              subsectores: item.subsectores ?? [],
              tipos_alerta: item.tipos_alerta ?? [],
            })
            .eq('id', item.id);
          clasificadas++;
        }
      }

      // Las alertas que no aparecen en resultados se quedan en 'pendiente_clasificar'
      // y serán reintentadas en el siguiente cron
      const idsNoResueltos = alertas
        .filter((a) => !resultados.find((r) => String(r.id) === String(a.id)))
        .map((a) => a.id);

      res.json({
        success: true,
        procesadas: alertas.length,
        clasificadas,
        descartadas,
        pendientes_reintento: idsNoResueltos,
      });

    } catch (err) {
      console.error('Error en /alertas/clasificar', err);
      res.status(500).json({ error: err.message });
    }
  };

  app.post('/alertas/clasificar', (req, res) => {
    if (!checkCronToken(req, res)) return;
    clasificarHandler(req, res);
  });
  app.get('/alertas/clasificar', (req, res) => {
    if (!checkCronToken(req, res)) return;
    clasificarHandler(req, res);
  });

  // ══════════════════════════════════════════════════════════════
  // PASO 2 — /alertas/resumir
  // IA 2: SOLO redacta el mensaje WhatsApp. No clasifica, no decide.
  // Cron recomendado: cada 5-10 minutos durante el horario de ingesta
  // ══════════════════════════════════════════════════════════════
  const resumirHandler = async (req, res) => {
    try {
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, region, fecha, contenido')
        .eq('estado_ia', 'pendiente_resumir')
        .order('created_at', { ascending: true })
        .limit(3);

      if (error) return res.status(500).json({ error: error.message });
      if (!alertas || alertas.length === 0) {
        return res.json({ success: true, procesadas: 0, mensaje: 'No hay alertas pendientes de resumir' });
      }

      // Procesamos UNA A UNA — el mensaje WhatsApp tiene asteriscos, emojis y
      // saltos de línea que rompen el JSON cuando van en lote dentro de un string.
      // La IA devuelve directamente el texto del mensaje, sin envolver en JSON.
      const instructions = 'Eres un redactor experto en comunicación agraria. Responde SOLO con el texto del mensaje WhatsApp, sin JSON, sin explicaciones, sin nada más.';

      let actualizadas = 0;

      for (const a of alertas) {
        try {
          const texto = a.contenido ? a.contenido.slice(0, 4000) : '';

          const prompt = `
Redacta el mensaje WhatsApp para esta alerta agraria. Usa EXACTAMENTE este formato:

*Ruralicos te avisa* 🌾🚜

📄 *¿Qué ha pasado?*
[1–3 frases claras explicando la alerta. Si no hay datos: "El boletín no lo especifica."]

⚠️ *¿A quién afecta?*
[Colectivos afectados. Si no se especifica: "El boletín no lo especifica."]

📌 *Punto clave*
[Dato más relevante o plazo. Si no hay plazos: "El boletín no lo especifica."]

[1–2 emojis relevantes al tema]

🔗 Enlace al boletín completo: ${a.url}

Reglas:
- Máximo 1200 caracteres en total.
- Lenguaje sencillo para agricultores y ganaderos.
- NO inventar datos que no estén en el texto.
- Mantener EXACTAMENTE los asteriscos (*) y la estructura.

Alerta:
ID=${a.id} | Fecha=${a.fecha} | Region=${a.region} | Titulo=${a.titulo}
Texto=${texto}

Responde ÚNICAMENTE con el mensaje WhatsApp. Sin JSON, sin explicaciones, sin nada más.
`.trim();

          const borrador = await llamarIA(prompt, instructions, 'gpt-5-nano');

          if (!borrador || !borrador.trim()) {
            console.error(`[resumir] IA devolvió vacío para alerta ${a.id}`);
            continue;
          }

          const { error: updError } = await supabase
            .from('alertas')
            .update({
              estado_ia: 'pendiente_revisar',
              resumen_borrador: borrador.trim(),
            })
            .eq('id', a.id)
            .eq('estado_ia', 'pendiente_resumir');

          if (!updError) actualizadas++;
          else console.error('Error actualizando alerta', a.id, updError.message);

        } catch (errAlerta) {
          console.error(`[resumir] Error procesando alerta ${a.id}:`, errAlerta.message);
          // Se queda en pendiente_resumir para el siguiente cron
        }
      }

      res.json({
        success: true,
        procesadas: alertas.length,
        actualizadas,
        ids: alertas.map((a) => a.id),
      });

    } catch (err) {
      console.error('Error en /alertas/resumir', err);
      res.status(500).json({ error: err.message });
    }
  };

  app.post('/alertas/resumir', (req, res) => {
    if (!checkCronToken(req, res)) return;
    resumirHandler(req, res);
  });
  app.get('/alertas/resumir', (req, res) => {
    if (!checkCronToken(req, res)) return;
    resumirHandler(req, res);
  });

  // ══════════════════════════════════════════════════════════════
  // PASO 3 — /alertas/revisar
  // IA 3: revisa y aprueba (o corrige) el borrador. Guarda en resumen_final.
  // Cron recomendado: cada 5-10 minutos durante el horario de ingesta
  // ══════════════════════════════════════════════════════════════
  const revisarHandler = async (req, res) => {
    try {
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, contenido, resumen_borrador')
        .eq('estado_ia', 'pendiente_revisar')
        .order('created_at', { ascending: true })
        .limit(3);

      if (error) return res.status(500).json({ error: error.message });
      if (!alertas || alertas.length === 0) {
        return res.json({ success: true, procesadas: 0, mensaje: 'No hay borradores pendientes de revisión' });
      }

      // Mismo motivo que en resumir: texto WhatsApp con asteriscos y saltos
      // de línea rompe el JSON en lote. La IA devuelve el texto directamente.
      const instructions = 'Eres un revisor experto en comunicación agraria. Responde SOLO con el mensaje WhatsApp corregido, sin JSON, sin explicaciones, sin nada más.';

      let aprobadas = 0;

      for (const a of alertas) {
        try {
          const textoOriginal = a.contenido ? a.contenido.slice(0, 2000) : '';
          const borrador = a.resumen_borrador ?? '';

          const prompt = `
Eres un revisor de calidad para mensajes de alerta agraria.

Revisa este borrador y devuélvelo corregido si es necesario. Comprueba que:
1. Tiene exactamente esta estructura:
   - "*Ruralicos te avisa* 🌾🚜"
   - "📄 *¿Qué ha pasado?*" con 1–3 frases
   - "⚠️ *¿A quién afecta?*"
   - "📌 *Punto clave*"
   - 1–2 emojis en línea propia
   - "🔗 Enlace al boletín completo: ${a.url}"
2. No inventa datos que no estén en el texto original
3. Es claro para agricultores y ganaderos
4. Usa "El boletín no lo especifica." donde no haya datos
5. Mantiene los asteriscos (*) en los títulos de sección
6. No supera 1200 caracteres

Si está bien → devuélvelo tal cual.
Si tiene errores → corrígelo.

Texto original de la alerta:
${textoOriginal}

Borrador a revisar:
${borrador}

Responde ÚNICAMENTE con el mensaje WhatsApp final. Sin JSON, sin explicaciones, sin nada más.
`.trim();

          const resumenFinal = await llamarIA(prompt, instructions, 'gpt-5');

          if (!resumenFinal || !resumenFinal.trim()) {
            console.error(`[revisar] IA devolvió vacío para alerta ${a.id}`);
            continue;
          }

          const { error: updError } = await supabase
            .from('alertas')
            .update({
              estado_ia: 'listo',
              resumen_final: resumenFinal.trim(),
              resumen: resumenFinal.trim(), // sync para compatibilidad con whatsapp.js
            })
            .eq('id', a.id)
            .eq('estado_ia', 'pendiente_revisar');

          if (!updError) aprobadas++;
          else console.error('Error aprobando alerta', a.id, updError.message);

        } catch (errAlerta) {
          console.error(`[revisar] Error procesando alerta ${a.id}:`, errAlerta.message);
          // Se queda en pendiente_revisar para el siguiente cron
        }
      }

      res.json({
        success: true,
        procesadas: alertas.length,
        aprobadas,
        ids: alertas.map((a) => a.id),
      });

    } catch (err) {
      console.error('Error en /alertas/revisar', err);
      res.status(500).json({ error: err.message });
    }
  };

  app.post('/alertas/revisar', (req, res) => {
    if (!checkCronToken(req, res)) return;
    revisarHandler(req, res);
  });
  app.get('/alertas/revisar', (req, res) => {
    if (!checkCronToken(req, res)) return;
    revisarHandler(req, res);
  });

  // ══════════════════════════════════════════════════════════════
  // ENVÍO — /alertas/enviar-whatsapp
  // Solo envía alertas con estado_ia = 'listo'
  // Cron recomendado: 1 vez al día a la hora que quieras (ej: 08:00)
  // ══════════════════════════════════════════════════════════════
  const enviarWhatsAppHandler = async (req, res) => {
    try {
      const hoy = new Date().toISOString().slice(0, 10);

      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('*')
        .eq('fecha', hoy)
        .eq('estado_ia', 'listo')
        .or('whatsapp_enviado.is.null,whatsapp_enviado.eq.false');

      if (error) return res.status(500).json({ error: error.message });
      if (!alertas || alertas.length === 0) {
        return res.json({ success: true, enviadas: 0, mensaje: 'No hay alertas listas para enviar hoy', fecha: hoy });
      }

      let enviadas = 0;
      const errores = [];

      for (const alerta of alertas) {
        try {
          // Usamos resumen_final si existe, si no caemos a resumen por compatibilidad
          const alertaParaEnviar = {
            ...alerta,
            resumen: alerta.resumen_final || alerta.resumen,
          };

          await enviarWhatsAppResumen(alertaParaEnviar, supabase);
          await supabase.from('alertas').update({ whatsapp_enviado: true }).eq('id', alerta.id);
          enviadas++;
        } catch (err) {
          console.error('Error enviando WhatsApp para alerta', alerta.id, err);
          errores.push({ id: alerta.id, error: err.message });
        }
      }

      res.json({ success: true, fecha: hoy, total: alertas.length, enviadas, errores });

    } catch (err) {
      console.error('Error en /alertas/enviar-whatsapp', err);
      res.status(500).json({ error: err.message });
    }
  };

  app.get('/alertas/enviar-whatsapp', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarWhatsAppHandler(req, res);
  });
  app.post('/alertas/enviar-whatsapp', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarWhatsAppHandler(req, res);
  });

  // ══════════════════════════════════════════════════════════════
  // LEGACY — /alertas/procesar-ia (deprecada)
  // ══════════════════════════════════════════════════════════════
  app.post('/alertas/procesar-ia', (req, res) => {
    res.status(410).json({
      error: 'Ruta deprecada. Usa el nuevo pipeline: /alertas/clasificar → /alertas/resumir → /alertas/revisar → /alertas/enviar-whatsapp',
    });
  });
  app.get('/alertas/procesar-ia', (req, res) => {
    if (!checkCronToken(req, res)) return;
    res.status(410).json({
      error: 'Ruta deprecada. Usa el nuevo pipeline: /alertas/clasificar → /alertas/resumir → /alertas/revisar → /alertas/enviar-whatsapp',
    });
  });

};