// src/platform/dnsResiliente.js
//
// Resolución DNS resiliente para scrapers de portales oficiales.
//
// Problema que resuelve: varios boletines (ceuta.es, dpz.es) sirven su DNS
// desde nameservers propios lentos o intermitentes. Desde el hosting la
// resolución falla y axios lo reporta como "timeout of Xms exceeded", con lo
// que la fuente aparece caída aunque el servidor web funcione.
//
// Estrategia, por orden:
//   1. dns.lookup del sistema (con límite de tiempo propio).
//   2. Fallback a DNS-over-HTTPS (dns.google) — solo necesita el puerto 443.
//   3. Última IP buena conocida en caché (stale-while-error).
//
// Siempre se resuelve a IPv4: estos portales no tienen IPv6 sano y Node no
// hace fallback rápido de familia como sí hace curl.

const dns = require('dns');
const https = require('https');

const DOH_URL = 'https://dns.google/resolve';
const LOOKUP_TIMEOUT_MS = Math.max(1000, Number(process.env.DNS_LOOKUP_TIMEOUT_MS || 5000));
const DOH_TIMEOUT_MS = Math.max(1000, Number(process.env.DNS_DOH_TIMEOUT_MS || 8000));

// hostname -> { ip, actualizadoEn, origen }
const cacheIps = new Map();

function guardarEnCache(hostname, ip, origen) {
  cacheIps.set(hostname, { ip, actualizadoEn: Date.now(), origen });
}

function ipConocida(hostname) {
  return cacheIps.get(hostname) || null;
}

async function resolverDoH(hostname, { fetcher = globalThis.fetch, timeoutMs = DOH_TIMEOUT_MS } = {}) {
  const url = `${DOH_URL}?name=${encodeURIComponent(hostname)}&type=A`;
  const respuesta = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!respuesta.ok) throw new Error(`DoH devolvió HTTP ${respuesta.status}`);

  const json = await respuesta.json();
  const ips = (json.Answer || [])
    .filter((registro) => registro.type === 1 && typeof registro.data === 'string')
    .map((registro) => registro.data);

  if (!ips.length) throw new Error(`DoH sin registros A para ${hostname}`);
  return ips;
}

function lookupSistemaConTimeout(hostname, { lookup = dns.lookup, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let terminado = false;
    const timer = setTimeout(() => {
      if (terminado) return;
      terminado = true;
      const err = new Error(`dns.lookup superó ${timeoutMs}ms para ${hostname}`);
      err.code = 'EDNSTIMEOUT';
      reject(err);
    }, timeoutMs);

    lookup(hostname, { family: 4 }, (err, address) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(address);
    });
  });
}

async function resolverIpResiliente(hostname, deps = {}) {
  const errores = [];

  try {
    const ip = await lookupSistemaConTimeout(hostname, deps);
    guardarEnCache(hostname, ip, 'sistema');
    return { ip, origen: 'sistema' };
  } catch (err) {
    errores.push(`sistema: ${err.message}`);
  }

  try {
    const ips = await resolverDoH(hostname, deps);
    guardarEnCache(hostname, ips[0], 'doh');
    return { ip: ips[0], origen: 'doh' };
  } catch (err) {
    errores.push(`doh: ${err.message}`);
  }

  const cacheado = ipConocida(hostname);
  if (cacheado) {
    return { ip: cacheado.ip, origen: 'cache_stale' };
  }

  const error = new Error(`DNS irresoluble para ${hostname} (${errores.join(' | ')})`);
  error.code = 'EDNSRESILIENTE';
  throw error;
}

// Firma compatible con la opción `lookup` de net/tls/https.Agent.
function crearLookup(deps = {}) {
  return function lookupResiliente(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;

    resolverIpResiliente(hostname, deps)
      .then(({ ip }) => cb(null, ip, 4))
      .catch((err) => cb(err));
  };
}

function crearHttpsAgentResiliente({ rejectUnauthorized = true } = {}) {
  return new https.Agent({
    rejectUnauthorized,
    lookup: crearLookup(),
    family: 4,
  });
}

// Agentes compartidos (los scrapers no necesitan crear uno por petición).
const agenteResiliente = crearHttpsAgentResiliente();
const agenteResilienteInseguro = crearHttpsAgentResiliente({ rejectUnauthorized: false });

module.exports = {
  agenteResiliente,
  agenteResilienteInseguro,
  crearHttpsAgentResiliente,
  ipConocida,
  __testing: {
    cacheIps,
    resolverDoH,
    resolverIpResiliente,
    lookupSistemaConTimeout,
    crearLookup,
  },
};
