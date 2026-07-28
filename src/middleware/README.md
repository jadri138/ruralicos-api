# Middleware HTTP

Piezas que se ejecutan antes de los handlers Express. Aquí se decide quién llama, se valida la forma de la entrada y se crea el contexto técnico de la petición.

## Archivos

| Archivo | Función |
| --- | --- |
| `requestContext.js` | Crea/propaga `x-request-id` para trazabilidad |
| `requireAdmin.js` | Verifica JWT administrativo y versión de credenciales |
| `credentialVersion.js` | Invalida tokens antiguos tras cambios de credenciales |
| `cronToken.js` | Valida `CRON_TOKEN` por header o Bearer |
| `validate.js` | Valida y normaliza cuerpos mediante esquemas |

Los contextos de usuario y organización viven junto a sus dominios porque también aplican reglas específicas: `modules/usuarios/usuarios.context.js` y `modules/partner/tenantClient.js`.

## Elección rápida

- Operación humana interna: `requireAdmin`.
- Tarea programada: helpers de `cronToken`.
- Ruta utilizable por admin o cron: composición explícita de ambos.
- Cuenta del usuario: `requireAuth` del módulo usuarios.
- Personal de cooperativa: `requireOrg` del módulo partner.
- Entrada JSON: `validarBody(...)`.

## Seguridad

- Autenticar no es autorizar: después del token hay que comprobar propietario, rol o tenant.
- Nunca confiar en un `userId` u `organizationId` recibido si puede derivarse del token.
- Los tokens no deben aparecer en logs ni mensajes de error.
- Una ruta que muta producción no debe quedar pública por comodidad de cron.
- Toda nueva variante de autorización necesita una prueba de acceso permitido y otra de acceso denegado.

## Pruebas relacionadas

- `credentialVersion.test.js`
- `validateBody.test.js`
- `v1Alias.test.js`
- `passwordPolicy.test.js`
- `partnerTenantIsolation.test.js`
- pruebas específicas de cada ruta protegida
