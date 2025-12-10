// src/boletines/boa/boaAlertas.js

const {
  procesarBoaDeHoy,
  procesarBoaPdf,
  dividirEnDisposiciones,
  extraerFechaBoletin,
  obtenerMlkobSumarioHoy,
} = require('./boaPdf');

// Convertir 20251205 → 2025-12-05
function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

// ===== FUNCION QUE INSERTA EN LA BD =====
async function insertarDisposicionesEnBD(disposiciones, fechaSQL, urlPdf) {
  let supabase;
  try {
    // RUTA CORRECTA DESDE src/boletines/boa
    ({ supabase } = require('../../supabaseClient'));
  } catch (err) {
    console.error('❌ Supabase no configurado en BOA:', err.message);
    return;
  }

  let nuevas = 0;

  for (const disp of disposiciones) {
    const titulo =
      disp.slice(0, 140).replace(/\s+/g, ' ').trim() || 'Disposición BOA';

    // 1️⃣ evitar duplicados (igual que el BOE)
    const { data: existe, error: errorExiste } = await supabase
      .from('alertas')
      .select('id')
      .eq('url', urlPdf)
      .eq('titulo', titulo)
      .limit(1);

    if (errorExiste) {
      console.error('❌ Error comprobando duplicado BOA:', errorExiste.message);
      continue;
    }

    if (existe && existe.length > 0) {
      console.log('Ya existe, saltando:', titulo);
      continue;
    }

    // 2️⃣ insertar en la BD
    const { error } = await supabase.from('alertas').insert([
      {
        titulo,
        resumen: 'Procesando con IA...',
        url: urlPdf,
        fecha: fechaSQL,
        region: 'Aragón',
        contenido: disp,
        fuente: 'BOA',
      },
    ]);

    if (error) {
      console.error('❌ Error insertando alerta BOA:', error.message);
      continue;
    }

    nuevas++;
  }

  console.log(`✔ Insertadas ${nuevas} disposiciones nuevas (detectadas: ${disposiciones.length})`);
}

// ===== PROCESAR BOA DE HOY =====
async function procesarBoaDeHoyEnAlertas() {
  const resultado = await procesarBoaDeHoy();
  if (!resultado) {
    console.log('⚠️ No se ha podido procesar el BOA de hoy (sin resultado)');
    return;
  }

  const { mlkob, texto, fechaBoletin } = resultado;

  const fechaSQL =
    formatearFecha(fechaBoletin) || new Date().toISOString().slice(0, 10);

  const urlPdf = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

  const disposiciones = dividirEnDisposiciones(texto);
  console.log(`📄 BOA: detectadas ${disposiciones.length} disposiciones para insertar`);

  await insertarDisposicionesEnBD(disposiciones, fechaSQL, urlPdf);
}

// ===== PROCESAR BOA FIJO (TEST) =====
async function procesarBoaPorMlkobEnAlertas(mlkob) {
  const texto = await procesarBoaPdf(mlkob);
  if (!texto) {
    console.log('⚠️ No se ha podido procesar el BOA para MLKOB fijo');
    return;
  }

  const fechaRaw = extraerFechaBoletin(texto);
  const fechaSQL =
    formatearFecha(fechaRaw) || new Date().toISOString().slice(0, 10);

  const urlPdf = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

  const disposiciones = dividirEnDisposiciones(texto);
  console.log(
    `📄 BOA (test MLKOB): detectadas ${disposiciones.length} disposiciones`
  );

  await insertarDisposicionesEnBD(disposiciones, fechaSQL, urlPdf);
}

module.exports = {
  procesarBoaDeHoyEnAlertas,
  procesarBoaPorMlkobEnAlertas,
};
