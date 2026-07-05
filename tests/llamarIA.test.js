process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.IA_RUNS_LOG = 'false';

const assert = require('assert');
const { llamarIA, parsearJSON, __testing } = require('../src/platform/ia/llamarIA');
const { esReintentableIA } = __testing;

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`OK: ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`FAIL: ${name}`);
      console.error(err.message);
      process.exitCode = 1;
    });
}

function respuestaOk(texto, usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ output_text: texto, usage }),
  };
}

function respuestaError(status, body = '{"error":{"message":"boom"}}') {
  return {
    ok: false,
    status,
    text: async () => body,
  };
}

function fakeFetch(secuencia) {
  const llamadas = [];
  const fetchImpl = async (url, opts) => {
    llamadas.push({ url, opts });
    const paso = secuencia[Math.min(llamadas.length - 1, secuencia.length - 1)];
    if (paso instanceof Error) throw paso;
    return paso;
  };
  return { fetchImpl, llamadas };
}

const OPTS_RAPIDAS = { retries: 2, retryDelayMs: 1, timeoutMs: 5000 };

async function main() {
  console.log('\n=== TESTS: llamarIA (timeout, reintentos, contrato) ===\n');

  await test('devuelve el texto en la primera llamada correcta', async () => {
    const { fetchImpl, llamadas } = fakeFetch([respuestaOk('hola mundo')]);
    const texto = await llamarIA('prompt', 'instr', 'gpt-4o-mini', { ...OPTS_RAPIDAS, fetchImpl });
    assert.strictEqual(texto, 'hola mundo');
    assert.strictEqual(llamadas.length, 1);
    const body = JSON.parse(llamadas[0].opts.body);
    assert.strictEqual(body.model, 'gpt-4o-mini');
    assert.strictEqual(body.input, 'prompt');
    assert.strictEqual(body.instructions, 'instr');
    assert(llamadas[0].opts.signal, 'debe llevar señal de timeout');
  });

  await test('reintenta en 429 transitorio y termina bien', async () => {
    const { fetchImpl, llamadas } = fakeFetch([
      respuestaError(429, '{"error":{"message":"rate limit"}}'),
      respuestaOk('segundo intento'),
    ]);
    const texto = await llamarIA('p', 'i', 'gpt-5-nano', { ...OPTS_RAPIDAS, fetchImpl });
    assert.strictEqual(texto, 'segundo intento');
    assert.strictEqual(llamadas.length, 2);
  });

  await test('reintenta en error de red y termina bien', async () => {
    const { fetchImpl, llamadas } = fakeFetch([
      new Error('fetch failed'),
      respuestaOk('recuperado'),
    ]);
    const texto = await llamarIA('p', 'i', 'gpt-4o-mini', { ...OPTS_RAPIDAS, fetchImpl });
    assert.strictEqual(texto, 'recuperado');
    assert.strictEqual(llamadas.length, 2);
  });

  await test('NO reintenta en 400 (error permanente)', async () => {
    const { fetchImpl, llamadas } = fakeFetch([respuestaError(400, 'bad request')]);
    await assert.rejects(
      () => llamarIA('p', 'i', 'gpt-4o-mini', { ...OPTS_RAPIDAS, fetchImpl }),
      /Error OpenAI 400/
    );
    assert.strictEqual(llamadas.length, 1);
  });

  await test('NO reintenta un 429 por cuota agotada', async () => {
    const { fetchImpl, llamadas } = fakeFetch([
      respuestaError(429, '{"error":{"message":"You exceeded your current quota"}}'),
    ]);
    await assert.rejects(
      () => llamarIA('p', 'i', 'gpt-4o-mini', { ...OPTS_RAPIDAS, fetchImpl }),
      /Error OpenAI 429/
    );
    assert.strictEqual(llamadas.length, 1);
  });

  await test('agota reintentos en 503 persistente y propaga el ultimo error', async () => {
    const { fetchImpl, llamadas } = fakeFetch([respuestaError(503)]);
    await assert.rejects(
      () => llamarIA('p', 'i', 'gpt-4o-mini', { ...OPTS_RAPIDAS, fetchImpl }),
      /Error OpenAI 503/
    );
    assert.strictEqual(llamadas.length, 3, '1 intento + 2 reintentos');
  });

  await test('mantiene el contrato de options (textFormat, maxOutputTokens, reasoning)', async () => {
    const { fetchImpl, llamadas } = fakeFetch([respuestaOk('ok')]);
    await llamarIA('p', 'i', 'gpt-5', {
      ...OPTS_RAPIDAS,
      fetchImpl,
      textFormat: { type: 'json_object' },
      maxOutputTokens: 500,
      reasoning: { effort: 'low' },
    });
    const body = JSON.parse(llamadas[0].opts.body);
    assert.deepStrictEqual(body.text, { format: { type: 'json_object' } });
    assert.strictEqual(body.max_output_tokens, 500);
    assert.deepStrictEqual(body.reasoning, { effort: 'low' });
  });

  await test('esReintentableIA clasifica bien los casos', () => {
    assert.strictEqual(esReintentableIA({ status: 429, body: 'rate limit' }), true);
    assert.strictEqual(esReintentableIA({ status: 503 }), true);
    assert.strictEqual(esReintentableIA({ status: 400 }), false);
    assert.strictEqual(esReintentableIA({ status: 401 }), false);
    assert.strictEqual(esReintentableIA({ status: 429, body: 'insufficient_quota' }), false);
    assert.strictEqual(esReintentableIA({ errorMessage: 'fetch failed' }), true);
    assert.strictEqual(esReintentableIA({ errorMessage: 'The operation was aborted due to timeout' }), true);
    assert.strictEqual(esReintentableIA({ errorMessage: 'algo raro' }), false);
  });

  await test('parsearJSON sigue limpiando fences y extrayendo el primer JSON', () => {
    assert.deepStrictEqual(parsearJSON('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(parsearJSON('bla bla {"a":{"b":2}} y mas texto'), { a: { b: 2 } });
    assert.deepStrictEqual(parsearJSON({ ya: 'objeto' }), { ya: 'objeto' });
  });

  console.log(`\nResultados llamarIA: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

main();
