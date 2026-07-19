process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  construirFunnelDigest,
  contarDecisionesTrasScoring,
  resolverMotivoNoEnvioDigest,
  resumirSeleccionDigest,
  seleccionarAlertasRescate,
} = require('../src/modules/digest/digest.service');

const base = {
  totalAlertasDia: 10,
  alertasTrasQualityGate: [{ id: 1 }, { id: 2 }],
  alertasVisibles: [{ id: 1 }, { id: 2 }],
  alertasOrdenadas: [],
};

const fueraPorPerfil = {
  alertas: [],
  decisiones: [
    { incluir: false, motivo: 'provincia_no_coincide' },
    { incluir: false, motivo: 'sector_no_coincide' },
  ],
};

const fueraPorPolitica = {
  alertas: [],
  decisiones: [
    { incluir: false, motivo: 'revision_riesgo_alto' },
    { incluir: false, motivo: 'expediente_individual_sin_municipio' },
  ],
};

assert.strictEqual(
  resolverMotivoNoEnvioDigest({ ...base, seleccionBase: fueraPorPerfil }),
  'perfil_sin_coincidencias'
);

assert.strictEqual(
  resolverMotivoNoEnvioDigest({ ...base, seleccionBase: fueraPorPolitica }),
  'seleccion_sin_alertas_enviables'
);

assert.strictEqual(
  resolverMotivoNoEnvioDigest({
    ...base,
    seleccionBase: {
      alertas: [],
      decisiones: [
        { incluir: false, motivo: 'alerta_sin_taxonomia' },
        { incluir: false, motivo: 'alerta_sin_sector_clasificado' },
      ],
    },
  }),
  'perfil_sin_coincidencias'
);

assert.deepStrictEqual(resumirSeleccionDigest(fueraPorPolitica), {
  evaluadas: 2,
  incluidas: 0,
  motivos: {
    revision_riesgo_alto: 1,
    expediente_individual_sin_municipio: 1,
  },
});

assert.strictEqual(contarDecisionesTrasScoring({
  decisiones: [
    { action: 'include' },
    { action: 'review_only' },
    { action: 'exclude' },
  ],
}), 2);

assert.deepStrictEqual(construirFunnelDigest({
  totalAlertasDia: 10,
  trasQualityGate: 8,
  trasFiltroUsuario: 12,
  trasScoring: 6,
  alertasFinales: 9,
}), {
  totalAlertasDia: 10,
  totalAlertasVentana: 0,
  trasQualityGate: 8,
  trasFiltroUsuario: 8,
  trasScoring: 6,
  alertasFinales: 6,
});

const rescate = seleccionarAlertasRescate({
  alertas: [
    {
      id: 1,
      fuente: 'BOE',
      titulo: 'Comunicado informativo general',
      provincias: ['nacional'],
      sectores: [],
      subsectores: [],
      tipos_alerta: [],
      taxonomy_tags: [],
    },
    {
      id: 2,
      fuente: 'BOE',
      titulo: 'Norma general para el sector agricola',
      provincias: ['nacional'],
      sectores: ['agricultura'],
      subsectores: [],
      tipos_alerta: ['normativa_general'],
    },
  ],
  user: {
    subscription: 'cooperativa',
    preferences: {
      provincias: [],
      sectores: ['ganaderia'],
      subsectores: [],
      tipos_alerta: {},
    },
  },
  aprendizaje: null,
  perfilOperativoMIA: {},
  maxItems: 2,
});

assert.strictEqual(rescate.tipo, 'suave');
assert.deepStrictEqual(rescate.alertas.map((alerta) => alerta.id), [2]);
assert.strictEqual(
  rescate.decisiones.find((decision) => decision.id === 1).motivo,
  'alerta_sin_taxonomia'
);

console.log('OK: motivos de no envio distinguen perfil y politica de seleccion');
