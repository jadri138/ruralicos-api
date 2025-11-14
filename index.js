require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { Parser } = require('rss-parser');
const app = express();

app.use(express.json());

// === SUPABASE ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// === RSS PARSER ===
const { Parser } = require('rss-parser');
const parser = new Parser();

// === RUTA DE PRUEBA ===
app.get('/', (req, res) => {
  res.json({ message: 'La API de Ruralicos está viva!!' });
});

// === REGISTRAR USUARIO ===
app.post('/register', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });

  const { data, error } = await supabase
    .from('users')
    .insert([{ phone, preferences: '', subscription: 'free' }])
    .select();

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Este número ya está registrado' });
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, user: data[0] });
  await supabase.from('logs').insert([{ action: 'register', details: `phone: ${phone}` }]);
});

// === CAMBIAR SUSCRIPCIÓN ===
app.post('/subscribe', async (req, res) => {
  const { phone, plan } = req.body;
  if (!phone || !['free', 'premium'].includes(plan)) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

  const { data, error } = await supabase
    .from('users')
    .update({ subscription: plan })
    .eq('phone', phone)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  if (!data.length) return res.status(404).json({ error: 'Usuario no encontrado' });

  res.json({ success: true, user: data[0] });
});

// === GUARDAR ALERTA MANUAL ===
app.post('/alertas', async (req, res) => {
  const { titulo, resumen, url, fecha, region } = req.body;
  const { data, error } = await supabase
    .from('alertas')
    .insert([{ titulo, resumen, url, fecha, region }])
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, alerta: data[0] });
});

// === LEER ALERTAS ===
app.get('/alertas', async (req, res) => {
  const { data, error } = await supabase
    .from('alertas')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: data.length, alertas: data });
});

// === SCRAPER BOE (ayudas + leyes) ===
app.get('/scrape-boe', async (req, res) => {
  try {
    const feed = await parser.parseURL('https://www.boe.es/rss/diario_boe.xml');
    let nuevas = 0;

    const keywords = /ayuda|subvenci|n|tractor|maquinaria|pac|ganader|a|agricultura|ley|normativa|reglamento|sancion|inspeccion|control|medio ambiente|agua|riego|sequía|incendio|forestal|ganado|pienso|fertilizante|cultivo|semilla|pesticida/i;

    for (const item of feed.items) {
      const titulo = item.title || '';
      const url = item.link || '';

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
        fecha: 'Pendiente',
        region: 'nacional'
      }]);

      nuevas++;
    }

    res.json({ success: true, nuevas, total: feed.items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === PROCESAR CON IA ===
app.get('/procesar-ia', async (req, res) => {
  const { data: pendientes } = await supabase
    .from('alertas')
    .select('*')
    .eq('resumen', 'Procesando con IA...');

  let procesadas = 0;
  for (const alerta of pendientes) {
    const prompt = `Eres un experto en ayudas y normativas agrícolas. Resume en 3 líneas para un agricultor:\n\nTítulo: ${alerta.titulo}\n\nExtrae:\n1. Resumen claro\n2. Fecha límite (si es ayuda) o entrada en vigor (si es ley)\n3. Región\n\nFormato:\nResumen\nPlazo: fecha\nRegión: nombre`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150
      })
    });

    const result = await response.json();
    const texto = result.choices[0].message.content;

    const resumen = texto.split('\n')[0];
    const fecha = texto.match(/Plazo: (.*)/)?.[1] || 'No especificado';
    const region = texto.match(/Región: (.*)/)?.[1] || 'nacional';

    await supabase
      .from('alertas')
      .update({ resumen, fecha, region })
      .eq('id', alerta.id);

    procesadas++;
  }

  res.json({ procesadas });
});

// === ENVÍO DESDE TU NÚMERO BUSINESS (Meta API) ===
app.get('/enviar-a-premium', async (req, res) => {
  const { data: alertas } = await supabase
    .from('alertas')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);

  if (!alertas?.length) return res.json({ message: 'No hay alertas' });

  const { data: users } = await supabase
    .from('users')
    .select('phone')
    .eq('subscription', 'premium');

  let enviados = 0;
  for (const user of users) {
    const mensaje = `${alertas[0].resumen}\nPlazo: ${alertas[0].fecha}\nRegión: ${alertas[0].region}\n🔗 ${alertas[0].url}`;

    await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: user.phone,
        type: 'text',
        text: { body: mensaje }
      })
    });
    enviados++;
  }

  res.json({ enviados, alerta: alertas[0].titulo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('API lista en puerto ' + PORT);
});
