const assert = require('assert');
const {
  analizarAlcanceAudiencia,
  calcularCuotaDominanciaDigest,
  construirSnapshotAlcance,
} = require('../src/modules/alertas/seleccion/audienceReach');

function user(id, sector, province = 'teruel') {
  return {
    id,
    subscription: 'premium',
    preferences: {
      provincias: [province],
      sectores: sector ? [sector] : [],
      subsectores: [],
      tipos_alerta: {},
    },
  };
}

const users = [
  user(1, 'ganaderia'), user(2, 'ganaderia'), user(3, 'mixto'),
  user(4, 'agricultura'), user(5, 'agricultura'), user(6, null),
];
const broadPac = {
  id: 1,
  titulo: 'Reforma general de la PAC',
  contenido: 'Reforma general para explotaciones agrarias y ganaderas.',
  sectores: ['agricultura', 'ganaderia'],
  tipos_alerta: ['normativa_general'],
  provincias: ['nacional'],
};

const legitimate = analizarAlcanceAudiencia(broadPac, users, {
  matcher: () => ({ ok: true, motivo: 'coincide' }),
});
assert.strictEqual(legitimate.reach_ratio, 1);
assert.strictEqual(legitimate.matched_by_reason.coincide, users.length);
assert(legitimate.flags.includes('unexpected_audience_expansion'));
assert.strictEqual(legitimate.action, 'observe', 'el alcance alto por si solo no bloquea');

const dominant = analizarAlcanceAudiencia(broadPac, users, {
  matcher: () => ({ ok: true, motivo: 'coincide' }),
  singleAlertDigestShare: calcularCuotaDominanciaDigest(75, 100),
});
assert.strictEqual(dominant.daily_digest_share, 0.75);
assert(dominant.flags.includes('single_alert_dominates_daily_digest'));
assert.strictEqual(dominant.action, 'observe', 'la dominancia tampoco bloquea sin contradiccion confirmada');

const snapshot = construirSnapshotAlcance(dominant, { fecha: '2026-07-21' });
assert.strictEqual(snapshot.fecha, '2026-07-21');
assert.strictEqual(snapshot.matched_users, users.length);
assert.strictEqual(snapshot.daily_digest_share, 0.75);
assert.strictEqual(Object.hasOwn(snapshot, 'matches'), false, 'el snapshot no persiste IDs incluidos');
assert.strictEqual(Object.hasOwn(snapshot, 'excluded'), false, 'el snapshot no persiste IDs excluidos');

const antibiotics = {
  id: 15110,
  titulo: 'Indicadores de antibioticos veterinarios',
  contenido: 'Sanidad animal para explotaciones ganaderas.',
  sectores: ['ganaderia', 'agricultura', 'mixto'],
  subsectores: [
    'porcino', 'vacuno', 'ovino', 'caprino', 'avicultura', 'cunicultura',
    'equinocultura', 'trigo', 'olivar', 'vinedo', 'hortalizas',
  ],
  tipos_alerta: ['sanidad_animal'],
  provincias: ['nacional'],
  taxonomy_validation: { status: 'incoherent' },
};
const anomalous = analizarAlcanceAudiencia(antibiotics, users, {
  matcher: () => ({ ok: true, motivo: 'coincide' }),
});
assert(anomalous.flags.includes('cross_sector_mass_match'));
assert(anomalous.flags.includes('taxonomy_overbreadth'));
assert.strictEqual(anomalous.matched_by_sector.agriculture_only, 2);
assert.strictEqual(anomalous.action, 'block');

const protectedReach = analizarAlcanceAudiencia(antibiotics, users);
assert.strictEqual(protectedReach.matched_by_sector.agriculture_only || 0, 0);
assert(protectedReach.excluded_by_reason.animal_health_requires_livestock_profile >= 2);

console.log('OK: alcance masivo registra distribucion y solo bloquea contradiccion confirmada');
