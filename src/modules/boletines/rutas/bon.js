// src/routes/bon.js
//
// Scraper del BON (Boletin Oficial de Navarra).
// Cron recomendado: dias laborables a partir de las 08:30h.

const { obtenerDocumentosBonConTexto } = require('../scrapers/BON/bonScraper');
const { getFechaMadridISO } = require('../../../shared/fechaMadrid');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const SENALES_NEGATIVAS = [
  'ayuntamiento', 'concejo', 'mancomunidad',
  'presupuesto', 'plantilla organica',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'notificacion', 'recaudacion ejecutiva', 'providencia de apremio',
  'diligencia de embargo', 'herencia yacente', 'padron municipal',
  'oposicion', 'convocatoria para la provision', 'lista definitiva',
  'universidad', 'nombramiento', 'nombra', 'interino', 'cese',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'monte', 'politica agricola comun', 'fega', 'feaga', 'feader',
  'regadio', 'regad', 'riego', 'agua',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'aprovechamiento forestal', 'aprovechamientos forestales',
  'vitivinicol', 'vino', 'vinedo', 'olivar', 'frutal',
  'cereal', 'forraje', 'pasto', 'explotaci',
  'denominacion de origen', 'calidad alimentaria',
  'industria agroalimentaria', 'agroalimentari',
  'desarrollo rural', 'medio rural',
  'departamento de desarrollo rural',
];

const esRuralRelevante = crearFiltroRural({ excluir: SENALES_NEGATIVAS, incluir: INCLUIR_RURAL });

module.exports = function bonRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-bon-oficial', '/scrape-bon'],
    fuente: 'BON',
    region: 'Navarra',
    hoy: getFechaMadridISO,
    fechaModo: 'query',
    obtenerDocs: (fecha) => obtenerDocumentosBonConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones BON en el ultimo boletin',
      procesado: 'BON procesado (captura bruta + filtro rural)',
    },
  });
};
