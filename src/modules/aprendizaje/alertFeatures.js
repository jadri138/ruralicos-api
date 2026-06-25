const {
  extraerFeatureTagsDeTexto,
  normalizarTextoTaxonomia,
} = require('./taxonomiaRuralicos');

function norm(str) {
  return normalizarTextoTaxonomia(str);
}

function textoAlerta(alerta = {}) {
  return norm([
    alerta.titulo,
    alerta.resumen_final,
    alerta.resumen,
    alerta.contenido,
    ...(Array.isArray(alerta.provincias) ? alerta.provincias : []),
    ...(Array.isArray(alerta.sectores) ? alerta.sectores : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
    alerta.fuente,
  ].filter(Boolean).join(' '));
}

function extraerFeaturesAlerta(alerta = {}) {
  return [
    ...new Set([
      ...(Array.isArray(alerta.taxonomy_tags) ? alerta.taxonomy_tags : []),
      ...extraerFeatureTagsDeTexto(textoAlerta(alerta)),
    ]),
  ];
}

module.exports = {
  extraerFeaturesAlerta,
  textoAlerta,
};
