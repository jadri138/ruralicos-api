const {
  ipConocida,
  __testing: { cacheIps, resolverDoH, resolverIpResiliente, lookupSistemaConTimeout, crearLookup },
} = require('../src/platform/dnsResiliente');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

function fetcherDoH(respuesta, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => respuesta,
  });
}

const lookupOk = (ip) => (hostname, options, cb) => cb(null, ip);
const lookupFalla = (hostname, options, cb) => cb(Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }));
const lookupColgado = () => {};

(async () => {
  // ── resolverDoH ──
  const ips = await resolverDoH('ejemplo.es', {
    fetcher: fetcherDoH({
      Answer: [
        { name: 'ejemplo.es.', type: 5, data: 'alias.ejemplo.es.' },
        { name: 'ejemplo.es.', type: 1, data: '10.0.0.1' },
        { name: 'ejemplo.es.', type: 1, data: '10.0.0.2' },
      ],
    }),
  });
  assert(ips.length === 2 && ips[0] === '10.0.0.1', 'resolverDoH devuelve solo registros A en orden');

  let error = null;
  try {
    await resolverDoH('ejemplo.es', { fetcher: fetcherDoH({ Answer: [] }) });
  } catch (err) {
    error = err;
  }
  assert(error && /sin registros A/.test(error.message), 'resolverDoH falla si no hay registros A');

  error = null;
  try {
    await resolverDoH('ejemplo.es', { fetcher: fetcherDoH({}, { ok: false, status: 502 }) });
  } catch (err) {
    error = err;
  }
  assert(error && /HTTP 502/.test(error.message), 'resolverDoH falla si DoH devuelve error HTTP');

  // ── lookupSistemaConTimeout ──
  error = null;
  try {
    await lookupSistemaConTimeout('colgado.es', { lookup: lookupColgado, timeoutMs: 50 });
  } catch (err) {
    error = err;
  }
  assert(error && error.code === 'EDNSTIMEOUT', 'lookupSistemaConTimeout corta un lookup colgado');

  // ── resolverIpResiliente: sistema OK ──
  cacheIps.clear();
  let resultado = await resolverIpResiliente('portal.es', { lookup: lookupOk('1.1.1.1') });
  assert(resultado.ip === '1.1.1.1' && resultado.origen === 'sistema', 'Usa el DNS del sistema cuando funciona');
  assert(ipConocida('portal.es')?.ip === '1.1.1.1', 'Cachea la IP resuelta por el sistema');

  // ── resolverIpResiliente: fallback a DoH ──
  cacheIps.clear();
  resultado = await resolverIpResiliente('portal.es', {
    lookup: lookupFalla,
    fetcher: fetcherDoH({ Answer: [{ type: 1, data: '2.2.2.2' }] }),
  });
  assert(resultado.ip === '2.2.2.2' && resultado.origen === 'doh', 'Cae a DoH cuando el sistema falla');

  // ── resolverIpResiliente: cache stale cuando todo falla ──
  resultado = await resolverIpResiliente('portal.es', {
    lookup: lookupFalla,
    fetcher: fetcherDoH({}, { ok: false, status: 500 }),
  });
  assert(resultado.ip === '2.2.2.2' && resultado.origen === 'cache_stale', 'Usa la última IP buena si sistema y DoH fallan');

  // ── resolverIpResiliente: sin cache → error diagnosticable ──
  cacheIps.clear();
  error = null;
  try {
    await resolverIpResiliente('nuevo.es', {
      lookup: lookupFalla,
      fetcher: fetcherDoH({}, { ok: false, status: 500 }),
    });
  } catch (err) {
    error = err;
  }
  assert(error && error.code === 'EDNSRESILIENTE', 'Error EDNSRESILIENTE si no hay ninguna vía');
  assert(error && /sistema:/.test(error.message) && /doh:/.test(error.message), 'El error incluye el detalle de cada intento');

  // ── crearLookup: firma compatible con net/https.Agent ──
  cacheIps.clear();
  const lookup = crearLookup({ lookup: lookupOk('3.3.3.3') });
  const viaCallback = await new Promise((resolve, reject) => {
    lookup('portal.es', { family: 4 }, (err, ip, family) => (err ? reject(err) : resolve({ ip, family })));
  });
  assert(viaCallback.ip === '3.3.3.3' && viaCallback.family === 4, 'crearLookup responde (ip, 4) vía callback');

  console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
