const { getFechaHoyYYYYMMDD, obtenerDocumentosBormPorFecha } = require('../scrapers/BORM/bormScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const SENALES_NEGATIVAS = [
  'ayuntamiento', 'diputacion', 'presupuesto',
  'recurso contencioso', 'edicto', 'nombramiento',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'ayuda', 'subvenc', 'bases reguladoras',
  'regad', 'riego', 'fitosanit', 'zoosanit',
  'sanidad animal', 'caza', 'viticult', 'vitivinicol', 'olivar',
  'huerta', 'frutas', 'horticultur', 'citric', 'regant',
];

const esRuralRelevante = crearFiltroRural({ excluir: SENALES_NEGATIVAS, incluir: INCLUIR_RURAL });

module.exports = function bormRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-borm-oficial'],
    fuente: 'BORM',
    region: 'Murcia',
    hoy: getFechaHoyYYYYMMDD,
    fechaModo: 'hoy',
    obtenerDocs: (fecha) => obtenerDocumentosBormPorFecha(fecha),
    procesador: 'filtroRural',
    opciones: { esRuralRelevante },
    mensajes: {
      sinDocs: 'No hay boletín BORM publicado hoy (festivo o fin de semana)',
      procesado: 'BORM procesado (API REST + captura bruta + filtro rural)',
    },
  });
};
