// src/boletines/boa/testBoaAlertas.js
require('dotenv').config();

const { procesarBoaPorMlkobEnAlertas } = require('./boaAlertas');

(async () => {
  try {
    const mlkob = '1424934780202'; // el BOA fijo que ya te funciona
    await procesarBoaPorMlkobEnAlertas(mlkob);
  } catch (err) {
    console.error('Error procesando alertas BOA (fijo):', err.message);
  }
})();
