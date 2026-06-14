# Arquitectura de ruralicos-api

Este documento explica cómo está organizado el backend para que cualquier
desarrollador pueda situarse rápido. Es un **monolito modular** (un solo
servicio Express) organizado **por dominio de negocio**.

## Visión de 30 segundos

```
Boletines oficiales ──► scrapers ──► tabla `alertas`
                                          │
                          IA: clasificar / resumir / revisar / deduplicar
                                          │
                       selección por usuario (plan + preferencias + aprendizaje)
                                          │
                         digest diario ──► WhatsApp (UltraMsg)
                                          │
                       feedback del usuario ──► aprendizaje + agente MIA
```

Todo el ciclo diario se dispara con **un único endpoint de cron**:
`GET /tareas/pipeline-diario`.

## Capas y carpetas

```
src/
  server.js     Arranque (app.listen). Nada de lógica.
  app.js        Construye la app: helmet, CORS, rate-limit, body, /health, /stats,
                /admin/send-broadcast. Delega el montaje de rutas en routes.js.
  routes.js     Registro central: llama a cada modulo (app, supabase).

  config/       planes.js (límites por suscripción) y configuración estable.
  middleware/   requireAdmin (JWT admin) y cronToken (token de cron).
  platform/     Infraestructura / clientes externos:
                  supabase.js, whatsapp.js, http(Client).js, ia/ (openai, embeddings).
  shared/       Utilidades PURAS sin dependencias de dominio:
                  fechas, similitud, decay, teléfono, html/pdf, canonicalización.
  services/     Servicios de negocio transversales (officialListMatcher,
                planChangeNotifier) usados por varios módulos.

  modules/      Un dominio por carpeta (ver abajo).
```

### Convención de un módulo

Cada módulo expone su capa HTTP como una función `(app, supabase) => { ... }`
(inyección de dependencias simple y testeable). Para los módulos con lógica
pesada se separa la capa HTTP del negocio:

- `*.routes.js`  → registra endpoints, valida entrada, llama al servicio.
- `*.service.js` / `*.helpers.js` → lógica de negocio reutilizable, sin Express.

Ejemplos: `digest/` (routes + service) y `admin/` (un agregador + 5 sub-rutas
por área + `admin.helpers.js`).

## Los módulos

| Módulo | Responsabilidad |
| --- | --- |
| `boletines/` | Scrapers de cada fuente oficial (`scrapers/`) y sus rutas (`rutas/`). Inserta en `alertas`. |
| `alertas/` | Alta, revisión, deduplicación y **motor de selección** (`seleccion/`: engine, gate, candidateMerge, matcher). |
| `digest/` | Construye y envía el mensaje diario por usuario (1 WhatsApp/día). |
| `feedback/` | Webhook de feedback de WhatsApp y tracking de clics. |
| `aprendizaje/` | Aprendizaje ligero por keywords/score y perfilado de usuario (ver frontera abajo). |
| `mia/` | Agente conversacional avanzado (ver frontera abajo). |
| `usuarios/` | Usuarios, autenticación y preferencias. |
| `admin/` | Panel de administración (panel, usuarios, alertas, operaciones, mia). |
| `tareas/` | Orquesta el pipeline diario (scrapers → IA → digest). |
| `embeddings/` | Genera embeddings de alertas para selección semántica. |
| `taxonomy/` | Taxonomía rural (sectores/subsectores). |

## Ciclo de vida de una petición

1. `server.js` arranca y monta `app.js`.
2. `app.js` aplica middleware (helmet, CORS, rate-limit, JSON) y atiende
   `/health`, `/stats`, `/admin/send-broadcast`.
3. `routes.js` ha registrado cada módulo. La petición entra en el handler de su
   módulo, que recibe `supabase` por inyección.
4. El handler valida (con `requireAdmin` o `cronToken` si aplica), llama a la
   capa de servicio/helpers y responde.

> El orden de registro en `routes.js` se conserva del diseño original porque
> algunas rutas comparten prefijo y Express resuelve por orden de registro
> (p. ej. el tracking de clics se registra primero).

## El pipeline diario (`/tareas/pipeline-diario`)

Un solo cron diario encadena:

1. **Scrapers** BOE + autonómicos + complementarios provinciales (+ FEGA opcional).
2. **Cotejo** con listados oficiales.
3. **IA por lotes**: clasificar → resumir → revisar.
4. **Deduplicación** de alertas equivalentes.
5. **Digest**: `preparar-digest` (1 mensaje IA por usuario según plan y
   preferencias) y `enviar-digest` (con delay anti-ban).
6. **Resumen free** para el plan gratuito.

Las rutas de cron aceptan `?token=CRON_TOKEN` o el header `x-cron-token`.

## Frontera `aprendizaje` (brain) ↔ `mia`

Conviven **dos sistemas de aprendizaje** distintos. No se han fusionado a
propósito: cubren necesidades diferentes. Esta es la frontera:

| | `modules/aprendizaje/` (antes `brain/`) | `modules/mia/` |
| --- | --- | --- |
| Qué es | Aprendizaje **ligero por keywords y score** | **Agente conversacional** avanzado |
| Entrada | Votos del digest, features de la alerta, taxonomía | Mensajes entrantes de WhatsApp |
| Salida | Prioridad/score de alerta, perfil de intereses del usuario | Decisiones, respuestas, acciones, memoria estructurada |
| Piezas | `feedbackParser`, `alertPriority`, `alertFeatures`, `userInterestProfile`, `miaProfile`, `taxonomiaRuralicos`, `cerebro` (perfilado/embeddings) | `decisionCore`, `policy`, `outbox`, `inbound`, `knowledgeBase`, `structuredMemory`, `actionExecutor`, evals… |
| Determinista | Sí (reglas/score) | No (LLM con grounding y guardas) |

Regla práctica para situar código nuevo:

- ¿Es una **regla/score** sobre alertas o un **perfil de intereses**? → `aprendizaje/`.
- ¿Es **conversación, decisión o memoria del asistente**? → `mia/`.

> Nota histórica: el endpoint `/cerebro/*` (perfilado, embeddings, exploración)
> vive en `aprendizaje/cerebro.routes.js`, **no** en `mia/`. El nombre "cerebro"
> es anterior a la separación.

## Datos

La fuente de verdad es **Supabase (Postgres)**. Tablas centrales: `users`,
`alertas`, `digests`. Hay tablas adicionales para auditoría, outbox de MIA,
conocimiento, etc. Las migraciones viven en `supabase/migrations/`.

## Pruebas y red de seguridad

- `npm run test:local` — suite unitaria local (sin red).
- `npm run check:core` — invariantes de negocio (lee el código y comprueba
  reglas clave: seguridad de rutas, fuentes de scrapers, lógica de digest…).
- `node scripts/inventario_rutas.js` — vuelca el inventario de endpoints; útil
  para verificar que un refactor no altera ninguna URL.
