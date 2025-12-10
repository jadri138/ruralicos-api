const {
  procesarBoaDeHoy,
  extraerFechaBoletin,
  dividirEnDisposiciones,
} = require("./boaPdf");

// Convertir 20251205 → 2025-12-05
function formatearFecha(fecha) {
  if (!fecha || fecha.length !== 8) return null;
  return `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
}

// =====================
// INSERTAR EN BD
// =====================
async function insertarDisposicionesEnBD(disposiciones, fechaSQL, urlPdf) {
  const { supabase } = require("../../supabaseClient");

  for (const disp of disposiciones) {
    const titulo =
      disp.slice(0, 140).replace(/\s+/g, " ").trim() || "Disposición BOA";

    // evitar duplicados
    const { data: existe } = await supabase
      .from("alertas")
      .select("id")
      .eq("url", urlPdf)
      .eq("titulo", titulo)
      .limit(1);

    if (existe && existe.length > 0) {
      console.log("Ya existe, saltando:", titulo);
      continue;
    }

    const { error } = await supabase.from("alertas").insert([
      {
        titulo,
        resumen: "Procesando con IA...",
        url: urlPdf,
        fecha: fechaSQL,
        region: "Aragón",
        contenido: disp,
        fuente: "BOA",
      },
    ]);

    if (error) console.error("❌ Error insertando:", error.message);
  }
}

// =====================
// 🚀 PROCESAR BOA HOY
// =====================
async function procesarBoaDeHoyEnAlertas() {
  const resultados = await procesarBoaDeHoy();

  if (!resultados.length) {
    console.log("⚠️ No hay BOA hoy");
    return;
  }

  for (const { mlkob, texto } of resultados) {
    const fechaRaw = extraerFechaBoletin(texto);
    const fechaSQL = formatearFecha(fechaRaw);
    const urlPdf = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;
    const disposiciones = dividirEnDisposiciones(texto);

    console.log(`📌 Insertando ${disposiciones.length} disposiciones`);
    await insertarDisposicionesEnBD(disposiciones, fechaSQL, urlPdf);
  }
}

module.exports = {
  procesarBoaDeHoyEnAlertas,
};
