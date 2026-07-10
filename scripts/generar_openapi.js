#!/usr/bin/env node
// scripts/generar_openapi.js
//
// Genera docs/openapi.json por INTROSPECCION de la app real (reutiliza
// scripts/inventario_rutas.js), asi el spec no se desvia del codigo:
//   node scripts/generar_openapi.js          # escribe docs/openapi.json
//
// Cobertura: todos los endpoints con metodo+path+tag+seguridad (heuristica por
// prefijo), y esquemas de request/response detallados para la superficie
// publica de clientes (auth, cuenta, partner login). Los endpoints internos
// (cron token, admin) quedan documentados como tales sin detallar payloads.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const raiz = path.resolve(__dirname, '..');

// 1) Inventario real de rutas (METODO /path por linea).
const salida = execFileSync(process.execPath, [path.join(raiz, 'scripts', 'inventario_rutas.js')], {
  cwd: raiz,
  encoding: 'utf8',
});
const rutas = salida
  .trim()
  .split('\n')
  .map((linea) => linea.trim())
  .filter(Boolean)
  .map((linea) => {
    const [metodo, ...resto] = linea.split(' ');
    return { metodo: metodo.toLowerCase(), ruta: resto.join(' ') };
  });

// 2) Heuristicas de clasificacion.
function tagDe(ruta) {
  if (ruta === '/' || ruta.startsWith('/a/') || ruta.startsWith('/alerta/') || ruta.startsWith('/clicks')) return 'tracking';
  if (ruta.startsWith('/admin')) return 'admin';
  if (ruta.startsWith('/partner')) return 'partner';
  if (ruta.startsWith('/tareas')) return 'tareas (cron)';
  if (ruta.startsWith('/scrape-')) return 'scrapers (cron)';
  if (ruta.startsWith('/alertas')) return 'alertas';
  if (ruta.startsWith('/cerebro') || ruta.startsWith('/embeddings')) return 'aprendizaje/ia';
  if (ruta.startsWith('/me') || ['/register', '/login-phone', '/first-login', '/set-password'].includes(ruta)
    || ruta.startsWith('/verify-phone') || ruta.startsWith('/password-reset') || ruta.startsWith('/users')) return 'usuarios';
  if (ruta.startsWith('/feedback') || ruta.startsWith('/webhooks')) return 'feedback';
  if (ruta.startsWith('/digest')) return 'digest';
  return 'otros';
}

function seguridadDe(ruta) {
  if (ruta.startsWith('/admin')) return [{ bearerAdmin: [] }];
  if (ruta.startsWith('/partner')) {
    if (ruta === '/partner/login' || ruta.startsWith('/partner/branding/')) return [];
    return [{ bearerOrg: [] }];
  }
  if (ruta.startsWith('/me') || ruta === '/set-password') return [{ bearerUser: [] }];
  if (ruta.startsWith('/tareas') || ruta.startsWith('/scrape-') || ruta.startsWith('/alertas/')
    || ruta.startsWith('/cerebro') || ruta.startsWith('/embeddings') || ruta.startsWith('/feedback/')
    || ruta === '/clicks/recientes' || ruta.startsWith('/users')) return [{ cronToken: [] }];
  return [];
}

// 3) Detalle a mano de la superficie publica de clientes.
const cuerpo = (props, required = []) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', properties: props, required } } },
});
const str = (desc) => ({ type: 'string', description: desc });
const DETALLES = {
  'post /register': {
    summary: 'Alta de usuario (envia codigo de verificacion por WhatsApp)',
    requestBody: cuerpo({
      phone: str('Telefono movil espanol'), password: str('Debe cumplir la politica de contrasenas'),
      first_name: str('Nombre'), last_name_1: str('Primer apellido'), last_name_2: str('Segundo apellido (opcional)'),
      email: str('Opcional'), subscription: { type: 'string', enum: ['corral', 'agricultor', 'cooperativa'] },
      preferences: { type: 'object' }, preferencias_extra: str('Contexto libre (opcional)'),
    }, ['phone', 'password', 'first_name', 'last_name_1']),
  },
  'post /verify-phone': { summary: 'Confirma el telefono con el codigo recibido', requestBody: cuerpo({ phone: str(''), code: str('Codigo de 6 digitos') }, ['phone', 'code']) },
  'post /verify-phone/request': { summary: 'Reenvia un codigo de verificacion', requestBody: cuerpo({ phone: str('') }, ['phone']) },
  'post /password-reset': { summary: 'Inicia el reseteo de contrasena (codigo por WhatsApp)', requestBody: cuerpo({ phone: str('') }, ['phone']) },
  'post /password-reset/verify': { summary: 'Completa el reseteo (revoca las sesiones anteriores)', requestBody: cuerpo({ phone: str(''), code: str(''), password: str('') }, ['phone', 'code', 'password']) },
  'post /login-phone': {
    summary: 'Login de usuario por telefono. Devuelve JWT (7 dias)',
    requestBody: cuerpo({ phone: str(''), password: str('') }, ['phone', 'password']),
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' } } } } } } },
  },
  'post /set-password': { summary: 'Cambia la contrasena (revoca las demas sesiones; devuelve token fresco)', requestBody: cuerpo({ password: str('') }, ['password']) },
  'post /partner/login': {
    summary: 'Login del panel de cooperativa. Devuelve JWT org (12 h)',
    requestBody: cuerpo({ email: str(''), password: str('') }, ['email', 'password']),
  },
  'get /me': { summary: 'Perfil del usuario autenticado' },
  'get /me/export': { summary: 'Exportacion de datos (portabilidad RGPD)' },
  'delete /me': { summary: 'Borrado de cuenta y datos (derecho al olvido)' },
  'get /health': { summary: 'Salud del servicio (sin auth)' },
  'get /stats': { summary: 'Metricas publicas redondeadas para la web' },
};

// 4) Construccion del documento.
const paths = {};
for (const { metodo, ruta } of rutas) {
  const rutaOpenApi = ruta.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  paths[rutaOpenApi] = paths[rutaOpenApi] || {};

  const parametros = [...ruta.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
    name: m[1], in: 'path', required: true, schema: { type: 'string' },
  }));

  const detalle = DETALLES[`${metodo} ${ruta}`] || {};
  paths[rutaOpenApi][metodo] = {
    tags: [tagDe(ruta)],
    summary: detalle.summary || undefined,
    security: seguridadDe(ruta),
    ...(parametros.length ? { parameters: parametros } : {}),
    ...(detalle.requestBody ? { requestBody: detalle.requestBody } : {}),
    responses: detalle.responses || { 200: { description: 'OK' } },
  };
}

const documento = {
  openapi: '3.0.3',
  info: {
    title: 'Ruralicos API',
    version: '1.0.0',
    description: 'Alertas de subvenciones y ayudas rurales por WhatsApp. '
      + 'Generado por introspeccion con scripts/generar_openapi.js — regenerar tras cambiar rutas. '
      + 'Todas las rutas aceptan tambien el prefijo /v1 (alias del contrato v1).',
  },
  servers: [
    { url: 'https://ruralicos-api.onrender.com/v1', description: 'Produccion (prefijo v1 recomendado)' },
    { url: 'https://ruralicos-api.onrender.com', description: 'Produccion (rutas legacy sin prefijo)' },
  ],
  components: {
    securitySchemes: {
      bearerUser: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token de usuario (POST /login-phone)' },
      bearerOrg: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token de cooperativa (POST /partner/login)' },
      bearerAdmin: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token de admin (POST /admin/login)' },
      cronToken: { type: 'apiKey', in: 'header', name: 'x-cron-token', description: 'Token de tareas internas/cron' },
    },
  },
  paths,
};

const destino = path.join(raiz, 'docs', 'openapi.json');
fs.writeFileSync(destino, JSON.stringify(documento, null, 2) + '\n');
process.stderr.write(`[openapi] ${Object.keys(paths).length} paths escritos en ${path.relative(raiz, destino)}\n`);
