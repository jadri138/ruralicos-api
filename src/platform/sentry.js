// src/platform/sentry.js
//
// Captura de errores en Sentry, OPCIONAL: solo se activa si SENTRY_DSN esta
// definido. Sin DSN todo es no-op y @sentry/node ni siquiera se carga (require
// perezoso), asi que en local/tests no cuesta nada ni cambia comportamiento.
//
// Uso:
//   - server.js llama a inicializarSentry() en el arranque.
//   - responderError llama a capturarExcepcion(err, contexto) en los 5xx.
// El contexto (request_id, method, path) viaja como tags para cruzar el evento
// de Sentry con la respuesta que vio el usuario y con los logs.

let sentry = null;

function inicializarSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  try {
    sentry = require('@sentry/node');
    sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      // Solo errores: el tracing/performance queda apagado (coste y ruido).
      tracesSampleRate: 0,
    });
    console.log('[sentry] captura de errores activada');
    return true;
  } catch (err) {
    console.warn('[sentry] no se pudo inicializar (se sigue sin captura):', err.message);
    sentry = null;
    return false;
  }
}

function sentryActivo() {
  return sentry !== null;
}

function capturarExcepcion(err, contexto = {}) {
  if (!sentry) return;
  try {
    sentry.withScope((scope) => {
      for (const [clave, valor] of Object.entries(contexto)) {
        if (valor !== undefined && valor !== null) scope.setTag(clave, String(valor));
      }
      sentry.captureException(err);
    });
  } catch (captureErr) {
    // La captura nunca debe romper el flujo de la respuesta.
    console.warn('[sentry] fallo capturando excepcion:', captureErr.message);
  }
}

// Vacia el buffer de eventos antes de morir (para uncaughtException).
async function vaciarSentry(timeoutMs = 2000) {
  if (!sentry) return;
  try {
    await sentry.flush(timeoutMs);
  } catch {
    // best-effort
  }
}

module.exports = { inicializarSentry, sentryActivo, capturarExcepcion, vaciarSentry };
