// src/middleware/validate.js
//
// Validacion de entrada en el borde del API (zod). Filosofia: PURAMENTE
// ADITIVA para no cambiar comportamiento — los objetos son "loose" (los campos
// no declarados pasan tal cual), los campos son opcionales (los mensajes de
// presencia en castellano siguen viviendo en cada handler) y NO se transforma
// nada. Lo que si corta, ANTES de tocar bcrypt/BD:
//   - cuerpos que no son un objeto JSON (arrays, strings, numeros),
//   - campos con tipos imposibles (un objeto donde va un telefono),
//   - tamanos absurdos (un password de 20 MB camino de bcrypt).
//
// Uso:
//   const { validarBody, escalarCorto } = require('../../middleware/validate');
//   app.post('/login', limiter, validarBody({
//     phone: escalarCorto(32, 'telefono'),
//     password: escalarCorto(200, 'contrasena'),
//   }), handler);

const { z } = require('zod');

// Campo escalar corto: string con tope de longitud, o numero (hay clientes que
// mandan el telefono como numero JSON y String() lo resuelve en el handler).
function escalarCorto(max, etiqueta = 'campo') {
  return z
    .union(
      [z.string().max(max, { error: `${etiqueta} demasiado largo (maximo ${max})` }), z.number()],
      { error: `${etiqueta} invalido` }
    )
    .optional();
}

function validarBody(shape) {
  const schema = z.looseObject(shape);

  return (req, res, next) => {
    const body = req.body ?? {};

    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        error: 'El cuerpo de la peticion debe ser un objeto JSON',
        code: 'validacion',
        request_id: req.id || null,
      });
    }

    const result = schema.safeParse(body);
    if (!result.success) {
      const detalles = result.error.issues.map((issue) => ({
        campo: issue.path.join('.') || '(cuerpo)',
        detalle: issue.message,
      }));
      return res.status(400).json({
        error: detalles.length ? `${detalles[0].campo}: ${detalles[0].detalle}` : 'Cuerpo de la peticion invalido',
        code: 'validacion',
        detalles,
        request_id: req.id || null,
      });
    }

    req.body = result.data;
    return next();
  };
}

module.exports = { validarBody, escalarCorto, z };
