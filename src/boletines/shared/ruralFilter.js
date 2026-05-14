function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

const EXCLUIR_FUERTE = [
  'ayuntamiento',
  'ajuntament',
  'concello',
  'diputacion',
  'deputacion',
  'presupuesto',
  'pressupost',
  'orzamento',
  'modificacion de creditos',
  'modificacio de credits',
  'recurso contencioso',
  'tribunal superior',
  'edicto',
  'edicte',
  'oposicion',
  'oposicio',
  'universidad',
  'universitat',
  'universidade',
  'nombramiento',
  'cese',
];

const INCLUIR_RURAL = [
  'agricultur',
  'ganader',
  'ramader',
  'ganderi',
  'agrari',
  'agroalimentari',
  'rural',
  'forest',
  'monte',
  'mont',
  'pac',
  'fega',
  'ayuda',
  'ajuda',
  'axuda',
  'subvenc',
  'bases reguladoras',
  'convocatoria',
  'regadio',
  'regad',
  'riego',
  'aigua',
  'agua',
  'auga',
  'regante',
  'regant',
  'comunidad de regantes',
  'fitosanit',
  'zoosanit',
  'sanidad animal',
  'sanitat animal',
  'plaga',
  'praga',
  'caza',
  'caca',
  'aprovechamiento',
  'aproveitamento',
  'aprovechament',
  'pastos',
  'pastizal',
  'vias pecuarias',
  'via pecuaria',
  'vitivinicol',
  'vinedo',
  'vinya',
  'olivar',
  'frutal',
  'fruiter',
  'cereal',
  'forraje',
  'farratge',
  'pasto',
  'explotacion agraria',
  'explotacion ganadera',
  'denominacion de origen',
  'denominacio d origen',
  'denominacion de orixe',
  'calidad alimentaria',
  'calidade alimentaria',
  'pesca',
  'acuicultura',
  'marisqu',
];

function contieneAlguna(textoNormalizado, palabras) {
  return palabras.some((palabra) => textoNormalizado.includes(normalizar(palabra)));
}

function esRuralRelevante(texto, opciones = {}) {
  const t = normalizar(texto);
  const excluir = [...EXCLUIR_FUERTE, ...(opciones.excluir || [])];
  const incluir = [...INCLUIR_RURAL, ...(opciones.incluir || [])];

  if (contieneAlguna(t, excluir)) return false;
  return contieneAlguna(t, incluir);
}

module.exports = {
  normalizar,
  esRuralRelevante,
  EXCLUIR_FUERTE,
  INCLUIR_RURAL,
};

