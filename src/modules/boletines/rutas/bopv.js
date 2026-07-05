// src/routes/bopv.js
//
// Scraper del BOPV / EHAA (Boletin Oficial del Pais Vasco).
// Cron recomendado: dias laborables a partir de las 08:30h.

const { obtenerDocumentosBopvConTexto, getFechaHoyISO } = require('../scrapers/BOPV/bopvScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'udal', 'diputacion foral',
  'nombramiento', 'nombra', 'cese', 'personal eventual',
  'oposicion', 'concurso', 'puesto de trabajo', 'provision',
  'universidad', 'osakidetza', 'servicio vasco de salud',
  'vivienda', 'turismo', 'hosteleria', 'ruido',
  'sancionador', 'notifica', 'edicto',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'nekazar', 'abeltzaint',
  'agroalimentari', 'alimentari', 'rural',
  'forest', 'monte', 'mendi', 'medio natural',
  'politica agricola comun', 'fega', 'feaga', 'feader',
  'solicitud unica', 'subvenciones agrarias',
  'regadio', 'regad', 'riego',
  'fitosanit', 'zoosanit', 'sanidad animal', 'plaga',
  'vitivinicol', 'vino', 'vinedo', 'txakoli',
  'cereal', 'forraje', 'pasto', 'explotacion agraria', 'explotacion ganadera',
  'denominacion de origen', 'indicacion geografica', 'calidad alimentaria',
  'industria agroalimentaria',
  'desarrollo rural',
];

const esRuralRelevante = crearFiltroRural({ excluir: EXCLUIR_FUERTE, incluir: INCLUIR_RURAL });

module.exports = function bopvRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-bopv-oficial', '/scrape-bopv'],
    fuente: 'BOPV',
    region: 'Pais Vasco',
    hoy: getFechaHoyISO,
    fechaModo: 'query',
    obtenerDocs: (fecha) => obtenerDocumentosBopvConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones BOPV en el ultimo boletin',
      procesado: 'BOPV procesado (captura bruta + filtro rural)',
    },
  });
};
