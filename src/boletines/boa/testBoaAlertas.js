const { procesarBoaDeHoyEnAlertas } = require('./boaAlertas');

(async () => {
  try {
    await procesarBoaDeHoyEnAlertas();
  } catch (err) {
    console.error('Error procesando alertas BOA:', err.message);
  }
})();
