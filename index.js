require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');
const xmlParser = new XMLParser({ ignoreAttributes: false });

const app = express();
app.use(express.json());

// Conectar Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({ message: 'La API de Ruralicos esta vivaa!! 🚜' });
});

// Ruta para registrar usuario
app.post('/register', async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Falta el número de teléfono' });
  }

  const { data, error } = await supabase
    .from('users')
    .insert([{ phone, preferences: '', subscription: 'free' }])
    .select();

  if (error) {
    // Código de duplicado en PostgreSQL
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Este número ya está registrado' });
    }
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, user: data[0] });

  // LOG: registro de usuario (si falla el log no rompemos la respuesta)
  await supabase.from('logs').insert([
    { action: 'register', details: `phone: ${phone}` }
  ]);
});

// Ruta para guardar una alerta del BOE (manual, para pruebas)
app.post('/alertas', async (req, res) => {
  const { titulo, resumen, url, fecha, region } = req.body;

  const { data, error } = await supabase
    .from('alertas')
    .insert([{ titulo, resumen, url, fecha, region }])
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, alerta: data[0] });
});

// Ruta para LEER todas las alertas del BOE
app.get('/alertas', async (req, res) => {
  const { data, error } = await supabase
    .from('alertas')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    count: data.length,
    alertas: data
  });
});

// === SCRAPER BOE OFICIAL (FORMATO AAAAMMDD) ===
app.get('/scrape-boe-oficial', async (req, res) => {
  try {
    // 1) Si pasas ?fecha=AAAAMMDD la usa; si no, usa HOY
    let fecha = req.query.fecha;
    if (!fecha) {
      const hoy = new Date();
      const anyo = hoy.getFullYear();
      const mes = String(hoy.getMonth() + 1).padStart(2, '0');
      const dia = String(hoy.getDate()).padStart(2, '0');
      fecha = `${anyo}${mes}${dia}`; // "20251115"
    }

    // Comprobar que la fecha tiene formato correcto
    if (!/^\d{8}$/.test(fecha)) {
      return res.status(400).json({
        error: 'Fecha inválida. Usa AAAAMMDD, por ejemplo 20240101',
        fecha_recibida: fecha
      });
    }

    const fechaISO = `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;

    // 2) Llamada correcta al BOE
    const url = `https://boe.es/datosabiertos/api/boe/sumario/${fecha}`;
    console.log('Llamando a BOE con fecha:', fecha, 'URL:', url);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/xml'
      }
    });

    // Si no hay BOE ese día
    if (response.status === 404) {
      return res.json({
        success: true,
        nuevas: 0,
        mensaje: 'No hay BOE publicado para esta fecha',
        fecha: fechaISO
      });
    }

    // Otros errores HTTP
    if (!response.ok) {
      const text = await response.text();
      console.error('Error HTTP del BOE:', response.status, text);
      throw new Error(`BOE API HTTP ${response.status}`);
    }

    // 3) Convertimos el XML a objeto JS
    const xml = await response.text();
    const json = xmlParser.parse(xml);

    const sumario = json?.response?.data?.sumario;
    if (!sumario) {
      return res.json({
        success: true,
        nuevas: 0,
        mensaje: 'No se ha encontrado nodo <sumario> en el XML',
        fecha: fechaISO
      });
    }

    // Helper para convertir cosas sueltas en array
    const toArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);

    let diarios = toArray(sumario.diario);

    let nuevas = 0;

    // Palabras clave "rurales"
    const keywords =
      /ayuda|subvenci[oó]n|tractor|maquinaria|pac|ganader[ií]a|ganadero|agricultura|explotaci[oó]n|riego|regad[ií]o|incendio forestal|fertilizante|pienso|semilla|ganado|seguro agrario|forestal|suelo r[uú]stico/i;

    // 4) Recorremos diario → seccion → departamento → epigrafe/item
    for (const diario of diarios) {
      const secciones = toArray(diario.seccion);

      for (const seccion of secciones) {
        const departamentos = toArray(seccion.departamento);

        for (const dept of departamentos) {
          const nombreDept =
            dept['@_nombre'] || dept.nombre || 'NACIONAL';

          const epigrafes = toArray(dept.epigrafe);
          const gruposItems = [];

          // Items dentro de cada epígrafe
          for (const epi of epigrafes) {
            const itemsEpi = toArray(epi.item);
            if (itemsEpi.length) gruposItems.push(itemsEpi);
          }

          // Items directamente colgando de departamento
          const itemsDept = toArray(dept.item);
          if (itemsDept.length) gruposItems.push(itemsDept);

          // 5) Recorremos todos los items
          for (const grupo of gruposItems) {
            for (const item of grupo) {
              if (!item) continue;

              const titulo = item.titulo;
              const url_pdf = item.url_pdf;

              if (!titulo || !url_pdf) continue;

              // Filtrar por palabras clave
              if (!keywords.test(titulo)) continue;

              // ¿Ya existe en la tabla alertas por URL?
              const { data: existe, error: errorExiste } = await supabase
                .from('alertas')
                .select('id')
                .eq('url', url_pdf)
                .limit(1);

              if (errorExiste) {
                console.error(
                  'Error comprobando alerta existente:',
                  errorExiste.message
                );
                continue;
              }

              if (existe && existe.length > 0) {
                // Ya estaba guardada, la saltamos
                continue;
              }

              // Insertamos alerta nueva
              const { error: errorInsert } = await supabase.from('alertas').insert([
                {
                  titulo,
                  resumen: 'Procesando con IA...',
                  url: url_pdf,
                  fecha: fechaISO,
                  region: nombreDept
                }
              ]);

              if (errorInsert) {
                console.error('Error insertando alerta nueva:', errorInsert.message);
                continue;
              }

              nuevas++;
            }
          }
        }
      }
    }

    // 6) Respuesta final
    res.json({
      success: true,
      nuevas,
      fecha: fechaISO
    });
  } catch (err) {
    console.error('Error en /scrape-boe-oficial:', err);
    res.status(500).json({ error: err.message });
  }
});



// Arrancar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('API lista en puerto ' + PORT);
});
