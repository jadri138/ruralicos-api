# Ruralicos API

Backend de Ruralicos. Es un monolito modular que ingiere publicaciones oficiales, crea alertas trazables, decide cuáles son relevantes para cada persona, genera digests y los entrega por WhatsApp. También sirve al panel interno y al panel de cooperativas.

## Responsabilidades

- Descargar BOE, boletines autonómicos, fuentes provinciales y fuentes complementarias.
- Conservar documentos originales y registrar la salud de cada fuente.
- Clasificar, resumir, revisar, relacionar y deduplicar alertas.
- Aplicar filtros territoriales, taxonomía, plan, preferencias y aprendizaje.
- Construir y validar el digest final de cada usuario.
- Enviar WhatsApp mediante UltraMsg con cola, reintentos y trazabilidad.
- Procesar clics, feedback conversacional y acciones de MIA.
- Separar los datos de cada organización en el panel partner.
- Exponer operaciones, explicaciones y auditorías al panel interno.

## Arquitectura rápida

```text
src/server.js
  └─ src/app.js
       ├─ seguridad, CORS, rate-limit, /health y /stats
       └─ src/routes.js
            ├─ modules/boletines  → ingesta
            ├─ modules/alertas    → inteligencia y selección
            ├─ modules/digest     → composición y envío
            ├─ modules/feedback   → clics y respuestas
            ├─ modules/aprendizaje + modules/mia
            ├─ modules/usuarios + modules/partner
            └─ modules/admin + modules/tareas
```

Para orientarse con poco contexto, una IA debe empezar por [`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md).
La organización completa está en [`src/README.md`](src/README.md) y cada dominio está indexado en [`src/modules/README.md`](src/modules/README.md).

## Requisitos

- Node.js `>=20.18.1`
- npm
- Proyecto Supabase compatible con [`supabase/migrations/`](supabase/migrations/)
- Credenciales de OpenAI para funciones de IA
- Cuenta UltraMsg para envío real por WhatsApp

## Instalación

```powershell
npm install
Copy-Item .env.example .env
# Completar las variables de .env
npm start
```

La API escucha en `PORT`, por defecto `3000`.

Comprobaciones básicas:

```text
GET /health   comprueba API, entorno y Supabase
GET /stats    devuelve cifras públicas redondeadas
```

Todas las rutas actuales tienen también alias `/v1`: por ejemplo, `/v1/health` y `/health` resuelven el mismo contrato.

## Variables de entorno

La referencia completa y comentada es [`.env.example`](.env.example). Los grupos principales son:

| Grupo | Variables principales |
| --- | --- |
| Base de datos | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| IA y decisión | `OPENAI_API_KEY`, `ALERT_DECISION_TOP_K`, modelos del juez y sal de pseudónimos |
| Sesiones y tareas | `JWT_SECRET`, `CRON_TOKEN`, `VERIFICATION_CODE_PEPPER` |
| WhatsApp | `ULTRAMSG_INSTANCE_ID`, `ULTRAMSG_TOKEN`, `ULTRAMSG_WEBHOOK_TOKEN` |
| Digest y entrega | `DIGEST_FINAL_VALIDATION_MODE`, `ALERT_DECISION_MESSAGE_MAX_CHARS`, `OUTBOX_MAX_LOOPS`, conciliación UltraMsg |
| Pipeline | `BASE_URL`, `HTTP_TIMEOUT_MS`, `HTTP_RETRIES`, `MAX_LOOPS`, `PREPARAR_DIGEST_MAX_LOOPS`, `HOLD_RECOVERY_MAX_LOOPS` |
| URLs | `PUBLIC_BASE_URL`, `PIPELINE_INTERNAL_BASE_URL`, `FRONTEND_ORIGINS` |
| Observabilidad y retención | `SENTRY_DSN`, `RETENTION_ENABLED` |

No se debe subir `.env` a Git ni exponer la clave `SUPABASE_SERVICE_ROLE_KEY` en un frontend.

## Flujo diario

El orquestador de producción es `node scripts/run_digest_workflow.js`. El cron
ejecuta una sola vez todas las fases en orden mediante endpoints pequeños.

```text
scrapers
  → documentos y alertas
  → cotejo con listados oficiales
  → clasificación y ficha de hechos
  → resumen, revisión y deduplicación
  → cálculo de audiencia y candidatos
  → preparación del digest
  → autoridad y validación final
  → cola única de comunicaciones
  → ACK y conciliación de entrega
  → feedback, clics y aprendizaje
```

Las tareas aceptan `x-cron-token` o `Authorization: Bearer <CRON_TOKEN>`. El token por query solo existe como compatibilidad opcional y no es el patrón recomendado.

## Seguridad y permisos

| Contexto | Protección |
| --- | --- |
| Administración | JWT emitido por `/admin/login` y `requireAdmin` |
| Usuario | JWT de teléfono y `requireAuth` |
| Organización | JWT de partner y `requireOrg`, con consultas limitadas al tenant |
| Cron | `CRON_TOKEN` con comparación segura |
| Webhook UltraMsg | `ULTRAMSG_WEBHOOK_TOKEN` |
| Tráfico general | Helmet, CORS explícito, límite de tamaño y rate-limit |

Las mutaciones importantes del panel se escriben en el registro de auditoría cuando corresponde. Los errores incluyen `x-request-id` para cruzar respuesta y logs.

## Comandos

```powershell
npm start                 # servidor
npm run lint              # ESLint
npm run test:local        # suite local sin servicios reales
npm run check:core        # invariantes críticas
npm test                  # lint + suite + invariantes
npm run rutas:inventario  # inventario de endpoints
npm run openapi:generar   # actualiza docs/openapi.json
npm run p0:acceptance     # puerta de aceptación P0
npm run replay:alert-decisions # replay offline, sin base de datos ni envíos
npm run replay:export-snapshots -- --help # exportación histórica solo lectura
npm run replay:grade -- --help # grader auxiliar apagado por defecto
```

Los scripts operativos, sus riesgos y ejemplos están en [`scripts/README.md`](scripts/README.md). Las pruebas están agrupadas en [`tests/README.md`](tests/README.md).

## Mapa de carpetas

| Carpeta | Contenido |
| --- | --- |
| [`src/config/`](src/config/) | Entorno y planes |
| [`src/middleware/`](src/middleware/) | Autorización, validación y contexto |
| [`src/platform/`](src/platform/) | Supabase, IA, HTTP, Sentry y WhatsApp |
| [`src/shared/`](src/shared/) | Reglas y utilidades reutilizables |
| [`src/services/`](src/services/) | Servicios de negocio transversales |
| [`src/modules/`](src/modules/) | Dominios funcionales |
| [`supabase/`](supabase/) | Esquema y migraciones |
| [`tests/`](tests/) | Pruebas y corpus auditados |
| [`scripts/`](scripts/) | Diagnóstico, backfills y herramientas |
| [`docs/`](docs/) | Arquitectura, operación y runbooks |

## Documentación recomendada

- Explicación no técnica: [`docs/EXPLICACION_SIMPLE.md`](docs/EXPLICACION_SIMPLE.md)
- Arquitectura: [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md)
- Decisión de alertas, entrega y aprendizaje: [`docs/SISTEMA_DECISION_ALERTAS_LLM_IMPLEMENTADO.md`](docs/SISTEMA_DECISION_ALERTAS_LLM_IMPLEMENTADO.md)
- Validación final: [`docs/final-digest-validator.md`](docs/final-digest-validator.md)
- Evidencia y trazabilidad: [`docs/fact-sheet.md`](docs/fact-sheet.md) y [`docs/document-trace.md`](docs/document-trace.md)
- Operación y despliegue: [`docs/README.md`](docs/README.md)
- Cumplimiento y retención: [`docs/CUMPLIMIENTO.md`](docs/CUMPLIMIENTO.md)

## Regla para cambios

Empieza por una prueba focalizada, modifica el módulo dueño del comportamiento y ejecuta:

```powershell
node tests\<prueba-relacionada>.test.js
npm run check:core
```

Para cambios amplios usa `npm test`. Si cambia un contrato HTTP, actualiza el inventario/OpenAPI y su documentación. Si cambia el esquema, crea una migración nueva: nunca se reescribe una migración ya aplicada.
