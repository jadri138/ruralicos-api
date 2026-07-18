// src/routes/bocant.js
//
// Scraper del BOC (Boletin Oficial de Cantabria).
// Cron recomendado: dias laborables a partir de las 08:30h.

const { obtenerDocumentosBocantConTexto, getFechaHoyISO } = require('../scrapers/BOCANT/bocantScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const SENALES_NEGATIVAS = [
  'ayuntamiento', 'mancomunidad',
  'presupuesto', 'modificacion de credito',
  'recurso contencioso', 'tribunal superior',
  'oposicion', 'concurso', 'bolsa de empleo', 'proceso selectivo',
  'nombramiento', 'funcionario', 'interino', 'cese',
  'matrimonio civil', 'padron', 'urbanismo',
  'tauromaquia', 'espectaculos publicos',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'agroalimentari',
  'forest', 'monte', 'medio natural',
  'politica agricola comun', 'fega', 'feaga', 'feader',
  'solicitud unica', 'subvenciones agrarias',
  'regadio', 'regad', 'riego',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'vitivinicol', 'vino', 'vinedo', 'olivar', 'frutal',
  'cereal', 'forraje', 'pasto', 'explotaci',
  'denominacion de origen', 'indicacion geografica', 'calidad alimentaria',
  'industria agroalimentaria',
  'consejeria de desarrollo rural',
  'direccion general de ganaderia',
  'direccion general de agricultura',
];

const esRuralRelevante = crearFiltroRural({ excluir: SENALES_NEGATIVAS, incluir: INCLUIR_RURAL });

module.exports = function bocantRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-bocant-oficial', '/scrape-bocant'],
    fuente: 'BOCANT',
    region: 'Cantabria',
    hoy: getFechaHoyISO,
    fechaModo: 'query',
    obtenerDocs: (fecha) => obtenerDocumentosBocantConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones BOC Cantabria en esta fecha',
      procesado: 'BOC Cantabria procesado (captura bruta + filtro rural)',
    },
  });
};
