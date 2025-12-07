// src/boletines/boa/testBoaPartesFijo.js

const { procesarBoaPdf, dividirEnDisposiciones } = require('./boaPdf');

(async () => {
  try {
    const mlkob = '1424934780202'; // BOA concreto que sabes que funciona
    const texto = await procesarBoaPdf(mlkob);

    const partes = dividirEnDisposiciones(texto);

    console.log('Número de disposiciones detectadas:', partes.length);
    console.log('------------------------------------------');
    console.log('PRIMERA DISPOSICIÓN (recortada):\n');
    console.log(partes[0]?.slice(0, 800));
  } catch (err) {
    console.error('Error en testBoaPartesFijo:', err.message);
  }
})();
