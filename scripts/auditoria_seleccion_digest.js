// scripts/auditoria_seleccion_digest.js
//
// Auditoría A8: ¿por qué usuarios con alertas coincidentes acaban sin digest?
// Agrega los motivos de exclusión de digest_attempts (metadata seleccion_base/
// seleccion_final) y de digest_candidate_decisions (selection/final_validation)
// para responder si el gate de selección/validación está cortando de más
// (sospechosos: score_insuficiente y review_only retenidos que nadie revisa).
//
// Uso: node scripts/auditoria_seleccion_digest.js [dias]   (default 10)
// Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY reales en el entorno.

require('dotenv').config();
const { supabase } = require('../src/platform/supabase');

const dias = Math.max(1, Math.min(60, Number(process.argv[2] || 10)));
const desde = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString().slice(0, 10);

function contar(mapa, clave, n = 1) {
  mapa.set(clave, (mapa.get(clave) || 0) + n);
}

function top(mapa, n = 15) {
  return [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function imprimir(titulo, mapa, n) {
  console.log(`\n== ${titulo} ==`);
  for (const [clave, valor] of top(mapa, n)) {
    console.log(`  ${String(valor).padStart(6)}  ${clave}`);
  }
}

(async () => {
  console.log(`Auditoría de selección de digest desde ${desde} (${dias} días)\n`);

  const { data: attempts, error: errAttempts } = await supabase
    .from('digest_attempts')
    .select('fecha, user_id, status, motivo_no_envio, metadata_json')
    .gte('fecha', desde)
    .neq('status', 'sent')
    .order('fecha', { ascending: false })
    .limit(3000);
  if (errAttempts) throw new Error(`digest_attempts: ${errAttempts.message}`);

  console.log(`Intentos no enviados: ${attempts.length}`);

  const porMotivo = new Map();
  const motivosSeleccionBase = new Map();
  const motivosSeleccionFinal = new Map();
  let conRetenidasReviewOnly = 0;

  for (const attempt of attempts) {
    contar(porMotivo, attempt.motivo_no_envio || attempt.status);

    const meta = attempt.metadata_json || {};
    if (attempt.motivo_no_envio === 'seleccion_sin_alertas_enviables') {
      for (const [motivo, n] of Object.entries(meta.seleccion_base?.motivos || {})) {
        contar(motivosSeleccionBase, motivo, Number(n) || 0);
      }
      for (const [motivo, n] of Object.entries(meta.seleccion_final?.motivos || {})) {
        contar(motivosSeleccionFinal, motivo, Number(n) || 0);
      }
    }
    if (Array.isArray(meta.retenidas_review_only) && meta.retenidas_review_only.length) {
      conRetenidasReviewOnly += 1;
    }
  }

  imprimir('Intentos no enviados por motivo', porMotivo);
  imprimir('seleccion_sin_alertas_enviables → motivos en seleccion_base (alerta × usuario)', motivosSeleccionBase);
  imprimir('seleccion_sin_alertas_enviables → motivos en seleccion_final', motivosSeleccionFinal);
  console.log(`\nIntentos con alertas retenidas por review_only: ${conRetenidasReviewOnly}`);

  const { data: decisiones, error: errDecisiones } = await supabase
    .from('digest_candidate_decisions')
    .select('stage, action, motivo')
    .gte('fecha', desde)
    .in('stage', ['selection', 'final_validation'])
    .limit(20000);
  if (errDecisiones) throw new Error(`digest_candidate_decisions: ${errDecisiones.message}`);

  console.log(`\nDecisiones candidatas (selection + final_validation): ${decisiones.length}`);

  const porStageAction = new Map();
  const motivosExclusion = new Map();
  for (const decision of decisiones) {
    contar(porStageAction, `${decision.stage} / ${decision.action}`);
    if (decision.action !== 'include') {
      contar(motivosExclusion, `${decision.stage} · ${decision.action}: ${decision.motivo}`);
    }
  }

  imprimir('stage / action', porStageAction, 20);
  imprimir('Top motivos de exclusión', motivosExclusion, 20);
})().catch((err) => {
  console.error('FALLO:', err.message);
  process.exit(1);
});
