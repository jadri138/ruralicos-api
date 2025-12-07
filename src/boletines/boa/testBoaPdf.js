// src/boletines/boa/testBoaPdf.js

const { procesarBoaPdf } = require('./boaPdf');

(async () => {
  try {
    // usa un MLKOB válido para probar
    const mlkob = '1424934780202';
    await procesarBoaPdf(mlkob);
  } catch (err) {
    console.error('Error al procesar PDF del BOA:', err.message);
  }
})();
