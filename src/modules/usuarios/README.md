# Usuarios

Registro, autenticación, cuenta, preferencias, plan, privacidad y verificación telefónica.

## Archivos

| Archivo | Área |
| --- | --- |
| `usuarios.routes.js` | Agrega las subrutas |
| `usuarios.registro.routes.js` | Alta, códigos, verificación y recuperación |
| `userAuth.routes.js` | Login, primer acceso y contraseña |
| `usuarios.cuenta.routes.js` | `/me`, plan, exportación, memoria, alertas y borrado |
| `preferences.routes.js` | Preferencias autenticadas |
| `usuarios.gestion.routes.js` | Operaciones legacy/admin sobre usuarios |
| `auth.routes.js` | Login administrativo |
| `usuarios.context.js` | Extracción/autorización del contexto |
| `verificationCodes.js` | Emisión, hash, caducidad e intentos de códigos |

## Identidades separadas

- Admin: token de `/admin/login`.
- Usuario final: token de teléfono.
- Partner staff: token de organización, gestionado en el módulo partner.

No reutilizar un tipo de token como otro contexto.

## Preferencias

Las entradas se sanitizan y convierten a forma canónica antes de guardarse. Incluyen territorio, sectores, subsectores, tipos y exclusiones. El motor de selección consume esa forma común.

Una preferencia explícita tiene más autoridad que una inferencia aprendida. Si una provincia cambia, los envíos siguientes deben respetarla sin esperar a recalcular todo el perfil.

## Verificación

- Los códigos se guardan hasheados.
- Caducan, tienen límite de intentos y rate-limit.
- `VERIFICATION_CODE_PEPPER` usa `JWT_SECRET` solo como fallback.
- Las respuestas no revelan si un teléfono ajeno existe cuando eso facilite enumeración.
- Las contraseñas pasan `shared/passwordPolicy.js`.

## Privacidad

`/me/export` entrega datos del propietario. `/me/memory` permite inspección/borrado de memoria. `/me` DELETE coordina la eliminación de las tablas asociadas. Actualizar `userDeletionTables.test.js` cuando aparezca una tabla nueva con datos personales.

## Compatibilidad

Existen endpoints de gestión anteriores a `/me`. Se mantienen protegidos para admin/cron/propietario según el caso; una ruta legacy no debe quedar con menos seguridad.

Pruebas: `verificationCodes`, `passwordPolicy`, `credentialVersion`, `preferenceCanonical`, `userDeletionTables` y autenticación/rutas afectadas.
