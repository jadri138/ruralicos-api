// src/middleware/requestContext.js
//
// Identificador de correlacion por peticion. Se genera siempre en el servidor
// (no se confia en cabeceras entrantes) y se devuelve en `x-request-id` para
// que el frontend pueda ensenarlo al usuario y soporte pueda cruzarlo con los
// logs (responderError lo incluye en cada error 5xx).

const crypto = require('crypto');

function requestContext(req, res, next) {
  req.id = crypto.randomBytes(8).toString('hex');
  res.setHeader('x-request-id', req.id);
  next();
}

module.exports = { requestContext };
