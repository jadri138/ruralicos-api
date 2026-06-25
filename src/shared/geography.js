function normalizarGeografia(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

const PROVINCIAS_POR_FUENTE = Object.freeze({
  BOE: ['nacional'],
  FEGA: ['nacional'],
  BOA: ['huesca', 'zaragoza', 'teruel'],
  BOPZ: ['zaragoza'],
  BOPH: ['huesca'],
  BOPT: ['teruel'],
  DOGC: ['barcelona', 'girona', 'lleida', 'tarragona'],
  DOGV: ['alicante', 'castellon', 'valencia'],
  DOG: ['a coruna', 'lugo', 'ourense', 'pontevedra'],
  DOCM: ['albacete', 'ciudad real', 'cuenca', 'guadalajara', 'toledo'],
  DOE: ['badajoz', 'caceres'],
  BOJA: ['almeria', 'cadiz', 'cordoba', 'granada', 'huelva', 'jaen', 'malaga', 'sevilla'],
  BOCYL: ['avila', 'burgos', 'leon', 'palencia', 'salamanca', 'segovia', 'soria', 'valladolid', 'zamora'],
  BOCM: ['madrid'],
  BON: ['navarra'],
  BOPA: ['asturias'],
  BOPV: ['alava', 'araba', 'bizkaia', 'vizcaya', 'gipuzkoa', 'guipuzcoa'],
  BOTHA: ['alava', 'araba'],
  BOG: ['gipuzkoa', 'guipuzcoa'],
  BOR: ['la rioja'],
  BORM: ['murcia'],
  BOIB: ['illes balears', 'islas baleares', 'baleares'],
  BOCAN: ['las palmas', 'santa cruz de tenerife'],
  BOCANT: ['cantabria'],
  BOME: ['melilla'],
  BOCCE: ['ceuta'],
});

const MARCADORES_NACIONALES = new Set([
  'nacional',
  'espana',
  'estatal',
  'todas',
  'todo el territorio nacional',
  'ambito estatal',
]);

const PROVINCIAS_TEXTO = [
  ['alava', ['alava', 'araba']],
  ['araba', ['alava', 'araba']],
  ['albacete'],
  ['alicante', ['alicante', 'alacant']],
  ['alacant', ['alicante', 'alacant']],
  ['almeria'],
  ['asturias'],
  ['avila'],
  ['badajoz'],
  ['barcelona'],
  ['burgos'],
  ['caceres'],
  ['cadiz'],
  ['cantabria'],
  ['castellon', ['castellon', 'castello']],
  ['castello', ['castellon', 'castello']],
  ['ciudad real'],
  ['cordoba'],
  ['a coruna', ['a coruna', 'coruna']],
  ['coruna', ['a coruna', 'coruna']],
  ['cuenca'],
  ['girona', ['girona', 'gerona']],
  ['gerona', ['girona', 'gerona']],
  ['granada'],
  ['guadalajara'],
  ['gipuzkoa', ['gipuzkoa', 'guipuzcoa']],
  ['guipuzcoa', ['gipuzkoa', 'guipuzcoa']],
  ['huelva'],
  ['huesca'],
  ['illes balears', ['illes balears', 'islas baleares', 'baleares']],
  ['islas baleares', ['illes balears', 'islas baleares', 'baleares']],
  ['baleares', ['illes balears', 'islas baleares', 'baleares']],
  ['jaen'],
  ['la rioja'],
  ['las palmas'],
  ['leon'],
  ['lleida', ['lleida', 'lerida']],
  ['lerida', ['lleida', 'lerida']],
  ['lugo'],
  ['madrid'],
  ['malaga'],
  ['murcia'],
  ['navarra'],
  ['ourense', ['ourense', 'orense']],
  ['orense', ['ourense', 'orense']],
  ['palencia'],
  ['pontevedra'],
  ['salamanca'],
  ['santa cruz de tenerife'],
  ['segovia'],
  ['sevilla'],
  ['soria'],
  ['tarragona'],
  ['teruel'],
  ['toledo'],
  ['valencia'],
  ['valladolid'],
  ['bizkaia', ['bizkaia', 'vizcaya']],
  ['vizcaya', ['bizkaia', 'vizcaya']],
  ['zamora'],
  ['zaragoza'],
  ['ceuta'],
  ['melilla'],
].map(([term, aliases]) => Object.freeze({ term, aliases: aliases || [term] }));

const PROVINCE_ALIASES = Object.freeze(PROVINCIAS_TEXTO.reduce((acc, item) => {
  for (const alias of item.aliases) acc[normalizarGeografia(alias)] = item.aliases;
  return acc;
}, {
  nacional: [...MARCADORES_NACIONALES],
  todas: [...MARCADORES_NACIONALES],
}));

const MUNICIPIOS_PROVINCIA_HINTS = Object.freeze([
  { terms: ['useras', 'useres', 'les useres'], provincias: ['castellon', 'castello'] },
  { terms: ['corullon'], provincias: ['leon'] },
  { terms: ['castillejo de mesleon'], provincias: ['segovia'] },
  { terms: ['valle de ollo'], provincias: ['navarra'] },
  { terms: ['villarquemado'], provincias: ['teruel'] },
]);

module.exports = {
  MARCADORES_NACIONALES,
  MUNICIPIOS_PROVINCIA_HINTS,
  PROVINCE_ALIASES,
  PROVINCIAS_POR_FUENTE,
  PROVINCIAS_TEXTO,
  normalizarGeografia,
};
