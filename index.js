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
  if (error.code === '23505') { // Código de duplicado en PostgreSQL
    return res.status(400).json({ error: 'Este número ya está registrado' });
  }
  return res.status(500).json({ error: error.message });
}

  res.json({ success: true, user: data[0] });
  // LOG: registro de usuario
await supabase.from('logs').insert([{ action: 'register', details: `phone: ${phone}` }]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('API lista en puerto ' + PORT);
});
// Ruta para guardar una alerta del BOE
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
app.get('/scrape-boe-oficial', async (req, res) => {
  try {
    // FECHA DE HOY EN FORMATO aaaammdd
    const hoy = new Date();
    const fecha = hoy.getFullYear() +
                  String(hoy.getMonth() + 1).padStart(2, '0') +
                  String(hoy.getDate()).padStart(2, '0'); // Ej: 20251114

    const url = `https://datosabiertos.boe.es/api/boe/sumario/${fecha}`;

    const response = await fetch(url);
    
    if (response.status === 404) {
      return res.json({ success: true, nuevas: 0, mensaje: "No hay BOE hoy", fecha });
    }
    if (!response.ok) throw new Error(`BOE API: ${response.status}`);

    const text = await response.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "application/xml");
    
    let nuevas = 0;
    const keywords = /ayuda|subvención|tractor|maquinaria|pac|ganaderia|agricultura|ley|normativa|reglamento|sancion|inspeccion|control|medio ambiente|agua|riego|sequía|incendio|forestal|ganado|pienso|fertilizante/i;

    const items = xml.querySelectorAll('item');
    for (const item of items) {
      const titulo = item.querySelector('titulo')?.textContent || '';
      const url = item.querySelector('url')?.textContent || '';

      if (!keywords.test(titulo)) continue;

      const { data: existe } = await supabase
        .from('alertas')
        .select('id')
        .eq('url', url)
        .limit(1);

      if (existe?.length > 0) continue;

      await supabase.from('alertas').insert([{
        titulo,
        resumen: 'Procesando con IA...',
        url,
        fecha: `${fecha.slice(0,4)}-${fecha.slice(4,6)}-${fecha.slice(6,8)}`,
        region: item.querySelector('departamento')?.textContent || 'nacional'
      }]);

      nuevas++;
    }

    res.json({ success: true, nuevas, fecha: `${fecha.slice(0,4)}-${fecha.slice(4,6)}-${fecha.slice(6,8)}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});