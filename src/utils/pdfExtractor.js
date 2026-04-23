// src/utils/pdfExtractor.js
//
// Centraliza la extracción de texto de PDFs con pdfjs-dist.
// Compartido por BOA/boaPdf.js, BOCYL/bocylScraper.js y DOE/doeScraper.js.

const pdfjsLib = require('pdfjs-dist/build/pdf.js');

async function extraerTextoPdf(bufferPdf) {
  const uint8Array = new Uint8Array(bufferPdf);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  const pdf = await loadingTask.promise;

  let texto = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    texto += content.items.map((item) => item.str).join(' ') + '\n';
  }
  return texto;
}

module.exports = { extraerTextoPdf };
