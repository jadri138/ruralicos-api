const { procesarBoaDeHoyEnAlertas } = require('./boaAlertas');

(async () => {
  try {
    await procesarBoaDeHoyEnAlertas();
    console.log('Fin procesar BOA de hoy.');
  } catch (err) {
    console.error('Error procesando alertas BOA:', err.message);
  }
})();
