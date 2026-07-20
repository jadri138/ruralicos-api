const ESTADOS_PENDIENTES_AUTOMATICOS = Object.freeze([
  'pendiente_clasificar',
  'pendiente_resumir',
  'pendiente_revisar',
]);

const ESTADOS_RETENIDOS = Object.freeze([
  'pendiente_revision_manual',
  'needs_evidence',
]);

function describirEstadoPendiente(estado) {
  if (estado === null || estado === undefined || estado === '') {
    return {
      tipo_pendiente: 'automatico',
      procesamiento_automatico: true,
      accion_requerida: 'reparar_estado',
    };
  }

  if (ESTADOS_PENDIENTES_AUTOMATICOS.includes(estado)) {
    return {
      tipo_pendiente: 'automatico',
      procesamiento_automatico: true,
      accion_requerida: 'pipeline_ia',
    };
  }

  if (estado === 'pendiente_revision_manual') {
    return {
      tipo_pendiente: 'retenido',
      procesamiento_automatico: false,
      accion_requerida: 'revision_y_reproceso_manual',
    };
  }

  if (estado === 'needs_evidence') {
    return {
      tipo_pendiente: 'retenido',
      procesamiento_automatico: false,
      accion_requerida: 'aportar_evidencia_y_reprocesar_manual',
    };
  }

  return null;
}

module.exports = {
  ESTADOS_PENDIENTES_AUTOMATICOS,
  ESTADOS_RETENIDOS,
  describirEstadoPendiente,
};
