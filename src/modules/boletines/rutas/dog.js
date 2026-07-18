// src/routes/dog.js
//
// Scraper del DOG (Diario Oficial de Galicia).
// Cron recomendado: días laborables a las 10:00h.

const { obtenerDocumentosDogConTexto, getFechaHoyISO } = require('../scrapers/DOG/dogScraper');
const { registrarBoletinRuta, crearFiltroRural } = require('./shared/registrarBoletinRuta');

const SENALES_NEGATIVAS = [
  'ayuntamiento', 'concello', 'diputacion', 'deputacion',
  'presupuesto', 'orzamento',
  'recurso contencioso', 'tribunal superior',
  'edicto', 'edicte', 'oposicion', 'oposicions',
  'universidad', 'universidade', 'escola', 'escuela',
  'nombramiento', 'cese', 'sustitucion',
];

const INCLUIR_RURAL = [
  'agricultur', 'ganader', 'ganderi', 'agrari', 'rural',
  'forest', 'monte', 'pac', 'fega',
  'ayuda', 'axuda', 'subvenci', 'bases reguladoras',
  'regadio', 'regad', 'riego', 'agua', 'auga',
  'fitosanit', 'zoosanit', 'sanidad animal', 'sanidade animal', 'plaga', 'praga',
  'caza', 'caca', 'aprovechamiento', 'aproveitamento',
  'vitivinicol', 'vino', 'vinu', 'viñedo', 'olivar', 'frutal',
  'cereal', 'forraje', 'pasto', 'explotaci',
  'denominacion de orixe', 'denominacion de origen',
  'calidade alimentaria', 'calidad alimentaria',
  'pesca', 'acuicultura', 'marisqu',
  'conselleria do medio rural', 'conselleria de medio rural',
  'agencia gallega de la calidad alimentaria',
  'instituto galego da calidade',
];

const esRuralRelevante = crearFiltroRural({ excluir: SENALES_NEGATIVAS, incluir: INCLUIR_RURAL });

module.exports = function dogRoutes(app, supabase) {
  registrarBoletinRuta(app, supabase, {
    paths: ['/scrape-dog'],
    fuente: 'DOG',
    region: 'Galicia',
    hoy: getFechaHoyISO,
    fechaModo: 'hoy',
    obtenerDocs: (fecha) => obtenerDocumentosDogConTexto(fecha, esRuralRelevante),
    mensajes: {
      sinDocs: 'No hay disposiciones DOG hoy (festivo o fin de semana)',
      procesado: 'DOG procesado (captura bruta + filtro rural)',
    },
  });
};
