// src/boletines/testBoaPdf.js
const { procesarBoaPdf } = require('./boa/boaPdf');

async function main() {
  try {
    // 👇 PON AQUÍ el MLKOB del sumario que tú sabes
    const mlkob = '1424934780202';

    await procesarBoaPdf(mlkob);
  } catch (err) {
    console.error('Error al procesar PDF del BOA:', err.message);
  }
}

main();
