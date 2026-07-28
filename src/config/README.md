# Configuración

Configuración estable del backend. Esta carpeta no contiene secretos: los valores sensibles llegan mediante variables de entorno.

## Archivos

### `env.js`

- Declara qué variables son críticas.
- En producción hace *fail fast*: si falta una credencial necesaria, el proceso no arranca a medias.
- En pruebas y desarrollo conserva el comportamiento apropiado para poder usar mocks.

Cuando se añade una variable:

1. documentarla en `.env.example`;
2. decidir si es obligatoria o tiene valor por defecto seguro;
3. validarla aquí si un valor ausente haría peligroso el arranque;
4. añadir o actualizar `tests/envConfig.test.js`.

### `planes.js`

Fuente común para capacidades y límites por plan. Las reglas de selección y los paneles deben consumir esta configuración en vez de repetir números o nombres.

Al cambiar un plan hay que revisar:

- límites de candidatos y digest;
- endpoints de cambio de plan;
- notificación al usuario;
- pantallas de administración y partner;
- pruebas de aceptación relacionadas.

## Reglas

- Nunca incluir tokens, URLs privadas con credenciales ni claves reales.
- Evitar leer `process.env` de forma dispersa cuando el valor necesita validación o normalización.
- Un interruptor peligroso debe tener el valor por defecto más conservador.
- Los comentarios deben indicar unidad (`ms`, número de usuarios, días) y efecto operativo.
