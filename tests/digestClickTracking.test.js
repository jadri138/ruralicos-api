const assert = require('assert');

const {
  prepararMensajeConLinksTracking,
} = require('../src/modules/digest/digest.service');

function fakeSupabase({ error = null } = {}) {
  const calls = [];

  return {
    calls,
    from(table) {
      assert.strictEqual(table, 'alerta_click_links');
      return {
        upsert(rows, options) {
          calls.push({ rows, options });
          return {
            async select() {
              return {
                data: error
                  ? null
                  : rows.map((row) => ({
                    token: row.token,
                    alerta_id: row.alerta_id,
                    url_destino: row.url_destino,
                  })),
                error,
              };
            },
          };
        },
      };
    },
  };
}

async function main() {
  const previousBaseUrl = process.env.CLICK_BASE_URL;
  process.env.CLICK_BASE_URL = 'https://ruralicos.test';

  try {
    const supabase = fakeSupabase();
    const alertas = [
      { id: 11, url: 'https://boletin.test/11' },
      { id: 22, url: 'https://boletin.test/22' },
    ];
    const mensaje = `Primera\n${alertas[0].url}\nSegunda\n${alertas[1].url}`;
    const result = await prepararMensajeConLinksTracking(supabase, {
      mensaje,
      userId: 7,
      digestId: 9,
      alertas: [...alertas, { ...alertas[0] }],
      organizationId: 3,
    });

    assert.strictEqual(supabase.calls.length, 1, 'debe escribir todos los enlaces en un lote');
    assert.strictEqual(
      supabase.calls[0].rows.length,
      2,
      'no debe enviar dos filas con la misma clave de alerta en el mismo lote',
    );
    assert.strictEqual(result.links.length, 2);
    assert.strictEqual(result.enabled, true);
    assert(!result.mensaje.includes('https://boletin.test/11'));
    assert(!result.mensaje.includes('https://boletin.test/22'));
    assert(result.mensaje.includes('https://ruralicos.test/?a='));

    const failingSupabase = fakeSupabase({ error: { message: 'tabla no disponible' } });
    const fallback = await prepararMensajeConLinksTracking(failingSupabase, {
      mensaje,
      userId: 7,
      digestId: 9,
      alertas,
    });

    assert.strictEqual(failingSupabase.calls.length, 1);
    assert.strictEqual(fallback.enabled, false);
    assert.strictEqual(fallback.mensaje, mensaje, 'debe conservar todas las URLs oficiales si falla el lote');
    assert.deepStrictEqual(fallback.links, []);

    console.log('OK: tracking de digest usa una escritura por lote y fallback seguro');
  } finally {
    if (previousBaseUrl === undefined) delete process.env.CLICK_BASE_URL;
    else process.env.CLICK_BASE_URL = previousBaseUrl;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
