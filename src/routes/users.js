// src/routes/users.js

module.exports = function usersRoutes(app, supabase) {
  
  // Ruta de prueba
  app.get('/', (req, res) => {
    res.json({ message: 'La API de Ruralicos esta vivaa!! 🚜' });
  });

  // Registrar usuario
  app.post('/register', async (req, res) => {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Falta el número de teléfono' });
    }

    // Insertar usuario
    const { data, error } = await supabase
      .from('users')
      .insert([{ phone, preferences: '', subscription: 'free' }])
      .select();

    if (error) {
      // Si es un duplicado (ya existe ese número)
      if (error.code === '23505') {
        return res.status(400).json({
          error: 'Este número ya está registrado'
        });
      }

      return res.status(500).json({ error: error.message });
    }

    // Devolver usuario registrado
    res.json({ success: true, user: data[0] });

    // Registrar acción en logs (esto no afecta a la respuesta)
    await supabase.from('logs').insert([
      { action: 'register', details: `phone: ${phone}` }
    ]);
  });
};
