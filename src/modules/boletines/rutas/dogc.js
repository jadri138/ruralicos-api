// src/routes/dogc.js
//
// Scraper del DOGC (Diari Oficial de la Generalitat de Catalunya).
// Cron recomendado: días laborables a las 10:00–11:00h.

const { obtenerDocumentosDogcConTexto, getFechaHoyISO } = require('../scrapers/DOGC/dogcScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'ajuntament', 'diputacio', 'diputacion',
  'pressupost', 'presupuesto', 'modificacio de credits',
  'recurs contenciós', 'tribunal superior de justicia',
  'edicte', 'edicto', 'oposicio', 'oposicion',
  'universitat', 'universidad', 'escola', 'escuela',
];

const INCLUIR_RURAL = [
  'agricultur', 'ramader', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'fega',
  'ajuda', 'ayuda', 'subvenci', 'subvenc', 'bases reguladores',
  'regadiu', 'regad', 'riego', 'aigua', 'agua', 'regant',
  'fitosanit', 'zoosanit', 'sanitat animal', 'sanidad animal', 'plaga',
  'caca', 'caza', 'mont', 'aprofitament', 'aprovechamiento',
  'vitivinicola', 'vinya', 'viñedo', 'olivar', 'fruiter', 'frutal',
  'cereal', 'farratge', 'forraje', 'bestiar', 'explotaci',
  'produccio agricola', 'produccion agricola',
  'denominaci d\'origen', 'denominacion de origen',
];

const esRuralRelevante = crearFiltroRural({ excluir: EXCLUIR_FUERTE, incluir: INCLUIR_RURAL });

module.exports = function dogcRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-dogc'],
    fuente: 'DOGC',
    region: 'Catalunya',
    hoy: getFechaHoyISO,
    fechaModo: 'hoy',
    obtenerDocs: (fecha) => obtenerDocumentosDogcConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones DOGC hoy (festivo o fin de semana)',
      procesado: 'DOGC procesado (Socrata + captura bruta + filtro rural)',
    },
  });
};
