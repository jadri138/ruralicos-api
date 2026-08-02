process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  analizarControlExploracion,
  analizarRespuestaExploracion,
  construirPreguntaExploracion,
  detectarZonaIncertidumbre,
  estadoExploracionDesdeMemorias,
  estimarGananciaInformacion,
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
  assert(construirPreguntaExploracion(zona).includes('propias palabras'));
  assert(zona.information_gain > 0.5);

  const mayorGanancia = detectarZonaIncertidumbre({
    perfil: {
      uncertain_topics: [
        { topic: 'formacion', conflict_ratio: 0.1, confidence: 0.9 },
        { topic: 'ayudas_maquinaria', conflict_ratio: 0.9, confidence: 0.3 },
      ],
    },
  });
  assert.strictEqual(mayorGanancia.topic, 'ayudas_maquinaria');
  assert(
    estimarGananciaInformacion({ conflict_ratio: 0.9, confidence: 0.3 }) >
      estimarGananciaInformacion({ conflict_ratio: 0.1, confidence: 0.9 })
  );

  const conversacion = {
    tipo: 'pregunta_exploracion',
    contexto_json: { zona_incertidumbre: zona },
  };
  assert.strictEqual(analizarRespuestaExploracion('sí', conversacion).polarity, 'positive');
  assert.strictEqual(analizarRespuestaExploracion('no', conversacion).polarity, 'negative');
  assert.strictEqual(analizarRespuestaExploracion('sí, pero solo cuando haya ayudas', conversacion), null);

  const pause = analizarControlExploracion('No me preguntes más', conversacion);
  assert.strictEqual(pause.action, 'paused');
  assert.strictEqual(analizarControlExploracion('No quiero preguntas', null).action, 'paused');
  assert.strictEqual(
    estadoExploracionDesdeMemorias([{ contenido: pause.content }]),
    'paused'
  );
  assert.strictEqual(
    analizarControlExploracion('Ahora no, quizá más adelante', conversacion).action,
    'snoozed'
  );

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
  assert.strictEqual(rows[0].scope_value, 'agua_riego');
  assert.strictEqual(rows[0].polarity, 'negative');

  const control = await decidirMensajeMIA({
    mensajeUsuario: 'no quiero preguntas',
    conversacionActiva: conversacion,
    alertasDelDigest: [],
  });
  assert.strictEqual(control.memory_actions[0].tipo, 'mensaje_libre');
  assert(control.memory_actions[0].contenido.endsWith(':paused'));

  const routesSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'modules', 'aprendizaje', 'cerebro.routes.js'),
    'utf8'
  );
  assert(routesSource.includes('const elegible = force || tieneConflictos'));
  assert(routesSource.includes("reason: 'sin_digest_entregado_reciente'"));
  assert(routesSource.includes(".in('delivery_status', ['DELIVERED', 'READ'])"));
  assert(routesSource.includes("app.post('/cerebro/exploracion-diaria'"));

  console.log('OK: MIA entiende matices, respeta pausas y solo pregunta cuando aporta valor');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
