#!/usr/bin/env node
/**
 * FASE 1 — Medicion de evidencia/alucinacion (SOLO LECTURA, sin escribir ni enviar).
 *
 * Sobre alertas reales, construye la fact sheet evidence-first (deterministica) y saca
 * un informe: cuantas afirman plazo/territorio sin evidencia, reparto de `status`, y
 * scores medios. NO bloquea nada ni cambia el flujo: solo da los numeros para decidir
 * las fases 2-3.
 *
 * Uso:
 *   node scripts/measure_factsheet_evidence.js --fecha=2026-06-21
 *   node scripts/measure_factsheet_evidence.js --estado=listo --limit=200
 *   node scripts/measure_factsheet_evidence.js --ids=123,456 --detalle
 *
 * Requiere en .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. (No usa OpenAI.)
 */

require('dotenv').config();

function arg(name, def = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const FLAGS_ALUCINACION = [
  'plazo_no_verificado',
  'territorio_no_verificado',
  'sin_url_oficial',
  'resumen_generico',
  'sector_no_verificado',
  'ayuda_sin_beneficiario_o_convocatoria',
];

function pct(part, total) {
  return total ? `${((part / total) * 100).toFixed(1)}%` : '0%';
}

async function main() {
  const faltan = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
  if (faltan.length) {
    console.error(`Faltan variables de entorno: ${faltan.join(', ')}. Configura tu .env.`);
    process.exit(1);
  }

  const { supabase } = require('../src/platform/supabase');
  const { construirFactSheetAlerta } = require('../src/modules/alertas/intelligence/factSheetBuilder');

  const fecha = arg('fecha');
  const ids = arg('ids');
  const estado = arg('estado');
  const detalle = flag('detalle');
  const limit = Math.max(1, Math.min(1000, Number(arg('limit', '100')) || 100));

  let query = supabase
    .from('alertas')
    .select('id, titulo, url, fecha, fuente, region, provincias, sectores, subsectores, tipos_alerta, contenido, resumen_final, resumen, resumen_borrador, organization_id')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (ids) query = query.in('id', ids.split(',').map((s) => s.trim()).filter(Boolean));
  else {
    if (fecha) query = query.eq('fecha', fecha);
    if (estado) query = query.eq('estado_ia', estado);
  }

  const { data: alertas, error } = await query;
  if (error) {
    console.error('Error leyendo alertas:', error.message);
    process.exit(1);
  }
  if (!alertas || alertas.length === 0) {
    console.log('No hay alertas para esos criterios.');
    return;
  }

  const statusCount = {};
  const flagsCount = {};
  let sumTruth = 0;
  let sumRisk = 0;
  let sumCoverage = 0;
  let noAptas = 0;
  const peores = [];

  for (const a of alertas) {
    let sheet;
    try {
      sheet = await construirFactSheetAlerta(a, { supabase, organizationId: a.organization_id });
    } catch (e) {
      flagsCount.__error_build = (flagsCount.__error_build || 0) + 1;
      if (detalle) console.error(`  [build error] alerta ${a.id}: ${e.message}`);
      continue;
    }

    statusCount[sheet.status] = (statusCount[sheet.status] || 0) + 1;
    for (const f of sheet.flags || []) flagsCount[f] = (flagsCount[f] || 0) + 1;
    sumTruth += Number(sheet.truth_score || 0);
    sumRisk += Number(sheet.risk_score || 0);
    sumCoverage += Number(sheet.evidence_coverage || 0);
    if (sheet.status !== 'ready_for_digest') {
      noAptas += 1;
      peores.push({ id: a.id, titulo: a.titulo, status: sheet.status, flags: sheet.flags || [] });
    }
  }

  const n = alertas.length;
  console.log('\n================ INFORME FASE 1 — evidencia/alucinacion ================');
  console.log(`Alertas analizadas: ${n}` + (fecha ? ` (fecha ${fecha})` : '') + (estado ? ` (estado_ia ${estado})` : ''));
  console.log(`Scores medios -> truth: ${(sumTruth / n).toFixed(1)} | risk: ${(sumRisk / n).toFixed(1)} | coverage: ${(sumCoverage / n).toFixed(2)}`);
  console.log(`No aptas para digest automatico (status != ready_for_digest): ${noAptas} (${pct(noAptas, n)})`);

  console.log('\n-- Reparto de status --');
  for (const [k, v] of Object.entries(statusCount).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${k}: ${v} (${pct(v, n)})`);
  }

  console.log('\n-- Senales de alucinacion (afirma sin evidencia) --');
  for (const f of FLAGS_ALUCINACION) {
    console.log(`  ${f}: ${flagsCount[f] || 0} (${pct(flagsCount[f] || 0, n)})`);
  }

  console.log('\n-- Todos los flags (desc) --');
  for (const [k, v] of Object.entries(flagsCount).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${k}: ${v}`);
  }

  if (detalle && peores.length) {
    console.log('\n-- Detalle de no aptas --');
    for (const p of peores.slice(0, 50)) {
      console.log(`  [${p.status}] ${p.id} ${String(p.titulo || '').slice(0, 80)} :: ${p.flags.join(', ')}`);
    }
  }
  console.log('\n(Medicion en sombra: no se ha bloqueado ni modificado ninguna alerta.)\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
