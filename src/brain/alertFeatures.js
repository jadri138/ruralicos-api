function norm(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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

const REGLAS_FEATURES = [
  ['concepto:plazo', /\b(plazo|hasta el|antes del|finaliza|termina|dias habiles|ultimos dias)\b/],
  ['accion:solicitar', /\b(solicitud|solicitar|presentacion|presentar|inscripcion|inscribir)\b/],
  ['accion:subsanar', /\b(subsanacion|subsanar|requerimiento|documentacion pendiente)\b/],
  ['accion:alegar', /\b(alegaciones|alegar|informacion publica|audiencia)\b/],
  ['concepto:ayuda_directa', /\b(ayuda|subvencion|prima|pago|indemnizacion|convocatoria)\b/],
  ['concepto:pac', /\b(pac|fega|feaga|feader|solicitud unica|sigpac|ecoregimen)\b/],
  ['concepto:fiscalidad', /\b(irpf|iva|modulos|fiscalidad|impuesto|estimacion objetiva)\b/],
  ['concepto:agua_riego', /\b(riego|regadio|regante|comunidad de regantes|acequia|dotacion|concesion de aguas)\b/],
  ['concepto:sequia', /\b(sequia|escasez de agua|restricciones de agua|emergencia por sequia)\b/],
  ['concepto:sanidad_animal', /\b(sanidad animal|vacunacion|movimiento de animales|explotacion ganadera|tuberculosis|lengua azul|influenza aviar|peste porcina|fiebre aftosa)\b/],
  ['concepto:bienestar_animal', /\b(bienestar animal|transporte de animales|nucleo zoologico)\b/],
  ['concepto:fitosanitarios', /\b(fitosanitario|plaga|tratamiento|xylella|langosta|mosca de la fruta|mildiu|fertilizante)\b/],
  ['concepto:cuaderno_digital', /\b(cuaderno digital|cuaderno de explotacion|siar|reto|registro de tratamientos)\b/],
  ['concepto:medio_ambiente', /\b(zepa|lic|natura 2000|impacto ambiental|evaluacion ambiental|biodiversidad|residuo|purin|nitratos)\b/],
  ['concepto:energia', /\b(fotovoltaica|energia|electrificacion|autoconsumo|biogas|biometano)\b/],
  ['entidad:cooperativa', /\b(cooperativa|sat|sociedad agraria de transformacion)\b/],
  ['entidad:comunidad_regantes', /\b(comunidad de regantes|junta central de usuarios|confederacion hidrografica)\b/],
  ['entidad:ayuntamiento', /\b(ayuntamiento|municipio|termino municipal)\b/],
  ['tramite:individual', /\b(expediente|solicitud de concesion|concesion de aguas?|aprovechamiento de aguas?|solicitud de autorizacion|autorizacion de vertido|autorizacion ambiental|autorizacion administrativa previa|termino municipal|adjudicacion directa|notificacion individual)\b/],
  ['tramite:nombramiento', /\b(nombramiento|cese|designacion|vocal|cargo)\b/],
  ['tramite:licitacion', /\b(licitacion|contrato|adjudicacion|formalizacion)\b/],
];

function extraerFeaturesAlerta(alerta = {}) {
  const texto = textoAlerta(alerta);
  const features = new Set();

  for (const [tag, regex] of REGLAS_FEATURES) {
    if (regex.test(texto)) features.add(tag);
  }

  return [...features];
}

module.exports = {
  extraerFeaturesAlerta,
  textoAlerta,
};
