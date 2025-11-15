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

// === SCRAPER BOE OFICIAL (FORMATO AAAAMMDD) ===
app.get('/scrape-boe-oficial', async (req, res) => {
  try {
    // 1) Opción A: le pasas la fecha a mano por la URL: ?fecha=20240101
    let fecha = req.query.fecha;

    // 2) Opción B: si no pasas nada, usa la fecha de HOY
    if (!fecha) {
      const hoy = new Date();
      const anyo = hoy.getFullYear();               // 2024
      const mes = String(hoy.getMonth() + 1).padStart(2, '0'); // 01..12
      const dia = String(hoy.getDate()).padStart(2, '0');      // 01..31
      fecha = `${anyo}${mes}${dia}`;               // "20241115"
    }

    // La API del BOE exige EXACTAMENTE 8 números: AAAAMMDD
    if (!/^\d{8}$/.test(fecha)) {
      return res.status(400).json({
        error: 'Fecha inválida. Usa AAAAMMDD, por ejemplo 20240101',
        fecha_recibida: fecha
      });
    }

    // URL correcta del BOE (sin dominios raros)
    const url = `https://boe.es/datosabiertos/api/boe/sumario/${fecha}`;
    console.log('Llamando a BOE con fecha:', fecha, 'URL:', url);

    // Pedimos XML (es lo que ponen en la documentación oficial)
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/xml'
      }
    });

    // Si no hay BOE ese día -> 404
    if (response.status === 404) {
      const fechaISO = `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
      return res.json({
        success: true,
        nuevas: 0,
        mensaje: 'No hay BOE publicado para esta fecha',
        fecha: fechaISO
      });
    }

    // Si el BOE devuelve 400 -> fecha fuera de rango / mal
    if (response.status === 400) {
      const text = await response.text();
      console.error('Respuesta 400 del BOE:', text);
      return res.status(400).json({
        error: 'El BOE ha devuelto 400 (identificador o parámetros incorrectos)',
        fecha
      });
    }

    // Otros errores HTTP
    if (!response.ok) {
      throw new Error(`BOE API HTTP ${response.status}`);
    }

    // Si todo va bien, de momento solo comprobamos que llega XML
    const xml = await response.text();

    res.json({
      success: true,
      fecha,
      // Solo enseñamos un trocito para no petar la respuesta
      ejemploXml: xml.slice(0, 300) + '...'
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
