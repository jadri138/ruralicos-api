// src/routes/bopa.js
//
// Scraper del BOPA (Boletín Oficial del Principado de Asturias).
// Cron recomendado: días laborables a partir de las 08:30h.

const { obtenerDocumentosBopaConTexto, getFechaHoyISO } = require('../scrapers/BOPA/bopaScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'concejo', 'mancomunidad',
  'presupuesto municipal', 'modificacion de credito',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'notificacion', 'recaudacion ejecutiva', 'providencia de apremio',
  'diligencia de embargo', 'herencia yacente', 'padron municipal',
  'oposicion', 'convocatoria para la provision', 'lista definitiva', 'lista provisional',
  'nombramiento', 'nombra', 'funcionario', 'interino', 'cese',
  'casa rural', 'hotel', 'alojamiento rural',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural', 'agroalimentari',
  'forest', 'monte', 'aprovechamiento forestal', 'politica agricola comun',
  'fega', 'feaga', 'feader', 'desarrollo rural',
  'regadio', 'regad', 'riego',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'lacteo', 'leche', 'bovino', 'vacuno', 'porcino', 'ovino', 'caprino',
  'sidra', 'manzana', 'pomac', 'vino', 'viticultur',
  'pasto', 'pastal', 'praderia', 'explotaci',
  'denominacion de origen', 'calidad agroalimentaria',
  'consejeria de medio rural', 'servicio de ganaderia',
  'industria alimentaria',
];

const esRuralRelevante = crearFiltroRural({ excluir: EXCLUIR_FUERTE, incluir: INCLUIR_RURAL });

module.exports = function bopaRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-bopa-oficial', '/scrape-bopa'],
    fuente: 'BOPA',
    region: 'Asturias',
    hoy: getFechaHoyISO,
    fechaModo: 'query',
    obtenerDocs: (fecha) => obtenerDocumentosBopaConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones BOPA en el último boletín',
      procesado: 'BOPA procesado (captura bruta + filtro rural)',
    },
  });
};
