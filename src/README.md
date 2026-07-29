# Código de la API

`src/` contiene el servicio Express completo. La aplicación es un monolito modular: se despliega como un proceso, pero cada dominio mantiene sus rutas, reglas y pruebas.

## Arranque de una petición

1. [`server.js`](server.js) valida el entorno, activa Sentry si está configurado y abre el puerto.
2. [`app.js`](app.js) construye Express, aplica seguridad, CORS, contexto, límites y endpoints base.
3. [`routes.js`](routes.js) registra todos los módulos en un orden deliberado.
4. La ruta valida identidad y entrada, llama a la lógica de negocio y responde.
5. Los errores operativos usan un `request_id` para poder encontrarlos en logs.

`app.js` no llama a `listen`; esta separación permite cargar la aplicación desde pruebas y herramientas.

## Carpetas

| Carpeta | Responsabilidad | No debería contener |
| --- | --- | --- |
| [`config/`](config/) | Configuración estable y validación del entorno | Consultas a la base de datos |
| [`middleware/`](middleware/) | Autorización, validación y contexto HTTP | Reglas complejas de selección |
| [`platform/`](platform/) | Clientes de servicios externos | Decisiones de negocio |
| [`shared/`](shared/) | Reglas/utilidades pequeñas y reutilizables | Handlers Express |
| [`services/`](services/) | Casos de uso compartidos por dominios | Montaje de rutas |
| [`modules/`](modules/) | Dominios funcionales completos | Credenciales incrustadas |

## Convención de módulos

La mayoría de rutas exporta una función:

```js
module.exports = function registrarModulo(app, supabase) {
  app.get("/ruta", middleware, async (req, res) => {
    // validar, delegar y responder
  });
};
```

Cuando un archivo crece:

- `*.routes.js`: contrato HTTP, permisos, validación y códigos de respuesta.
- `*.service.js`: lógica de negocio y persistencia.
- `*.helpers.js`: piezas pequeñas o puras.
- subcarpeta por capacidad: clasificación, selección, inteligencia, etc.

## Orden de rutas

No se debe reordenar [`routes.js`](routes.js) sin ejecutar el inventario y pruebas. Express resuelve coincidencias por orden. El tracking `/?a=token`, por ejemplo, se registra antes que la ruta raíz informativa.

## Endpoints globales

| Endpoint | Acceso | Uso |
| --- | --- | --- |
| `GET /health` | Público | Estado de API, entorno, Supabase y versión desplegada (`checks.release`) |
| `GET /stats` | Público | Estadísticas redondeadas y cacheables |
| `POST /admin/send-broadcast` | Admin | Envío manual a todos los destinatarios válidos |

El middleware inicial convierte `/v1/...` en alias del contrato actual antes de resolver la ruta.

## Dónde implementar un cambio

| Cambio | Lugar |
| --- | --- |
| Nueva fuente oficial | `modules/boletines/` |
| Nueva regla de relevancia o exclusión | `modules/alertas/` |
| Forma final del mensaje | `modules/digest/` |
| Interpretación de una respuesta | `modules/feedback/` o `modules/mia/` |
| Preferencias o cuenta | `modules/usuarios/` |
| Operación de cooperativa | `modules/partner/` |
| Pantalla interna necesita datos | `modules/admin/` |
| Fase programada | `modules/tareas/` |
| Cliente de un proveedor | `platform/` |
| Regla compartida sin dueño claro | primero comprobar `shared/` y `services/` |

## Validación

Ejecuta primero la prueba del módulo y después las invariantes:

```powershell
node tests\<archivo>.test.js
npm run check:core
```

Para cambios transversales:

```powershell
npm run lint
npm run test:local
npm run check:core
```

Si se añade o elimina una ruta, ejecuta `npm run rutas:inventario` y regenera OpenAPI cuando forme parte del contrato documentado.
