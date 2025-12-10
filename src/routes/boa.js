// src/routes/boa.js
const { checkCronToken } = require('../utils/checkCronToken');
const {
  procesarBoaDeHoyEnAlertas,
} = require('../boletines/boa/boaAlertas');

module.exports = function boaRoutes(app, supabase) {
  app.get('/scrape-boa-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      await procesarBoaDeHoyEnAlertas();

      return res.json({
        success: true,
        mensaje: 'BOA procesado e insertado en alertas',
      });
    } catch (e) {
      console.error('Error en /scrape-boa-oficial', e);
      return res.status(500).json({ error: e.message });
    }
  });
};
