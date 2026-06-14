#!/usr/bin/env node
// scripts/inventario_rutas.js
//
// Vuelca el inventario completo de endpoints (METODO + path) de la API a stdout,
// ordenado y estable. Sirve de "red de seguridad" durante la reestructuración:
// se compara el inventario ANTES y DESPUES de cada fase para demostrar que
// ninguna URL se añade, elimina o cambia (el comportamiento HTTP no varía).
//
// Cómo funciona: intercepta `express()` con un grabador que registra cada
// llamada a app.get/post/put/patch/delete/all (incluidos los routers de módulo),
// sin abrir puertos ni conectar a servicios externos. Luego carga el entrypoint
// real de la app (por defecto src/index.js).
//
// Uso:
//   node scripts/inventario_rutas.js                 # imprime el inventario
//   node scripts/inventario_rutas.js > rutas.txt     # guarda snapshot
//   node scripts/inventario_rutas.js --entry src/app.js
//
// El script NO debe alterar ningún dato: solo carga módulos en memoria.

// 1) Variables de entorno placeholder: evitan que supabaseClient (y otros)
//    lancen al cargar. No se realiza ninguna conexión real.
const ENV_PLACEHOLDERS = {
  SUPABASE_URL: 'https://placeholder.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
  JWT_SECRET: 'placeholder-jwt-secret',
  CRON_TOKEN: 'placeholder-cron-token',
  OPENAI_API_KEY: 'placeholder-openai-key',
  PUBLIC_BASE_URL: 'https://placeholder.ruralicos.es',
};
for (const [clave, valor] of Object.entries(ENV_PLACEHOLDERS)) {
  if (!process.env[clave]) process.env[clave] = valor;
}

const path = require('path');

// 2) Grabador de rutas que imita la superficie de Express usada por la app.
const rutas = [];
const METODOS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head'];

function crearGrabador(prefijo = '') {
  const grabador = {
    // app.use(path, router) / app.use(middleware): seguimos montajes con prefijo.
    use(...args) {
      const [primero, segundo] = args;
      if (typeof primero === 'string' && segundo && typeof segundo === 'object') {
        // Montaje de un router en un sub-path: propagamos el prefijo.
        const hijo = segundo.__esGrabadorRutas ? segundo : null;
        if (hijo) hijo.__rebasarPrefijo(prefijo + primero);
      }
      return grabador;
    },
    set() { return grabador; },
    engine() { return grabador; },
    listen() { return { close() {} }; }, // nunca abrimos un puerto
    __esGrabadorRutas: true,
    __rebasarPrefijo() {},
  };

  for (const metodo of METODOS) {
    grabador[metodo] = (ruta, ...handlers) => {
      if (typeof ruta === 'string' && handlers.length > 0) {
        rutas.push({ metodo: metodo.toUpperCase(), path: prefijo + ruta });
      }
      return grabador;
    };
  }
  return grabador;
}

// 3) Sustituimos el módulo express por una versión que devuelve el grabador,
//    conservando los helpers estáticos (express.json, express.static, Router...).
const expressReal = require('express');
function expressFalso() {
  return crearGrabador('');
}
Object.assign(expressFalso, expressReal);
// express.Router() también debe devolver un grabador montable.
expressFalso.Router = () => crearGrabador('');
require.cache[require.resolve('express')].exports = expressFalso;

// 4) Cargamos el entrypoint real: ejecuta todo el cableado sobre el grabador.
const argv = process.argv.slice(2);
const idxEntry = argv.indexOf('--entry');
const entry = idxEntry !== -1 ? argv[idxEntry + 1] : 'src/index.js';
const entryAbs = path.resolve(process.cwd(), entry);

try {
  require(entryAbs);
} catch (err) {
  console.error(`No se pudo cargar el entrypoint "${entry}":`, err.message);
  process.exit(1);
}

// 5) Ordenamos de forma estable (path y luego método) y volcamos.
rutas.sort((a, b) => {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.metodo < b.metodo ? -1 : 1;
});

// Deduplicamos por si algún path se registra dos veces idéntico.
const vistos = new Set();
const lineas = [];
for (const { metodo, path: ruta } of rutas) {
  const clave = `${metodo} ${ruta}`;
  if (vistos.has(clave)) continue;
  vistos.add(clave);
  lineas.push(clave);
}

process.stdout.write(lineas.join('\n') + '\n');
process.stderr.write(`\n[inventario_rutas] ${lineas.length} endpoints desde ${entry}\n`);
