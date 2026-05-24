// src/utils/pdfExtractor.js
//
// Centraliza la extraccion de texto de PDFs con pdf-parse.
// Compartido por BOA/boaPdf.js, BOCYL/bocylScraper.js y DOE/doeScraper.js.

const { PDFParse } = require('pdf-parse');

async function extraerTextoPdf(bufferPdf) {
  let parser;
  try {
    parser = new PDFParse({ data: Buffer.from(bufferPdf) });
    const result = await parser.getText();
    return result.text || '';
  } finally {
    if (parser && typeof parser.destroy === 'function') {
      await parser.destroy();
    }
  }
}

module.exports = { extraerTextoPdf };
