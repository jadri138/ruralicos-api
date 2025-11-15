require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

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

// === SCRAPER BOE OFICIAL (FORMATO aaaammdd) ===
// Usa fetch global de Node 18+
// Si tu Node NO tiene fetch, luego te digo cómo arreglarlo.
app.get('/scrape-boe-oficial', async (req, res) => {
  try {
    // FECHA DE HOY EN FORMATO aaaammdd
    const hoy = new Date();
    const fecha =
      hoy.getFullYear().toString() +
      String(hoy.getMonth() + 1).padStart(2, '0') +
      String(hoy.getDate()).padStart(2, '0'); // Ej: 20251114

    const url = `https://www.boe.es/datosabiertos/api/boe/sumario/{fecha}`;

    const response = await fetch(url);

    if (response.status === 404) {
      // Día sin BOE publicado
      return res.json({
        success: true,
        nuevas: 0,
        mensaje: 'No hay BOE hoy',
        fecha
      });
    }

    if (!response.ok) {
      throw new Error(`BOE API: ${response.status}`);
    }

    const text = await response.text();

    // ---- PARCHE CASERO DEL XML ----
    // Partimos por <item> ... </item>
    const bloquesItems = text.split('<item>').slice(1); // el primer trozo es basura antes del primer <item>

    let nuevas = 0;

    const keywords =
      /ayuda|subvención|subvencion|tractor|maquinaria|pac|ganaderia|ganadería|agricultura|ley|normativa|reglamento|sancion|sanción|inspeccion|inspección|control|medio ambiente|agua|riego|sequía|sequia|incendio|forestal|ganado|pienso|fertilizante/i;

    for (const bloque of bloquesItems) {
      const itemXml = '<item>' + bloque; // por si quieres loguear el XML de cada item

      const matchTitulo = itemXml.match(/<titulo>([\s\S]*?)<\/titulo>/);
      const matchUrl = itemXml.match(/<url>([\s\S]*?)<\/url>/);
      const matchDept = itemXml.match(/<departamento>([\s\S]*?)<\/departamento>/);

      const titulo = matchTitulo ? matchTitulo[1].trim() : '';
      const urlDoc = matchUrl ? matchUrl[1].trim() : '';
      const departamento = matchDept ? matchDept[1].trim() : 'nacional';

      if (!titulo || !urlDoc) continue;

      // Filtrar por palabras clave "rural"
      if (!keywords.test(titulo)) continue;

      // Comprobar si ya existe en BD por URL
      const { data: existe, error: errorExiste } = await supabase
        .from('alertas')
        .select('id')
        .eq('url', urlDoc)
        .limit(1);

      if (errorExiste) {
        console.error('Error comprobando alerta existente:', errorExiste.message);
        continue; // no rompemos el scrape si falla una consulta
      }

      if (existe && existe.length > 0) {
        // Ya está guardada
        continue;
      }

      // Guardar alerta nueva
      const fechaISO = `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(
        6,
        8
      )}`;

      const { error: errorInsert } = await supabase.from('alertas').insert([
        {
          titulo,
          resumen: 'Procesando con IA...',
          url: urlDoc,
          fecha: fechaISO,
          region: departamento
        }
      ]);

      if (errorInsert) {
        console.error('Error insertando alerta nueva:', errorInsert.message);
        continue;
      }

      nuevas++;
    }

    const fechaISO = `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(
      6,
      8
    )}`;

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
