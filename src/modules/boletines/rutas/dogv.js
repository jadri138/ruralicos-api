// src/routes/dogv.js
//
// Scraper del DOGV (Diari Oficial de la Generalitat Valenciana).
// Cron recomendado: días laborables a las 11:00–12:00h.

const { obtenerDocumentosDogvConTexto, getFechaHoyISO } = require('../scrapers/DOGV/dogvScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const SENALES_NEGATIVAS = [
  'ayuntamiento', 'ajuntament', 'diputacio', 'diputacion',
  'pressupost', 'presupuesto', 'modificacio de credits',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'edicte', 'oposicion', 'oposicio',
  'universidad', 'universitat', 'escola', 'escuela',
  'nombramiento', 'cese',
];

const INCLUIR_RURAL = [
  'agricultur', 'ramader', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'fega',
  'ayuda', 'ajuda', 'subvenci', 'bases reguladoras',
  'regadiu', 'regad', 'riego', 'agua', 'regant',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'caza', 'caca', 'mont', 'aprofitament', 'aprovechamiento',
  'vitivinicol', 'vinya', 'viñedo', 'olivar', 'fruiter', 'frutal',
  'cereal', 'forraje', 'farratge', 'bestiar', 'explotaci',
  'produccion agricola', 'produccio agricola',
  'denominacion de origen', 'denominacio d\'origen',
  'pesca', 'acuicultura',
  'conselleria de agricultura',
];

const esRuralRelevante = crearFiltroRural({ excluir: SENALES_NEGATIVAS, incluir: INCLUIR_RURAL });

module.exports = function dogvRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-dogv'],
    fuente: 'DOGV',
    region: 'Comunitat Valenciana',
    hoy: getFechaHoyISO,
    fechaModo: 'hoy',
    obtenerDocs: (fecha) => obtenerDocumentosDogvConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones DOGV hoy (festivo o fin de semana)',
      procesado: 'DOGV procesado (captura bruta + filtro rural)',
    },
  });
};
