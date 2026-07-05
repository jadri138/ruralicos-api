// src/routes/bocyl.js
//
// Scraper del BOCYL (Boletín Oficial de Castilla y León).
// Usa la API OpenDataSoft de la JCyL; el scraper devuelve disposiciones
// listas con texto completo — no hay que descargar PDFs aquí.
//
// Cron recomendado: días laborables a las 10:00–11:00h (el BOCYL
// se publica entre las 08:00 y las 10:30h de lunes a viernes).

const { getFechaHoyYYYYMMDD, obtenerDocumentosBocylPorFecha } = require('../scrapers/BOCYL/bocylScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const EXCLUIR_FUERTE = [
  'boletin oficial de la provincia',
  'ayuntamiento', 'diputacion',
  'modificacion de creditos', 'presupuesto',
  'recurso contencioso', 'tribunal superior de justicia',
  'edicto', 'nombramiento', 'oposicion',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'ayuda', 'subvenc', 'bases reguladoras',
  'regad', 'riego', 'agua', 'fitosanit', 'zoosanit',
  'sanidad animal', 'plaga', 'caza',
];

const esRuralRelevante = crearFiltroRural({ excluir: EXCLUIR_FUERTE, incluir: INCLUIR_RURAL });

module.exports = function bocylRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-bocyl-oficial'],
    fuente: 'BOCYL',
    region: 'Castilla y León',
    hoy: getFechaHoyYYYYMMDD,
    fechaModo: 'hoy',
    obtenerDocs: (fecha) => obtenerDocumentosBocylPorFecha(fecha),
    procesador: 'filtroRural',
    opciones: { esRuralRelevante },
    mensajes: {
      sinDocs: 'No hay boletín BOCYL publicado hoy (festivo o fin de semana)',
      procesado: 'BOCYL procesado (API OpenDataSoft + captura bruta + filtro rural)',
    },
  });
};
