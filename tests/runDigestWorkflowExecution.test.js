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
  if (pathname === '/alertas/generar-resumen-free') return { success: true, procesadas: 0 };
  return { success: true, ok: true };
}

function ejecutarScript(baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        CRON_TOKEN: 'test-cron-token',
        STEP_DELAY_MS: '0',
        HTTP_RETRIES: '0',
        HTTP_TIMEOUT_MS: '5000',
        MAX_LOOPS: '2',
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
    assert(!paths.includes('/tareas/pipeline-tick'), 'no debe consultar el runner reanudable');
    assert(paths.includes('/tareas/scrapers-diario'), 'debe ejecutar los scrapers');
    assert(paths.includes('/alertas/clasificar'), 'debe ejecutar la clasificacion');
    assert(paths.includes('/alertas/preparar-digest'), 'debe preparar los digests');
    assert(paths.includes('/alertas/enviar-digest'), 'debe ejecutar el envio');
    assert.strictEqual(
      paths.filter((pathname) => pathname === '/alertas/clasificar').length,
      2,
      'debe aceptar que la cola quede vacia justo en la ultima vuelta permitida',
    );
    assert(
      paths.indexOf('/tareas/scrapers-diario') < paths.indexOf('/alertas/clasificar') &&
        paths.indexOf('/alertas/clasificar') < paths.indexOf('/alertas/preparar-digest') &&
        paths.indexOf('/alertas/preparar-digest') < paths.indexOf('/alertas/enviar-digest'),
      'debe respetar el orden completo del pipeline',
    );

    const repair = requests.find((request) => request.pathname === '/alertas/reparar-pendientes-ia');
    assert.strictEqual(repair.method, 'POST', 'la reparacion debe conservar el metodo POST');
    assert(requests.every((request) => request.cronToken === 'test-cron-token'), 'todas las llamadas llevan token');
    console.log('OK: el cron ejecuta el pipeline completo en orden sin claims ni recuperacion');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
