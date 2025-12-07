// src/boletines/boa/boaAlertas.js

const {
  procesarBoaDeHoy,
  dividirEnDisposiciones,
  extraerFechaBoletin,
} = require('./boaPdf');

// ⚠️ NO cargamos supabaseClient arriba del todo
// porque en los tests a veces no tienes SUPABASE_URL configurado
// y no quieres que reviente todo.

// 1) Llamar a la IA para convertir una disposición en "alerta Ruralicos"
async function clasificarConIA(textoDisposicion) {
  // Aquí deberías usar la MISMA lógica de IA que ya tienes para el BOE.
  // De momento lo dejamos como plantilla que nunca marca nada como relevante
  // para no llenar la BD mientras pruebas.

  return {
    esRelevante: false,
    titulo: null,
    resumen: null,
    provincia: null,
    sector: null,
    subsector: null,
    url_pdf: null,
  };
}

// 2) Guardar una alerta en Supabase
async function guardarAlertaEnBD(alerta, fechaBoletin) {
  // Cargamos Supabase SOLO aquí, y con try/catch
  let supabase;
  try {
    ({ supabase } = require('../../supabaseClient'));
  } catch (err) {
    console.error('Supabase no configurado, NO se guarda alerta en BD:', err.message);
    return;
  }

  const { titulo, resumen, provincia, sector, subsector, url_pdf } = alerta;

  const fuente = 'BOA';

  const { error } = await supabase.from('alertas').insert({
    fuente,
    titulo,
    resumen,
    provincia,
    sector,
    subsector,
    url_pdf,
    fecha_boletin: fechaBoletin,
  });

  if (error) {
    console.error('Error guardando alerta BOA en BD:', error.message);
  }
}

// 3) Función principal: BOA de hoy → disposiciones → IA → BD
async function procesarBoaDeHoyEnAlertas() {
  const texto = await procesarBoaDeHoy();
  if (!texto) {
    // procesarBoaDeHoy ya controla si no hay BOA nuevo
    console.log('No hay BOA nuevo hoy. No se crean alertas.');
    return;
  }

  const fechaBoletin = extraerFechaBoletin(texto) || null;
  console.log('Fecha boletín BOA detectada:', fechaBoletin);

  const disposiciones = dividirEnDisposiciones(texto);
  console.log('Disposiciones detectadas en BOA de hoy:', disposiciones.length);

  for (const disp of disposiciones) {
    const alerta = await clasificarConIA(disp);

    if (!alerta || !alerta.esRelevante) {
      continue; // saltamos las que la IA no considere relevantes
    }

    await guardarAlertaEnBD(alerta, fechaBoletin);
  }

  console.log('Fin de procesar alertas BOA de hoy.');
}

module.exports = {
  procesarBoaDeHoyEnAlertas,
};
