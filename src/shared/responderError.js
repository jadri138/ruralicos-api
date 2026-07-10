// src/shared/responderError.js
//
// Respuesta de error unificada para superficies de CLIENTE (partner, publico).
// Regla: los errores esperados (err.status 4xx, lanzados a proposito con un
// mensaje pensado para el usuario) pasan tal cual; cualquier otra cosa es un
// 500 GENERICO — el detalle (mensajes de Postgres, stack traces) se queda en
// el log del servidor, nunca viaja al cliente. El request_id permite cruzar
// la respuesta con el log.
//
// Las rutas internas (cron token, admin) pueden seguir devolviendo el detalle:
// sus llamadores son de confianza y el mensaje ayuda a operar.

const { capturarExcepcion } = require('../platform/sentry');

function responderError(req, res, err) {
  const requestId = req?.id || null;
  const status = Number(err?.status);

  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message, request_id: requestId });
  }

  console.error(`[${req?.method || '?'} ${req?.path || '?'}] request_id=${requestId}:`, err);
  capturarExcepcion(err, { request_id: requestId, method: req?.method, path: req?.path });
  return res.status(500).json({ error: 'Error interno', request_id: requestId });
}

module.exports = { responderError };
