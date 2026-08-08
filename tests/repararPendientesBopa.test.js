// El paso de reparacion debe arrastrar el rescate de evidencia de BOPA.
//
// Incidente 8-08-2026: `bopaEvidenceRecovery` existia, estaba probado y solo se
// podia lanzar a mano, asi que 48 de las 118 alertas del dia se quedaron en
// `needs_evidence` para siempre y solo 6 llegaron a `listo`. Se cuelga del paso
// que ya corre antes de clasificar para que lo recuperado siga su curso en la
// misma pasada, y un fallo suyo no puede tumbar la reparacion principal.
const assert = require('assert');
const path = require('path');

const RUTA_RECOVERY = path.join(
  __dirname,
  '..',
  'src',
  'modules',
  'boletines',
  'scrapers',
  'BOPA',
  'bopaEvidenceRecovery.js'
);
const RUTA_RUTAS = path.join(__dirname, '..', 'src', 'modules', 'alertas', 'alertas.routes.js');

let aprobados = 0;
function ok(nombre) {
  aprobados++;
  console.log(`OK: ${nombre}`);
}

// Sustituye el modulo real por un doble antes de que la ruta lo cargue.
function inyectarRecovery(implementacion) {
  delete require.cache[require.resolve(RUTA_RECOVERY)];
  require.cache[require.resolve(RUTA_RECOVERY)] = {
    id: require.resolve(RUTA_RECOVERY),
    filename: require.resolve(RUTA_RECOVERY),
    loaded: true,
    exports: { recuperarAlertasBopaSinEvidencia: implementacion },
  };
}

// Supabase minimo: no hay alertas con estado_ia nulo, que es el camino corto de
// la ruta y el que mas facil deja fuera al rescate si se coloca mal.
function supabaseSinPendientes() {
  return {
    from() {
      const query = {
        select() { return query; },
        eq() { return query; },
        is() { return Promise.resolve({ data: [], error: null }); },
        in() { return Promise.resolve({ data: [], error: null }); },
        update() { return query; },
      };
      return query;
    },
  };
}

const TOKEN = 'test-token-reparar-bopa';

// Express de juguete: solo captura el handler de la ruta que interesa.
function capturarRuta(supabase) {
  const handlers = new Map();
  const app = { post: (ruta, handler) => handlers.set(ruta, handler), get: () => {} };
  delete require.cache[require.resolve(RUTA_RUTAS)];
  const registrar = require(RUTA_RUTAS);
  registrar(app, supabase);
  return handlers.get('/alertas/reparar-pendientes-ia');
}

function peticion(query = {}) {
  return {
    query,
    body: {},
    get: (cabecera) => (String(cabecera).toLowerCase() === 'x-cron-token' ? TOKEN : ''),
  };
}

function respuesta() {
  const captura = { statusCode: 200, body: null };
  return {
    captura,
    status(code) { captura.statusCode = code; return this; },
    json(body) { captura.body = body; return this; },
  };
}

async function main() {
  // Se fija a la fuerza: el .env del entorno traeria el token real y la ruta
  // responderia 403 antes de llegar al rescate.
  process.env.CRON_TOKEN = TOKEN;

  // 1. La reparacion ejecuta el rescate de BOPA y lo hace en modo real.
  {
    const llamadas = [];
    inyectarRecovery(async (_supabase, opciones) => {
      llamadas.push(opciones);
      return { dry_run: false, total: 48, recovered: 40, missing: 8, errors: 0 };
    });
    const handler = capturarRuta(supabaseSinPendientes());
    if (typeof handler !== 'function') {
      throw new Error('la ruta /alertas/reparar-pendientes-ia no quedo registrada');
    }
    const res = respuesta();
    await handler(peticion({ fecha: '2026-08-08' }), res);

    assert.strictEqual(llamadas.length, 1, 'el rescate de BOPA se ejecuta en cada reparacion');
    assert.strictEqual(llamadas[0].fecha, '2026-08-08', 'se rescata la fecha que se repara');
    assert.strictEqual(
      llamadas[0].dryRun,
      false,
      'en produccion debe escribir: un dry-run dejaria las alertas atascadas igual'
    );
    assert.strictEqual(res.captura.statusCode, 200);
    assert.strictEqual(res.captura.body.bopa_evidencia.recovered, 40, 'el resultado queda a la vista');
    ok('La reparacion diaria arrastra el rescate de evidencia de BOPA');
  }

  // 2. Si el rescate falla, la reparacion principal sigue respondiendo.
  {
    inyectarRecovery(async () => {
      throw new Error('BOPA no responde');
    });
    const handler = capturarRuta(supabaseSinPendientes());
    const res = respuesta();
    await handler(peticion({ fecha: '2026-08-08' }), res);

    assert.strictEqual(res.captura.statusCode, 200, 'un BOPA caido no rompe el paso');
    assert.strictEqual(res.captura.body.success, true);
    assert.strictEqual(res.captura.body.bopa_evidencia.ok, false);
    assert.match(res.captura.body.bopa_evidencia.error, /BOPA no responde/);
    ok('Un fallo del rescate no tumba la reparacion ni el workflow');
  }

  delete require.cache[require.resolve(RUTA_RECOVERY)];
  console.log(`\nResultados reparar+BOPA: ${aprobados} aprobados, 0 fallidos`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
