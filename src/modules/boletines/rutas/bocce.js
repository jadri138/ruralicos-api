// src/routes/bocce.js
//
// Scraper del BOCCE (Boletin Oficial de la Ciudad Autonoma de Ceuta).

const { obtenerDocumentosBocceConTexto, getFechaHoyISO } = require('../scrapers/BOCCE/bocceScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'administracion publica', 'presidencia',
  'oposicion', 'concurso', 'proceso selectivo', 'bolsa de empleo',
  'aspirantes', 'relacion provisional', 'relacion definitiva',
  'nombramiento', 'cese', 'funcionario', 'personal laboral',
  'tribunal', 'juzgado', 'notaria', 'registro civil',
  'presupuesto', 'modificacion presupuestaria', 'modificacion de credito',
  'contratacion', 'licitacion', 'vehiculo', 'matrimonio civil',
  'padron', 'urbanismo',
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

const esRuralRelevante = crearFiltroRural({ excluir: EXCLUIR_FUERTE, incluir: INCLUIR_RURAL });

module.exports = function bocceRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-bocce-oficial', '/scrape-bocce'],
    fuente: 'BOCCE',
    region: 'Ceuta',
    hoy: getFechaHoyISO,
    fechaModo: 'query-o-hoy',
    obtenerDocs: (fecha) => obtenerDocumentosBocceConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay boletines BOCCE en esta fecha',
      procesado: 'BOCCE procesado (captura bruta + filtro rural)',
    },
  });
};
