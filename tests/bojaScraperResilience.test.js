const assert = require('assert');
const {
  obtenerDocumentosBojaPorFecha,
  __testing,
} = require('../src/modules/boletines/scrapers/BOJA/bojaScraper');

function transientError() {
  const error = new Error('socket reset');
  error.code = 'ECONNRESET';
  return error;
}

(async () => {
  assert.strictEqual(__testing.esFinDeSemanaYYYYMMDD('20260815'), true);
  assert.strictEqual(__testing.esFinDeSemanaYYYYMMDD('20260816'), true);
  assert.strictEqual(__testing.esFinDeSemanaYYYYMMDD('20260817'), false);
  assert.strictEqual(__testing.esFinDeSemanaYYYYMMDD('20260230'), false);

  let weekendRequests = 0;
  const weekend = await obtenerDocumentosBojaPorFecha('20260816', {
    request: async () => {
      weekendRequests += 1;
      throw new Error('no debería consultar la API');
    },
  });
  assert.deepStrictEqual(weekend, []);
  assert.strictEqual(weekendRequests, 0, 'el fin de semana no depende de la disponibilidad remota');

  let calendarAttempts = 0;
  const request = async (url, config) => {
    assert(config.timeout > 0 && config.timeout <= 7000, 'cada intento queda acotado');
    if (url.includes('/get/calendar')) {
      calendarAttempts += 1;
      if (calendarAttempts === 1) throw transientError();
      return { data: { rows: [['153', '17/08/2026']] } };
    }
    if (url.includes('/get/bulletin')) {
      return {
        data: {
          total_hits: 1,
          results: [{
            dispositionNumber: '1',
            summaryNoHtml: 'Convocatoria de ayudas agrarias',
            bodyNoHtml: 'Plazo de solicitud para explotaciones agrarias.',
            organisation: 'Consejería de Agricultura',
            sectionN1: 'Subvenciones',
          }],
        },
      };
    }
    throw new Error(`URL inesperada: ${url}`);
  };

  const docs = await obtenerDocumentosBojaPorFecha('20260817', {
    request,
    sleep: async () => {},
    env: {
      BOJA_TOTAL_BUDGET_MS: '15000',
      BOJA_HTTP_TIMEOUT_MS: '7000',
      BOJA_HTTP_ATTEMPTS: '2',
      BOJA_RETRY_BACKOFF_MS: '1',
    },
  });

  assert.strictEqual(calendarAttempts, 2, 'recupera un ECONNRESET con un reintento');
  assert.strictEqual(docs.length, 1);
  assert.strictEqual(docs[0].fecha, '2026-08-17');
  assert(docs[0].texto.includes('explotaciones agrarias'));

  let fatalAttempts = 0;
  await assert.rejects(
    __testing.solicitarJsonBoja('https://boja.test/fatal', {
      request: async () => {
        fatalAttempts += 1;
        const error = new Error('bad request');
        error.response = { status: 400 };
        throw error;
      },
      env: { BOJA_HTTP_ATTEMPTS: '3' },
    }),
    /bad request/
  );
  assert.strictEqual(fatalAttempts, 1, 'no reintenta errores HTTP no recuperables');

  console.log('OK: BOJA evita fines de semana y recupera fallos transitorios con presupuesto acotado');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
