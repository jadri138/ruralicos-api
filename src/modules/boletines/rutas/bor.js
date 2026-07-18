// src/routes/bor.js
//
// Scraper del BOR (Boletin Oficial de La Rioja).
// Cron recomendado: dias laborables a partir de las 08:30h.

const { obtenerDocumentosBorConTexto, getFechaHoyISO } = require('../scrapers/BOR/borScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const SENALES_NEGATIVAS = [
  'ayuntamiento', 'mancomunidad',
  'presupuesto', 'modificacion de credito',
  'recurso contencioso', 'tribunal superior',
  'oposicion', 'concurso de traslados', 'relacion definitiva', 'relacion provisional',
  'nombramiento', 'nombra', 'funcionario', 'interino', 'cese',
  'padron', 'periodo de cobranza', 'delegacion de funciones',
  'casa rural', 'hotel', 'vehiculos', 'matrimonio civil',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'mundo rural',
  'forest', 'monte', 'politica agricola comun', 'fega', 'feaga', 'feader',
  'solicitud unica', 'subvenciones agrarias', 'subvenciones agro',
  'regadio', 'regad', 'riego',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'vitivinicol', 'vino', 'vinedo', 'viñedo', 'olivar', 'frutal',
  'cereal', 'forraje', 'pasto', 'explotaci',
  'denominacion de origen', 'calidad agroalimentaria',
  'industria agroalimentaria', 'agroalimentari',
  'consejeria de agricultura',
];

const esRuralRelevante = crearFiltroRural({ excluir: SENALES_NEGATIVAS, incluir: INCLUIR_RURAL });

module.exports = function borRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-bor-oficial', '/scrape-bor'],
    fuente: 'BOR',
    region: 'La Rioja',
    hoy: getFechaHoyISO,
    fechaModo: 'query-o-hoy',
    obtenerDocs: (fecha) => obtenerDocumentosBorConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones BOR en esta fecha',
      procesado: 'BOR procesado (captura bruta + filtro rural)',
    },
  });
};
