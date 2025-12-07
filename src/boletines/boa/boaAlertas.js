// src/boletines/boa/boaAlertas.js

const {
  procesarBoaDeHoy,
  procesarBoaPdf,
  dividirEnDisposiciones,
  extraerFechaBoletin,
  obtenerMlkobSumarioHoy,
} = require('./boaPdf');

// 🔹 Función auxiliar para formatear fecha a YYYY-MM-DD
function formatearFechaYYYYMMDDaSQL(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  const year = fecha.slice(0, 4);
  const month = fecha.slice(4, 6);
  const day = fecha.slice(6, 8);
  return `${year}-${month}-${day}`;
}

// 🔹 Inserta en la tabla "alertas" usando la MISMA estructura que el BOE
async function insertarDisposicionesEnAlertas(disposiciones, fechaBoletinSQL, urlPdf) {
  let supabase;
  try {
    ({ supabase } = require('../../supabaseClient'));
  } catch (err) {
    console.error('Supabase no configurado, NO se guardan alertas BOA:', err.message);
    return;
  }

  for (const disp of disposiciones) {
    const tituloProvisional = disp.slice(0, 140).replace(/\s+/g, ' ').trim();

    const { error } = await supabase
      .from('alertas')
      .insert({
        fuente: 'BOA',
        titulo: tituloProvisional || 'Disposición BOA',
        resumen: 'Procesando con IA...',   // Igual que haces con el BOE
        url: urlPdf || null,
        fecha: fechaBoletinSQL,            // formato YYYY-MM-DD
        region: 'Aragón',                  // la IA ya sacará provincias concretas
        contenido: disp,                   // texto completo de la disposición
      });

    if (error) {
      console.error('Error guardando disposición BOA en alertas:', error.message);
    }
  }

  console.log(`Insertadas ${disposiciones.length} disposiciones BOA en la tabla alertas.`);
}

// 1) BOA de HOY → trocear → insertar en alertas
async function procesarBoaDeHoyEnAlertas() {
  const texto = await procesarBoaDeHoy();
  if (!texto) {
    console.log('No hay BOA nuevo hoy. No se crean alertas.');
    return;
  }

  const fechaBoletinRaw = extraerFechaBoletin(texto) || null;
  const fechaBoletinSQL = formatearFechaYYYYMMDDaSQL(fechaBoletinRaw);
  console.log('Fecha boletín BOA detectada:', fechaBoletinRaw, '→', fechaBoletinSQL);

  // volvemos a pedir el MLKOB solo para construir la URL del PDF
  let urlPdf = null;
  try {
    const mlkob = await obtenerMlkobSumarioHoy();
    urlPdf = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;
  } catch (err) {
    console.error('No se pudo obtener MLKOB para construir URL PDF BOA:', err.message);
  }

  const disposiciones = dividirEnDisposiciones(texto);
  console.log('Disposiciones detectadas en BOA de hoy:', disposiciones.length);

  await insertarDisposicionesEnAlertas(disposiciones, fechaBoletinSQL, urlPdf);

  console.log('Fin de procesar BOA de hoy en alertas.');
}

// 2) BOA por MLKOB (para pruebas) → trocear → insertar en alertas
async function procesarBoaPorMlkobEnAlertas(mlkob) {
  const texto = await procesarBoaPdf(mlkob);

  const fechaBoletinRaw = extraerFechaBoletin(texto) || null;
  const fechaBoletinSQL = formatearFechaYYYYMMDDaSQL(fechaBoletinRaw);
  console.log('Fecha boletín BOA detectada (fijo):', fechaBoletinRaw, '→', fechaBoletinSQL);

  const urlPdf = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

  const disposiciones = dividirEnDisposiciones(texto);
  console.log('Disposiciones detectadas en BOA (fijo):', disposiciones.length);

  await insertarDisposicionesEnAlertas(disposiciones, fechaBoletinSQL, urlPdf);

  console.log('Fin de procesar BOA fijo en alertas.');
}

module.exports = {
  procesarBoaDeHoyEnAlertas,
  procesarBoaPorMlkobEnAlertas,
};
