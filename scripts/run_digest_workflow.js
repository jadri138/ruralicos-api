#!/usr/bin/env node
/**
 * Ejecuta el pipeline diario completo de Ruralicos con reintentos por lotes.
 *
 * Uso:
 *   BASE_URL="https://tu-api.onrender.com" CRON_TOKEN="xxx" node scripts/run_digest_workflow.js
 *
 * Variables opcionales:
 *   MAX_LOOPS=40
 *   STEP_DELAY_MS=800
 */

const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const CRON_TOKEN = process.env.CRON_TOKEN || '';
const MAX_LOOPS = Number(process.env.MAX_LOOPS || 40);
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS || 800);

if (!BASE_URL) {
  console.error('Falta BASE_URL');
  process.exit(1);
}

if (!CRON_TOKEN) {
  console.error('Falta CRON_TOKEN');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hit(path) {
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(CRON_TOKEN)}`;
  const res = await fetch(url, { method: 'GET' });

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = { raw: await res.text() };
  }

  if (!res.ok) {
    throw new Error(`[${res.status}] ${path} -> ${JSON.stringify(body)}`);
  }

  return body;
}

async function runBatchedStep(name, path) {
  let loops = 0;
  let total = 0;

  while (loops < MAX_LOOPS) {
    loops++;
    const body = await hit(path);
    const procesadas = Number(body?.procesadas ?? 0);
    total += procesadas;

    console.log(`[${name}] vuelta ${loops}: procesadas=${procesadas}`);

    if (procesadas === 0) break;
    await sleep(STEP_DELAY_MS);
  }

  if (loops === MAX_LOOPS) {
    console.warn(`[${name}] alcanzó MAX_LOOPS=${MAX_LOOPS}. Puede quedar trabajo pendiente.`);
  }

  return { loops, total };
}

async function runSingleStep(name, path) {
  const body = await hit(path);
  console.log(`[${name}]`, body);
  return body;
}

async function main() {
  console.log('▶ Iniciando workflow digest diario...');

  const clasificar = await runBatchedStep('clasificar', '/alertas/clasificar');
  const resumir = await runBatchedStep('resumir', '/alertas/resumir');
  const revisar = await runBatchedStep('revisar', '/alertas/revisar');

  const deduplicar = await runSingleStep('deduplicar', '/alertas/deduplicar');
  const cicloEmbeddings = await runSingleStep('ciclo-embeddings', '/embeddings/ciclo-completo');
  const prepararDigest = await runSingleStep('preparar-digest', '/alertas/preparar-digest');
  const enviarDigest = await runSingleStep('enviar-digest', '/alertas/enviar-digest');

  const generarFree = await runSingleStep('generar-resumen-free', '/alertas/generar-resumen-free');
  const enviarFree = await runSingleStep('enviar-resumen-free', '/alertas/enviar-resumen-free');

  console.log('✅ Workflow completado', {
    clasificar,
    resumir,
    revisar,
    deduplicar: deduplicar?.deduplicadas ?? null,
    cicloEmbeddings: cicloEmbeddings?.ok ?? null,
    prepararDigest: prepararDigest?.digests_generados ?? null,
    enviarDigest: enviarDigest?.enviados ?? null,
    generarFree: generarFree?.procesadas ?? null,
    enviarFree: enviarFree?.ok ?? null,
  });
}

main().catch((err) => {
  console.error('❌ Error en workflow:', err.message);
  process.exit(1);
});

