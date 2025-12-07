// src/boletines/boaAlertas.js
const { procesarBoaDeHoy } = require('./boaPdf');
// 👇 cambia esta ruta si tu pool está en otro sitio
const pool = require('../db'); 

// 1) Separar el texto del BOA en “disposiciones”
function dividirEnDisposiciones(texto) {
  const patrones = [
    /ORDEN\s+[A-ZÁÉÍÓÚ0-9\/\-]+/g,
    /RESOLUCIÓN\s+de\s+/g,
    /ANUNCIO\s+de\s+/g,
    /DEPARTAMENTO\s+DE\s+[A-ZÁÉÍÓÚÑ ]+/g
  ];

  const regex = new RegExp(patrones.map(p => p.source).join('|'), 'g');

  const indices = [];
  let match;
  while ((match = regex.exec(texto)) !== null) {
    indices.push(match.index);
  }

  if (indices.length === 0) return [texto];

  const disposiciones = [];
  for (let i = 0; i < indices.length; i++) {
    const inicio = indices[i];
    const fin = indices[i + 1] ?? texto.length;
    const bloque = texto.slice(inicio, fin).trim();
    if (bloque.length > 50) {
      disposiciones.push(bloque);
    }
  }

  return disposiciones;
}

// 2) Llamar a la IA para convertir una disposición en “alerta Ruralicos”
async function clasificarConIA(textoDisposicion) {
  // 🔴 AQUÍ USAS LA MISMA FUNCIÓN / PROMPT QUE YA USAS PARA EL BOE
  // Ejemplo genérico:
  //
  // const resultado = await llamarIA(textoDisposicion);
  //
  // Debe devolverte algo así:
  // {
  //   titulo: '...',
  //   resumen: '...',
  //   provincia: 'Zaragoza',
  //   sector: 'ganaderia',
  //   subsector: 'porcino',
  //   url_pdf: 'https://....pdf',
  //   esRelevante: true | false
  // }

  // De momento devolvemos null como “plantilla”
  return null;
}

// 3) Guardar una alerta en la BD (ajusta nombres de columnas)
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

  await pool.query(
    `INSERT INTO alertas 
      (fuente, titulo, resumen, provincia, sector, subsector, url_pdf, fecha_boletin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT DO NOTHING`,
    [fuente, titulo, resumen, provincia, sector, subsector, url_pdf, fechaBoletin]
  );
}

// 4) Función principal: procesa el BOA de hoy y crea alertas
async function procesarBoaDeHoyEnAlertas() {
  const texto = await procesarBoaDeHoy();
  if (!texto) {
    // procesarBoaDeHoy ya controla fin de semana / sin boletín
    return;
  }

  const disposiciones = dividirEnDisposiciones(texto);
  console.log('Disposiciones detectadas en BOA de hoy:', disposiciones.length);

  // TODO: saca fechaBoletin del texto, igual que en boaPdf extraes BOA20251205
  const matchFecha = texto.match(/BOA(\d{8})/);
  const fechaBoletin = matchFecha ? matchFecha[1] : null;

  for (const disp of disposiciones) {
    const alerta = await clasificarConIA(disp);
    if (!alerta || !alerta.esRelevante) continue;

    await guardarAlertaEnBD(alerta, fechaBoletin);
  }
}

module.exports = {
  procesarBoaDeHoyEnAlertas,
  dividirEnDisposiciones,
};
