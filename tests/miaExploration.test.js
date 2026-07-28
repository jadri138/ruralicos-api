process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
  analizarRespuestaExploracion,
  construirPreguntaExploracion,
  detectarZonaIncertidumbre,
} = require('../src/modules/mia/exploration');
const { decidirMensajeMIA } = require('../src/modules/mia/decisionCore');
const { construirMemoriasEstructuradas } = require('../src/modules/mia/structuredMemory');

async function main() {
  const zona = detectarZonaIncertidumbre({
    perfil: {
      uncertain_topics: [{
        topic: 'agua_riego',
        declared_conflict: true,
        confidence: 0.2,
      }],
    },
  });
  assert.strictEqual(zona.topic, 'agua_riego');
  assert(construirPreguntaExploracion(zona).includes('sí o no'));

  const conversacion = {
    tipo: 'pregunta_exploracion',
    contexto_json: { zona_incertidumbre: zona },
  };
  assert.strictEqual(analizarRespuestaExploracion('sí', conversacion).polarity, 'positive');
  assert.strictEqual(analizarRespuestaExploracion('no', conversacion).polarity, 'negative');

  const positiva = await decidirMensajeMIA({
    mensajeUsuario: 'sí',
    conversacionActiva: conversacion,
    alertasDelDigest: [],
  });
  assert.strictEqual(positiva.intent, 'actualizar_preferencias');
  assert.strictEqual(positiva.memory_actions[0].tipo, 'interes_detectado');

  const negativa = await decidirMensajeMIA({
    mensajeUsuario: 'no',
    conversacionActiva: conversacion,
    alertasDelDigest: [],
  });
  assert.strictEqual(negativa.memory_actions[0].tipo, 'desinteres_detectado');

  const rows = construirMemoriasEstructuradas({
    userId: 1,
    decision: negativa,
    textoOriginal: 'no',
  });
  assert.strictEqual(rows[0].topic, 'agua_riego');
  assert.strictEqual(rows[0].polarity, 'negative');

  console.log('OK: MIA pregunta por conflictos y entiende respuestas cortas sin revision humana');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
