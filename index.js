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

// === SCRAPER BOE CON API OFICIAL ===
app.get('/scrape-boe-api', async (req, res) => {
  try {
    const response = await fetch('https://www.boe.es/api/diario_boe');
    const data = await response.json();

    let nuevas = 0;
    const keywords = /ayuda|subvención|tractor|maquinaria|pac|ganadería|agricultura|ley|normativa|reglamento|sancion|inspeccion|control|medio ambiente|agua|riego|sequía|incendio|forestal|ganado|pienso|fertilizante/i;

    for (const item of data.items) {
      const titulo = item.titulo || '';
      const url = item.enlace || '';

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
        fecha: item.fecha_publicacion || 'Pendiente',
        region: item.ambito || 'nacional'
      }]);

      nuevas++;
    }

    res.json({ success: true, nuevas, total: data.items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});