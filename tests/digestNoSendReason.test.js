process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  resolverMotivoNoEnvioDigest,
  resumirSeleccionDigest,
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

assert.deepStrictEqual(resumirSeleccionDigest(fueraPorPolitica), {
  evaluadas: 2,
  incluidas: 0,
  motivos: {
    revision_riesgo_alto: 1,
    expediente_individual_sin_municipio: 1,
  },
});

console.log('OK: motivos de no envio distinguen perfil y politica de seleccion');
