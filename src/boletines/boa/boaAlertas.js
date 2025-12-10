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
  return `${fecha.slice(0,4)}-${fecha.slice(4,6)}-${fecha.slice(6,8)}`;
}

// ===== FUNCION QUE INSERTA EN LA BD =====
async function insertarDisposicionesEnBD(disposiciones, fechaSQL, urlPdf) {
  let supabase;
  try {
    ({ supabase } = require('../../supabaseClient'));
  } catch (err) {
    console.error("❌ Supabase no configurado:", err.message);
    return;
  }

  for (const disp of disposiciones) {
    const titulo = disp.slice(0, 140).replace(/\s+/g, ' ').trim() || "Disposición BOA";

    // 1️⃣ evitar duplicados (IGUAL QUE EL BOE)
    const { data: existe, error: errorExiste } = await supabase
      .from("alertas")
      .select("id")
      .eq("url", urlPdf)
      .eq("titulo", titulo)
      .limit(1);

    if (errorExiste) {
      console.error("❌ Error comprobando duplicado BOA:", errorExiste.message);
      continue;
    }

    if (existe && existe.length > 0) {
      console.log("Ya existe, saltando:", titulo);
      continue;
    }

    // 2️⃣ insertar en la BD (MISMA ESTRUCTURA QUE EL BOE)
    const { error } = await supabase.from("alertas").insert([
      {
        titulo,
        resumen: "Procesando con IA...",
        url: urlPdf,
        fecha: fechaSQL,
        region: "Aragón",
        contenido: disp,
        fuente: "BOA" // saber de dónde viene
      }
    ]);

    if (error) {
      console.error("❌ Error insertando alerta BOA:", error.message);
    }
  }

  console.log(`✔ Insertadas ${disposiciones.length} disposiciones`);
}


// ===== PROCESAR BOA DE HOY =====
async function procesarBoaDeHoyEnAlertas() {
  // 1) Descargar y validar que el PDF es el de HOY
  const texto = await procesarBoaDeHoy();
  if (!texto) {
    console.log('⚠️ No se ha podido procesar el BOA de hoy (no hay texto válido)');
    return;
  }

  const fechaRaw = extraerFechaBoletin(texto);
  const fechaSQL = formatearFecha(fechaRaw);

  // 2) Obtener MLKOB (puede ser null si algo falla)
  const mlkob = await obtenerMlkobSumarioHoy();
  if (!mlkob) {
    console.log('⚠️ No se ha podido obtener el MLKOB en procesarBoaDeHoyEnAlertas');
    return;
  }

  const urlPdf = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

  // 3) Trocear en disposiciones
  const disposiciones = dividirEnDisposiciones(texto);

  // 4) Insertar en BD
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
  const fechaSQL = formatearFecha(fechaRaw);

  const urlPdf = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

  const disposiciones = dividirEnDisposiciones(texto);

  await insertarDisposicionesEnBD(disposiciones, fechaSQL, urlPdf);
}

module.exports = {
  procesarBoaDeHoyEnAlertas,
  procesarBoaPorMlkobEnAlertas
};
