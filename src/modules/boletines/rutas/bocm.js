// src/routes/bocm.js
//
// Scraper del BOCM (Boletín Oficial de la Comunidad de Madrid).
// Cron recomendado: días laborables a partir de las 08:30h.

const { obtenerDocumentosBocmConTexto, getFechaHoyISO } = require('../scrapers/BOCM/bocmScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const SENALES_NEGATIVAS = [
  'ayuntamiento', 'mancomunidad', 'municipio',
  'presupuesto municipal', 'modificacion presupuestaria',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'notificacion', 'recaudacion ejecutiva', 'providencia de apremio',
  'padron municipal', 'empadronamiento',
  'oposicion', 'convocatoria de pruebas selectivas', 'lista definitiva', 'lista provisional',
  'nombramiento', 'funcionario', 'interino', 'cese',
  'vehiculos', 'taxi', 'metro', 'urbanismo',
  'instalacion electrica', 'instalacion fotovoltaica', 'alta tension',
  'transicion energetica', 'economia circular',
  'canal de isabel ii',
  'modificacion presupuestaria',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'agroalimentari', 'rural',
  'forest', 'monte', 'sierra', 'medio natural',
  'politica agricola comun', 'pac', 'feader', 'fega', 'feaga',
  'regadio', 'regad', 'riego', 'canal',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'vino', 'viticultur', 'vinedo', 'olivar', 'cereal',
  'pasto', 'praderia', 'explotaci',
  'denominacion de origen', 'calidad alimentaria',
  'industria agroalimentaria',
  'consejeria de medio ambiente, agricultura',
  'medio ambiente, agricultura',
];

const esRuralRelevante = crearFiltroRural({ excluir: SENALES_NEGATIVAS, incluir: INCLUIR_RURAL });

module.exports = function bocmRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-bocm-oficial', '/scrape-bocm'],
    fuente: 'BOCM',
    region: 'Comunidad de Madrid',
    hoy: getFechaHoyISO,
    fechaModo: 'query',
    obtenerDocs: (fecha) => obtenerDocumentosBocmConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones BOCM en el último boletín',
      procesado: 'BOCM procesado (captura bruta + filtro rural)',
    },
  });
};
