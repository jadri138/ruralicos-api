// src/utils/htmlParser.js
//
// Convierte HTML a texto plano eliminando etiquetas y entidades básicas.
// Compartido por boe.js y BOJA/bojaScraper.js.

function htmlATexto(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

module.exports = { htmlATexto };
