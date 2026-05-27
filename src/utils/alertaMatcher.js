const { fuentePermitida, normalizarFuenteBoletin } = require('../config/planes');

function norm(str) {
  return (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

const intersecta = (a, b) => a.some((x) => b.includes(x));
const PROVINCIAS_POR_FUENTE = {
  BOE: ['nacional'],
  FEGA: ['nacional'],
  BOA: ['huesca', 'zaragoza', 'teruel'],
  BOPZ: ['zaragoza'],
  BOPH: ['huesca'],
  BOPT: ['teruel'],
  DOGC: ['barcelona', 'girona', 'lleida', 'tarragona'],
  DOGV: ['alicante', 'castellon', 'castellon', 'valencia'],
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
};
const MARCADORES_NACIONALES = new Set(['nacional', 'espana', 'españa', 'estatal', 'todas', 'todo el territorio nacional']);

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
].map(([term, aliases]) => ({ term, aliases: aliases || [term] }));

const MUNICIPIOS_PROVINCIA_HINTS = [
  { terms: ['useras', 'useres', 'les useres'], provincias: ['castellon', 'castello'] },
  { terms: ['corullon'], provincias: ['leon'] },
  { terms: ['castillejo de mesleon'], provincias: ['segovia'] },
  { terms: ['valle de ollo'], provincias: ['navarra'] },
  { terms: ['villarquemado'], provincias: ['teruel'] },
];

function fuenteNormalizada(alerta = {}) {
  return normalizarFuenteBoletin(alerta.fuente || '');
}

function escaparRegExp(texto) {
  return String(texto || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contieneTermino(texto, termino) {
  if (!texto || !termino) return false;
  return new RegExp(`(^|[^a-z0-9])${escaparRegExp(termino)}([^a-z0-9]|$)`, 'i').test(texto);
}

function anadirProvincias(destino, provincias) {
  for (const provincia of provincias || []) {
    const limpia = norm(provincia);
    if (limpia && !destino.includes(limpia)) destino.push(limpia);
  }
}

function extraerProvinciasDeTextoAlerta(alerta = {}) {
  const detectadas = [];
  const titulo = norm(alerta.titulo || '');
  const resumenes = norm([alerta.resumen_final, alerta.resumen].filter(Boolean).join(' '));
  const contenido = norm(String(alerta.contenido || '').slice(0, 2500));
  const textoCorto = [titulo, resumenes].filter(Boolean).join(' ');

  for (const item of PROVINCIAS_TEXTO) {
    const term = item.term;
    const parentetico = new RegExp(`\\(${escaparRegExp(term)}\\)`, 'i');
    const patronTitulo = new RegExp(`\\b(en|de|del|para|municipio de|termino municipal de|provincia de)\\s+(?:la\\s+|el\\s+)?${escaparRegExp(term)}\\b`, 'i');
    const patronFuerte = new RegExp(`\\b(provincia de|provincia:|termino municipal de|municipio de)\\s+(?:la\\s+|el\\s+)?${escaparRegExp(term)}\\b`, 'i');

    if (
      parentetico.test(textoCorto) ||
      patronTitulo.test(titulo) ||
      patronFuerte.test(resumenes) ||
      parentetico.test(contenido) ||
      patronFuerte.test(contenido)
    ) {
      anadirProvincias(detectadas, item.aliases);
    }
  }

  for (const hint of MUNICIPIOS_PROVINCIA_HINTS) {
    if (hint.terms.some((term) => contieneTermino(textoCorto, term))) {
      anadirProvincias(detectadas, hint.provincias);
    }
  }

  return detectadas;
}

function mismasProvincias(a = [], b = []) {
  const setA = new Set((a || []).map(norm).filter(Boolean));
  const setB = new Set((b || []).map(norm).filter(Boolean));
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}

function provinciasDerivadasAlerta(alerta = {}) {
  const provincias = Array.isArray(alerta.provincias)
    ? alerta.provincias.map(norm).filter(Boolean)
    : [];
  const porFuente = PROVINCIAS_POR_FUENTE[fuenteNormalizada(alerta)] || [];
  const provinciasTexto = extraerProvinciasDeTextoAlerta(alerta);

  if (provinciasTexto.length > 0) {
    const provinciasParecenFuente = porFuente.length > 1 && mismasProvincias(provincias, porFuente);
    const provinciasSonNacionales = provincias.some((p) => MARCADORES_NACIONALES.has(p));
    const provinciasContradicenTexto = provincias.length > 0 && !intersecta(provincias, provinciasTexto);
    if (provincias.length === 0 || provinciasParecenFuente || provinciasSonNacionales || provinciasContradicenTexto) {
      return provinciasTexto;
    }
  }

  if (provincias.length > 0) return provincias;

  if (porFuente.length > 0) return porFuente.map(norm);

  const region = norm(alerta.region || '');
  return region ? [region] : [];
}

function esAlertaNacional(alerta = {}, provinciasNorm = []) {
  if (provinciasNorm.some((p) => MARCADORES_NACIONALES.has(p))) return true;

  // BOE no significa automaticamente nacional: si el clasificador ha detectado
  // una provincia concreta, se respeta como filtro duro.
  if (provinciasNorm.length === 0 && ['BOE', 'FEGA'].includes(fuenteNormalizada(alerta))) return true;
  return false;
}

function diagnosticarAlertaUsuario(alerta, user, options = {}) {
  const { aplicarFuente = true } = options;
  const prefs = user.preferences || {};

  if (aplicarFuente) {
    const fuenteAlerta = normalizarFuenteBoletin(alerta.fuente || 'BOE');
    if (!fuentePermitida(user.subscription, fuenteAlerta)) {
      return { ok: false, motivo: 'fuente_no_permitida', detalle: { fuente: fuenteAlerta, plan: user.subscription } };
    }
  }

  const provinciasUserNorm = Array.isArray(prefs.provincias)
    ? prefs.provincias.map(norm)
    : [];
  const sectoresUserNorm = Array.isArray(prefs.sectores)
    ? prefs.sectores.map(norm)
    : [];
  const subsectoresUserNorm = Array.isArray(prefs.subsectores)
    ? prefs.subsectores.map(norm)
    : [];
  const tiposUser = prefs.tipos_alerta || {};

  const provinciasANorm = provinciasDerivadasAlerta(alerta);
  const alertaNacional = esAlertaNacional(alerta, provinciasANorm);
  const sectoresANorm = Array.isArray(alerta.sectores)
    ? alerta.sectores.map(norm)
    : [];
  const subsectoresANorm = Array.isArray(alerta.subsectores)
    ? alerta.subsectores.map(norm)
    : [];
  const tiposANorm = Array.isArray(alerta.tipos_alerta)
    ? alerta.tipos_alerta.map((t) => (t ? norm(t) : '')).filter(Boolean)
    : [];

  const okProvincia =
    provinciasUserNorm.length === 0 ||
    alertaNacional ||
    intersecta(provinciasUserNorm, provinciasANorm);
  if (!okProvincia) {
    return {
      ok: false,
      motivo: 'provincia_no_coincide',
      detalle: {
        usuario: provinciasUserNorm,
        alerta: provinciasANorm,
        alerta_nacional: alertaNacional,
        fuente: alerta.fuente || 'BOE',
      },
    };
  }

  const tieneMixtoUser = sectoresUserNorm.includes('mixto');
  const tieneMixtoAlerta = sectoresANorm.includes('mixto');
  const okSector =
    sectoresUserNorm.length === 0 ||
    sectoresANorm.length === 0 ||
    intersecta(sectoresUserNorm, sectoresANorm) ||
    (tieneMixtoUser && intersecta(['agricultura', 'ganaderia'], sectoresANorm)) ||
    (tieneMixtoAlerta && intersecta(['agricultura', 'ganaderia'], sectoresUserNorm));
  if (!okSector) {
    return { ok: false, motivo: 'sector_no_coincide', detalle: { usuario: sectoresUserNorm, alerta: sectoresANorm } };
  }

  const okSubsector =
    subsectoresUserNorm.length === 0 ||
    subsectoresANorm.length === 0 ||
    intersecta(subsectoresUserNorm, subsectoresANorm);
  if (!okSubsector) {
    return { ok: false, motivo: 'subsector_no_coincide', detalle: { usuario: subsectoresUserNorm, alerta: subsectoresANorm } };
  }

  const tiposUserActivos = Object.entries(tiposUser)
    .filter(([_, v]) => v === true)
    .map(([k]) => norm(k));

  if (tiposUserActivos.length > 0 && tiposANorm.length > 0) {
    if (!tiposANorm.some((t) => tiposUserActivos.includes(t))) {
      return { ok: false, motivo: 'tipo_alerta_no_coincide', detalle: { usuario: tiposUserActivos, alerta: tiposANorm } };
    }
  }

  return { ok: true, motivo: 'coincide' };
}

function alertaCoincideConUsuario(alerta, user, options = {}) {
  return diagnosticarAlertaUsuario(alerta, user, options).ok;
}

module.exports = { alertaCoincideConUsuario, diagnosticarAlertaUsuario, norm, intersecta };
