const { fuentePermitida } = require('../config/planes');

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

function fuenteNormalizada(alerta = {}) {
  return norm(alerta.fuente || '').toUpperCase();
}

function provinciasDerivadasAlerta(alerta = {}) {
  const provincias = Array.isArray(alerta.provincias)
    ? alerta.provincias.map(norm).filter(Boolean)
    : [];
  if (provincias.length > 0) return provincias;

  const porFuente = PROVINCIAS_POR_FUENTE[fuenteNormalizada(alerta)] || [];
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
    const fuenteAlerta = alerta.fuente || 'BOE';
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
