#!/usr/bin/env node
/**
 * Inspector de calidad de FICHAS (paso "resumir") — SOLO LECTURA.
 * No envia WhatsApp y no escribe en la base de datos.
 *
 * Compara, sobre alertas reales, el `resumen_final` ACTUAL guardado en BD con la ficha
 * que genera el prompt actual del codigo (grounding reforzado: `no_detectado` cuando el
 * dato no consta). Sirve para comprobar a ojo que la IA deja de inventar plazos/importes.
 *
 * Uso:
 *   node scripts/compare_fichas.js --fecha=2026-06-21 --limit=10
 *   node scripts/compare_fichas.js --ids=123,456
 *
 * Para un A/B real contra la version anterior: ejecuta este mismo script en la rama
 * actual y en `main`, y compara las salidas.
 *
 * Requiere en .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY.
 */

require('dotenv').config();

function arg(name, def = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

async function main() {
  const faltan = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']
    .filter((k) => !process.env[k]);
  if (faltan.length) {
    console.error(`Faltan variables de entorno: ${faltan.join(', ')}. Configura tu .env.`);
    process.exit(1);
  }

  const { supabase } = require('../src/platform/supabase');
  const { generarFichasIAEnLote } = require('../src/modules/alertas/alertas.service');

  const fecha = arg('fecha');
  const ids = arg('ids');
  const limit = Math.max(1, Math.min(30, Number(arg('limit', '10')) || 10));

  let query = supabase
    .from('alertas')
    .select('id, titulo, fecha, fuente, region, provincias, sectores, subsectores, tipos_alerta, contenido, resumen_final')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (ids) query = query.in('id', ids.split(',').map((s) => s.trim()).filter(Boolean));
  else if (fecha) query = query.eq('fecha', fecha);

  const { data: alertas, error } = await query;
  if (error) {
    console.error('Error leyendo alertas:', error.message);
    process.exit(1);
  }
  if (!alertas || alertas.length === 0) {
    console.log('No hay alertas para esos criterios.');
    return;
  }

  console.log(`\nGenerando fichas para ${alertas.length} alertas (solo lectura, sin escribir en BD)...\n`);
  const { resultados } = await generarFichasIAEnLote(alertas);
  const porId = new Map((resultados || []).map((r) => [String(r.id), r]));

  for (const a of alertas) {
    const nueva = porId.get(String(a.id));
    const fichaNueva = nueva ? (nueva.ficha || JSON.stringify(nueva, null, 2)) : '(sin resultado)';
    console.log('='.repeat(72));
    console.log(`ALERTA ${a.id} - ${a.titulo}`);
    console.log('--- resumen_final ACTUAL (BD) ---');
    console.log((a.resumen_final || '(vacio)').slice(0, 700));
    console.log('--- ficha NUEVA (prompt actual) ---');
    console.log(String(fichaNueva).slice(0, 700));
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
