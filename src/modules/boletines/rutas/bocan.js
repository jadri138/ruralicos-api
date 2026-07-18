// src/routes/bocan.js
//
// Scraper del BOC (Boletín Oficial de Canarias).
// Cron recomendado: días laborables a partir de las 08:30h.

const { obtenerDocumentosBocanConTexto, getFechaHoyISO } = require('../scrapers/BOCAN/bocanScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const SENALES_NEGATIVAS = [
  'ayuntamiento', 'cabildo insular', 'mancomunidad',
  'presupuesto municipal', 'presupuesto general',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'notificacion', 'recaudacion ejecutiva', 'providencia de apremio',
  'diligencia de embargo', 'padron municipal',
  'oposicion', 'convocatoria de pruebas', 'lista definitiva', 'lista provisional',
  'nombramiento', 'funcionario', 'interino', 'cese',
  'transporte', 'taxi', 'turismo',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'agroalimentari', 'rural', 'agro',
  'forest', 'monte', 'medio natural',
  'politica agricola comun', 'pac', 'feader', 'fega', 'feaga',
  'pesca', 'acuicultur', 'maritim', 'lonja', 'pesquer',
  'regadio', 'regad', 'riego', 'agua agricola',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'platano', 'tomate', 'papa', 'vid', 'vino', 'viticultur',
  'pasto', 'explotaci', 'caprino', 'ovino', 'bovino',
  'denominacion de origen', 'indicacion geografica', 'calidad alimentaria',
  'consejeria de agricultura', 'direccion general de agricultura',
  'industria agroalimentaria',
];

const esRuralRelevante = crearFiltroRural({ excluir: SENALES_NEGATIVAS, incluir: INCLUIR_RURAL });

module.exports = function bocanRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-bocan-oficial', '/scrape-bocan'],
    fuente: 'BOCAN',
    region: 'Canarias',
    hoy: getFechaHoyISO,
    fechaModo: 'query',
    obtenerDocs: (fecha) => obtenerDocumentosBocanConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones BOC Canarias en el último boletín',
      procesado: 'BOC Canarias procesado (captura bruta + filtro rural)',
    },
  });
};
