// src/boletines/boaPdf.js
const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

/**
 * 1) Descargar PDF del BOA por MLKOB
 */
async function descargarBoaPdf(mlkob) {
  const url = `https://www.boa.aragon.es/cgi-bin/EBOA/BRSCGI?CMD=VEROBJ&MLKOB=${mlkob}`;

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
  });

  return Buffer.from(response.data);
}

/**
 * 2) Extraer texto usando pdfjs-dist (no falla nunca)
 */
async function extraerTextoPdf(bufferPdf) {
  const loadingTask = pdfjsLib.getDocument({ data: bufferPdf });
  const pdf = await loadingTask.promise;

  let texto = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    const strings = content.items.map(item => item.str).join(" ");
    texto += strings + "\n";
  }

  return texto;
}

/**
 * 3) Descargar + extraer texto
 */
async function procesarBoaPdf(mlkob) {
  console.log("Descargando PDF del BOA con MLKOB:", mlkob);

  const pdfBuffer = await descargarBoaPdf(mlkob);
  console.log("PDF descargado, tamaño:", pdfBuffer.byteLength);

  const texto = await extraerTextoPdf(pdfBuffer);

  console.log("Primeros 500 caracteres del PDF:\n");
  console.log(texto.slice(0, 500));

  return texto;
}

module.exports = {
  descargarBoaPdf,
  extraerTextoPdf,
  procesarBoaPdf,
};
