// src/routes/boib.js
//
// Scraper del BOIB (Boletin Oficial de las Illes Balears).
// Cron recomendado: dias laborables a partir de las 08:30h.

const { obtenerDocumentosBoibConTexto, getFechaHoyISO } = require('../scrapers/BOIB/boibScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'ajuntament', 'consell insular',
  'presupuesto', 'pressupost', 'modificacion de credito', 'modificacio de credit',
  'recurso contencioso', 'tribunal superior',
  'oposicion', 'concurs', 'bolsa', 'borsa',
  'nombramiento', 'nomenament', 'funcionario', 'funcionari', 'interino', 'interi', 'cese',
  'ordenanza fiscal', 'taxi', 'turismo', 'hotel',
];

const INCLUIR_RURAL = [
  'agricultur', 'ramader', 'ganader', 'agrari', 'agroalimentari', 'rural',
  'forest', 'monte', 'mont', 'medio natural', 'medi natural',
  'politica agricola comun', 'pac', 'fega', 'feaga', 'feader',
  'solicitud unica', 'sol.licitud unica', 'subvenciones agrarias', 'ajudes agraries',
  'regadio', 'regadiu', 'regad', 'riego', 'aigua agricola',
  'fitosanit', 'zoosanit', 'sanidad animal', 'sanitat animal', 'plaga',
  'vitivinicol', 'vino', 'vinedo', 'vinya', 'olivar', 'ametller', 'garrover',
  'cereal', 'forraje', 'farratge', 'pasto', 'pastura', 'explotaci',
  'denominacion de origen', 'denominacio d origen', 'indicacion geografica',
  'calidad alimentaria', 'qualitat alimentaria',
  'industria agroalimentaria',
  'conselleria de agricultura', 'conselleria d agricultura',
];

const esRuralRelevante = crearFiltroRural({ excluir: EXCLUIR_FUERTE, incluir: INCLUIR_RURAL });

module.exports = function boibRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-boib-oficial', '/scrape-boib'],
    fuente: 'BOIB',
    region: 'Illes Balears',
    hoy: getFechaHoyISO,
    fechaModo: 'query',
    obtenerDocs: (fecha) => obtenerDocumentosBoibConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones BOIB en el ultimo boletin',
      procesado: 'BOIB procesado (captura bruta + filtro rural)',
    },
  });
};
