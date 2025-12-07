// src/boletines/boa/boaAlertas.js
const {
  procesarBoaDeHoy,
  dividirEnDisposiciones,
  extraerFechaBoletin,
} = require('./boaPdf');

// 👇 ajusta la ruta si tu supabaseClient está en otro sitio
const supabase = require('../../supabaseClient');

// 1) Llamar a la IA para convertir una disposición en "alerta Ruralicos"
async function clasificarConIA(textoDisposicion) {
  // 🧠 AQUÍ tienes que usar la MISMA lógica que ya tengas para el BOE:
  //
  // - Mandar `textoDisposicion` a tu IA (OpenAI, tu API, etc.)
  // - Recibir algo tipo:
  //   {
  //     esRelevante: true/false,
  //     titulo: '...',
  //     resumen: '...',
  //     provincia: 'Zaragoza',
  //     sector: 'ganaderia',
  //     subsector: 'porcino',
  //     url_pdf: 'https://www.boa.aragon.es/...',
  //   }
  //
  // De momento dejo una "plantilla" que NO guarda nada para que no ensucies la BD
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
  const {
    titulo,
    resumen,
    provincia,
    sector,
    subsector,
    url_pdf,
  } = alerta;

  const fuente = 'BOA';

  const { error } = await supabase
    .from('alertas')
    .insert({
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
