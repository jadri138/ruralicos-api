const { getFechaHoyYYYYMMDD, obtenerDocumentosDocmPorFecha } = require('../scrapers/DOCM/docmScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const EXCLUIR_FUERTE = [
  'ayuntamiento', 'diputacion', 'presupuesto',
  'recurso contencioso', 'edicto', 'nombramiento',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'agrari', 'rural',
  'forest', 'pac', 'ayuda', 'subvenc', 'bases reguladoras',
  'regad', 'riego', 'fitosanit', 'zoosanit',
  'sanidad animal', 'caza', 'viticult', 'vitivinicol', 'olivar',
];

const esRuralRelevante = crearFiltroRural({ excluir: EXCLUIR_FUERTE, incluir: INCLUIR_RURAL });

module.exports = function docmRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-docm-oficial'],
    fuente: 'DOCM',
    region: 'Castilla-La Mancha',
    hoy: getFechaHoyYYYYMMDD,
    fechaModo: 'hoy',
    obtenerDocs: (fecha) => obtenerDocumentosDocmPorFecha(fecha),
    procesador: 'filtroRural',
    opciones: {
      esRuralRelevante,
      construirBolsa: (doc) => [String(doc.texto || '').slice(0, 3500), doc.titulo, doc.seccion].join(' '),
    },
    mensajes: {
      sinDocs: 'No hay boletín DOCM publicado hoy (festivo o fin de semana)',
      procesado: 'DOCM procesado (HTML scraping + captura bruta + filtro rural)',
    },
  });
};
