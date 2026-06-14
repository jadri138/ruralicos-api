const { normalizar } = require('../../shared/ruralFilter');

const INCLUIR_PROVINCIAL = [
  'agricultur',
  'ganader',
  'agrari',
  'agroalimentari',
  'rural',
  'forest',
  'monte',
  'montes',
  'pac',
  'fega',
  'regadio',
  'regad',
  'riego',
  'regante',
  'comunidad de regantes',
  'fitosanit',
  'zoosanit',
  'sanidad animal',
  'plaga',
  'caza',
  'aprovechamiento',
  'pastos',
  'pastizal',
  'vias pecuarias',
  'via pecuaria',
  'vitivinicol',
  'vinedo',
  'viñedo',
  'olivar',
  'frutal',
  'cereal',
  'forraje',
  'explotacion agraria',
  'explotación agraria',
  'explotacion ganadera',
  'explotación ganadera',
  'denominacion de origen',
  'denominación de origen',
  'calidad alimentaria',
  'pesca',
  'finca',
  'fincas',
  'parcela',
  'parcelas',
  'poligono',
  'polígono',
  'suelo no urbanizable',
  'licencia ambiental',
  'interes publico',
  'interés público',
  'dominio publico',
  'dominio público',
  'alta tension',
  'alta tensión',
  'linea electrica',
  'línea eléctrica',
  'expropiacion',
  'expropiación',
  'femoga',
];

const EXCLUIR_PROVINCIAL = [
  'recursos humanos',
  'bolsa de empleo',
  'aspirantes',
  'funcionario',
  'nombramiento',
  'cuenta general',
  'modificacion presupuestaria',
  'modificación presupuestaria',
  'presupuesto general',
  'padron municipal',
  'padrón municipal',
  'vehiculos de traccion mecanica',
  'vehículos de tracción mecánica',
  'ayuda a domicilio',
  'comidas a domicilio',
  'bono termal',
  'soledad no deseada',
  'plaza de toros',
  'abastecimiento de agua',
  'recogida de basuras',
  'residuos solidos urbanos',
  'residuos sólidos urbanos',
  'accion social',
  'acción social',
  'ordenanza municipal reguladora de subvenciones',
  'vivienda publica',
  'vivienda pública',
  'venta ambulante',
  'barras de bares',
  'convivencia civica',
  'convivencia cívica',
  'parcela urbana',
];

function contieneAlguna(textoNormalizado, palabras) {
  return palabras.some((palabra) => {
    const p = normalizar(palabra);
    if (p === 'pac') return /(^| )pac( |$)/.test(textoNormalizado);
    return textoNormalizado.includes(p);
  });
}

function esProvincialRelevante(texto) {
  const t = normalizar(texto);
  if (contieneAlguna(t, EXCLUIR_PROVINCIAL)) return false;
  return contieneAlguna(t, INCLUIR_PROVINCIAL);
}

module.exports = {
  esProvincialRelevante,
  INCLUIR_PROVINCIAL,
  EXCLUIR_PROVINCIAL,
};
