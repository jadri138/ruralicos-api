// src/boletines/boa/testBoaPartes.js

const { procesarBoaDeHoy, dividirEnDisposiciones } = require('./boaPdf');

(async () => {
  try {
    const texto = await procesarBoaDeHoy();
    if (!texto) {
      console.log('Hoy no hay BOA nuevo, no se trocea nada.');
      return;
    }

    const partes = dividirEnDisposiciones(texto);

    console.log('Número de disposiciones detectadas:', partes.length);
    console.log('------------------------------------------');
    console.log('PRIMERA DISPOSICIÓN (recortada):\n');
    console.log(partes[0]?.slice(0, 800));
  } catch (err) {
    console.error('Error en testBoaPartes:', err.message);
  }
})();
