// src/boletines/testBoaJSON.js
const {
  descargarBoaJSONUltimos,
  fetchBoaJsonRaw,
} = require('./boa');

async function main() {
  try {
    // 1) Primero vemos el texto bruto (por si el JSON viene “raro”)
    const raw = await fetchBoaJsonRaw();
    console.log('=== RAW (primeros 300 caracteres) ===');
    console.log(raw.slice(0, 300));
    console.log('=====================================');

    // 2) Ahora intentamos parsear
    const data = await descargarBoaJSONUltimos();

    console.log('Tipo de data:', typeof data);
    console.log('¿Es array?:', Array.isArray(data));

    if (Array.isArray(data)) {
      console.log('Longitud del array:', data.length);
      if (data.length > 0) {
        console.log('Primera fila del array:');
        console.log(data[0]);
      }
    } else {
      console.log('Claves del objeto:');
      console.log(Object.keys(data));

      // Intentar detectar dónde están las filas
      const posibles = ['rows', 'filas', 'data', 'result', 'RESULT', 'ROWSET'];
      for (const key of posibles) {
        if (data[key]) {
          console.log(
            `Encontrado campo "${key}" con`,
            Array.isArray(data[key]) ? data[key].length : 'tipo',
            typeof data[key]
          );
          if (Array.isArray(data[key]) && data[key].length > 0) {
            console.log('Ejemplo de fila:');
            console.log(data[key][0]);
          }
        }
      }
    }
  } catch (err) {
    console.error('Error en testBoaJSON:', err.message);
  }
}

main();
