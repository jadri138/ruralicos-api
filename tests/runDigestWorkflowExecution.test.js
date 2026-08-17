const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const scriptPath = path.join(__dirname, '..', 'scripts', 'run_digest_workflow.js');

function respuestaPara(pathname, attempt) {
  if (['/alertas/clasificar', '/alertas/resumir', '/alertas/revisar'].includes(pathname)) {
    if (pathname === '/alertas/clasificar' && attempt === 1) {
      return { procesadas: 1, actualizadas: 1 };
    }
    return { procesadas: 0, actualizadas: 0 };
  }
  if (pathname === '/alertas/preparar-digest') {
    return { procesadas: 0, actualizadas: 0, digests_generados: 0, rescates_generados: 0 };
  }
  if (pathname === '/alertas/enviar-digest') return { success: true, enviados: 0 };
  if (pathname === '/tareas/mia-outbox') {
    return { success: true, procesados: 0, aceptados: 0, fallidos: 0 };
  }
  if (pathname === '/tareas/hold-evidence-recovery') {
    if (attempt <= 2) {
      return { success: true, processed: 25, recovered: 1, has_more: true };
    }
    return { success: true, processed: 3, recovered: 0, has_more: false };
  }
  if (pathname === '/cerebro/exploracion-diaria') return { ok: true, encoladas: 1 };
  if (pathname === '/tareas/shadow-v2') {
    if (attempt <= 2) {
      return {
        success: true,
        done: false,
        workflow_run_key: '11111111-1111-5111-8111-111111111111',
        stopped: 'max_alerts',
        processed: 25,
        calls: 2,
        errors: 0,
      };
    }
    return {
      success: true,
      done: true,
      workflow_run_key: '11111111-1111-5111-8111-111111111111',
      stopped: null,
      processed: 3,
      calls: 1,
      errors: 0,
    };
  }
  if (pathname === '/tareas/promover-digest-v2') {
    return {
      success: true,
      paid_runs: 2,
      promoted: 1,
      already_promoted: 0,
      no_send: 1,
      errors: [],
    };
  }
  if (pathname === '/alertas/generar-resumen-free') return { success: true, procesadas: 0 };
  return { success: true, ok: true };
}

function ejecutarScript(baseUrl, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        CRON_TOKEN: 'test-cron-token',
        STEP_DELAY_MS: '0',
        HTTP_RETRIES: '1',
        HTTP_RETRY_DELAY_MS: '0',
        HTTP_TIMEOUT_MS: '5000',
        MAX_LOOPS: '2',
        HOLD_RECOVERY_MAX_LOOPS: '4',
        SHADOW_V2_MAX_LOOPS: '3',
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('el workflow de prueba no termino en 15 segundos'));
    }, 15_000);

    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  const requests = [];
  const attempts = new Map();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const attempt = Number(attempts.get(pathname) || 0) + 1;
    attempts.set(pathname, attempt);
    requests.push({
      method: req.method,
      pathname,
      cronToken: req.headers['x-cron-token'],
    });
    if (pathname === '/tareas/shadow-v2' && attempt === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'fallo transitorio simulado' }));
      return;
    }
    const body = respuestaPara(pathname, attempt);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = await ejecutarScript(`http://127.0.0.1:${port}`);
    assert.strictEqual(result.code, 0, result.stderr || result.stdout);

    const paths = requests.map((request) => request.pathname);
    assert(paths.includes('/tareas/scrapers-diario'), 'debe ejecutar los scrapers');
    assert(paths.includes('/alertas/clasificar'), 'debe ejecutar la clasificacion');
    assert(paths.includes('/tareas/hold-evidence-recovery'), 'debe recuperar HOLD pendientes');
    assert(paths.includes('/alertas/preparar-digest'), 'debe preparar los digests');
    assert(paths.includes('/alertas/enviar-digest'), 'debe ejecutar el envio');
    assert(paths.includes('/tareas/mia-outbox'), 'debe vaciar la cola dentro del mismo workflow');
    assert(paths.includes('/tareas/whatsapp-reconcile'), 'debe conciliar estados dentro del mismo workflow');
    assert(paths.includes('/cerebro/exploracion-diaria'), 'debe evaluar preguntas selectivas al final');
    assert(paths.includes('/tareas/shadow-v2'), 'debe ejecutar shadow-v2 al final');
    const mutatingPaths = new Set([
      '/alertas/clasificar',
      '/alertas/resumir',
      '/alertas/revisar',
      '/alertas/deduplicar',
      '/tareas/hold-evidence-recovery',
      '/alertas/preparar-digest',
      '/alertas/enviar-digest',
      '/tareas/mia-outbox',
      '/tareas/whatsapp-reconcile',
      '/cerebro/exploracion-diaria',
      '/alertas/generar-resumen-free',
      '/alertas/enviar-resumen-free',
      '/tareas/shadow-v2',
    ]);
    for (const request of requests.filter((item) => mutatingPaths.has(item.pathname))) {
      assert.strictEqual(request.method, 'POST', `${request.pathname} debe usar POST`);
    }
    assert.strictEqual(
      paths.filter((pathname) => pathname === '/alertas/clasificar').length,
      2,
      'debe aceptar que la cola quede vacia justo en la ultima vuelta permitida',
    );
    assert.strictEqual(
      paths.filter((pathname) => pathname === '/tareas/mia-outbox').length,
      2,
      'debe usar la misma cola otra vez solo para las preguntas que acaba de encolar',
    );
    assert.strictEqual(
      paths.filter((pathname) => pathname === '/tareas/hold-evidence-recovery').length,
      3,
      'debe drenar dos lotes completos y detenerse al llegar al lote corto',
    );
    const firstOutboxIndex = paths.indexOf('/tareas/mia-outbox');
    const reconcileIndex = paths.indexOf('/tareas/whatsapp-reconcile');
    const explorationIndex = paths.indexOf('/cerebro/exploracion-diaria');
    const lastOutboxIndex = paths.lastIndexOf('/tareas/mia-outbox');
    const shadowIndex = paths.indexOf('/tareas/shadow-v2');
    assert(
      paths.indexOf('/tareas/scrapers-diario') < paths.indexOf('/alertas/clasificar') &&
        paths.indexOf('/alertas/clasificar') < paths.indexOf('/tareas/hold-evidence-recovery') &&
        paths.lastIndexOf('/tareas/hold-evidence-recovery') < paths.indexOf('/alertas/preparar-digest') &&
        paths.indexOf('/alertas/preparar-digest') < paths.indexOf('/alertas/enviar-digest') &&
        paths.indexOf('/alertas/enviar-digest') < firstOutboxIndex &&
        firstOutboxIndex < reconcileIndex &&
        reconcileIndex < explorationIndex &&
        explorationIndex < lastOutboxIndex &&
        lastOutboxIndex < shadowIndex,
      'debe respetar el orden completo del pipeline',
    );
    assert.strictEqual(
      paths.filter((pathname) => pathname === '/tareas/shadow-v2').length,
      3,
      'shadow-v2 debe reintentar un 500 y reanudar lotes hasta completar la fecha',
    );

    const repair = requests.find((request) => request.pathname === '/alertas/reparar-pendientes-ia');
    assert.strictEqual(repair.method, 'POST', 'la reparacion debe conservar el metodo POST');
    assert(requests.every((request) => request.cronToken === 'test-cron-token'), 'todas las llamadas llevan token');
    console.log('OK: el cron V1 ejecuta el workflow completo en orden');

    requests.length = 0;
    attempts.clear();
    const v2Result = await ejecutarScript(`http://127.0.0.1:${port}`, { DIGEST_ENGINE: 'v2' });
    assert.strictEqual(v2Result.code, 0, v2Result.stderr || v2Result.stdout);
    const v2Paths = requests.map((request) => request.pathname);
    assert(!v2Paths.includes('/alertas/preparar-digest'), 'V2 no debe preparar ni generar digests con V1');
    assert(v2Paths.includes('/tareas/shadow-v2'), 'V2 debe ejecutar su motor completo');
    assert(v2Paths.includes('/tareas/promover-digest-v2'), 'V2 debe promover solo despues de completar shadow');
    assert(v2Paths.includes('/alertas/enviar-digest'), 'V2 reutiliza la unica cola productiva');
    const v2ShadowLast = v2Paths.lastIndexOf('/tareas/shadow-v2');
    const v2Promote = v2Paths.indexOf('/tareas/promover-digest-v2');
    const v2Enqueue = v2Paths.indexOf('/alertas/enviar-digest');
    const v2Outbox = v2Paths.indexOf('/tareas/mia-outbox');
    assert(
      v2ShadowLast < v2Promote && v2Promote < v2Enqueue && v2Enqueue < v2Outbox,
      'V2 debe completar, promover, encolar y entregar en ese orden',
    );
    assert.strictEqual(
      v2Paths.filter((pathname) => pathname === '/tareas/shadow-v2').length,
      3,
      'V2 productiva conserva reintento HTTP e idempotencia por run-key',
    );
    assert.strictEqual(
      v2Paths.filter((pathname) => pathname === '/tareas/promover-digest-v2').length,
      1,
      'la promocion completa se ejecuta una sola vez',
    );
    console.log('OK: el cron V2 sustituye la preparacion V1 sin crear un segundo emisor');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
