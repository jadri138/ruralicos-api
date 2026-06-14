const URGENTE = 'urgente';
const NORMAL = 'normal';
const BAJA = 'baja';

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
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
  ].filter(Boolean).join(' '));
}

function prioridadFichaIA(alerta = {}) {
  const raw = String([alerta.resumen_final, alerta.resumen].filter(Boolean).join('\n'));
  const match = raw.match(/^PRIORIDAD\s*:\s*(alta|media|baja)/im);
  return match ? norm(match[1]) : null;
}

function clasificarPrioridadAlerta(alerta = {}) {
  const texto = textoAlerta(alerta);
  const tipos = Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta.map(norm) : [];
  const prioridadFicha = prioridadFichaIA(alerta);

  let score = 0;
  const motivos = [];

  const reglasUrgentes = [
    ['plazo', /\b(plazo|solicitud|presentacion|alegaciones|subsanacion|inscripcion)\b/],
    ['fecha_limite', /\b(antes del|hasta el|finaliza|termina|ultimo dia|ultimos dias|dias habiles)\b/],
    ['ayuda', /\b(ayuda|subvencion|convocatoria|prima|indemnizacion|pago|pac|fega)\b/],
    ['sanidad', /\b(enfermedad|sanidad animal|vacunacion|foco|influenza|lengua azul|tuberculosis|peste porcina|restriccion de movimiento)\b/],
    ['agua', /\b(sequia|restricciones de agua|riego|regadio|comunidad de regantes|dotacion)\b/],
    ['fiscalidad', /\b(irpf|iva|modulos|fiscalidad|impuesto)\b/],
  ];

  for (const [motivo, regex] of reglasUrgentes) {
    if (regex.test(texto)) {
      score += 2;
      motivos.push(motivo);
    }
  }

  if (tipos.includes('ayudas_subvenciones')) {
    score += 2;
    motivos.push('tipo:ayudas_subvenciones');
  }
  if (tipos.includes('fiscalidad')) {
    score += 2;
    motivos.push('tipo:fiscalidad');
  }
  if (tipos.includes('agua_infraestructuras')) {
    score += 1;
    motivos.push('tipo:agua_infraestructuras');
  }

  const reglasBajas = [
    ['nombramiento', /\b(nombramiento|cese|designacion|delegacion de competencias)\b/],
    ['correccion', /\b(correccion de errores|extracto|anuncio de formalizacion)\b/],
    ['licitacion_menor', /\b(licitacion|contrato|adjudicacion)\b/],
    ['expediente_individual_local', /\b(concesion de aguas?|concesion para aprovechamiento|aprovechamiento de aguas|licencia ambiental|actividad clasificada|autorizacion de vertido|extincion de derecho|comisaria de aguas)\b/],
  ];

  for (const [motivo, regex] of reglasBajas) {
    if (regex.test(texto)) {
      score -= motivo === 'expediente_individual_local' ? 4 : 1;
      motivos.push(motivo);
    }
  }

  if (prioridadFicha === 'alta') {
    score += 1;
    motivos.push('ficha:alta');
  } else if (prioridadFicha === 'baja') {
    score -= 2;
    motivos.push('ficha:baja');
  }

  if (score >= 3) return { prioridad: URGENTE, score, motivos };
  if (score <= -1) return { prioridad: BAJA, score, motivos };
  return { prioridad: NORMAL, score, motivos };
}

function pesoPrioridad(prioridad) {
  if (prioridad === URGENTE) return 100;
  if (prioridad === NORMAL) return 50;
  return 0;
}

module.exports = {
  BAJA,
  NORMAL,
  URGENTE,
  clasificarPrioridadAlerta,
  pesoPrioridad,
};
