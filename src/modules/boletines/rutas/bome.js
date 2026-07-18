// src/routes/bome.js
//
// Scraper del BOME (Boletin Oficial de la Ciudad Autonoma de Melilla).

const { obtenerDocumentosBomeConTexto, getFechaHoyISO } = require('../scrapers/BOME/bomeScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const SENALES_NEGATIVAS = [
  'ayuntamiento', 'administracion publica', 'presidencia e igualdad',
  'oposicion', 'concurso', 'provision de un puesto', 'aspirantes',
  'relacion provisional', 'relacion definitiva', 'nombramiento', 'cese',
  'funcionario', 'personal directivo', 'tribunal', 'juzgado',
  'presupuesto', 'modificacion de credito', 'contratacion',
  'vehiculo', 'matrimonio civil',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'monte', 'medio natural',
  'politica agricola comun', 'fega', 'feaga', 'feader',
  'regadio', 'regad', 'riego', 'agua',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'explotaci', 'pasto', 'pastos', 'forraje',
  'pesca', 'acuicultura',
  'industria agroalimentaria', 'agroalimentari',
  'medio ambiente', 'desarrollo rural',
];

const esRuralRelevante = crearFiltroRural({ excluir: SENALES_NEGATIVAS, incluir: INCLUIR_RURAL });

module.exports = function bomeRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-bome-oficial', '/scrape-bome'],
    fuente: 'BOME',
    region: 'Melilla',
    hoy: getFechaHoyISO,
    fechaModo: 'query-o-hoy',
    obtenerDocs: (fecha) => obtenerDocumentosBomeConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones BOME en esta fecha',
      procesado: 'BOME procesado (captura bruta + filtro rural)',
    },
  });
};
