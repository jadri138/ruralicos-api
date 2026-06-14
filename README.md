# Ruralicos

![Status](https://img.shields.io/badge/status-beta-green)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20.18.1-brightgreen)
![API](https://img.shields.io/badge/type-REST_API-orange)
![IA](https://img.shields.io/badge/IA-OpenAI-purple)

Ruralicos es un sistema de **procesado y filtrado de boletines oficiales** orientado al sector agrario y rural.

El objetivo del proyecto es **extraer, resumir y clasificar información relevante** de boletines oficiales y generar alertas personalizadas para los usuarios que se envian via whatsapp.

---

## Qué hace el proyecto

- Procesa boletines oficiales (BOE y autonómicos)
- Genera resúmenes en lenguaje claro mediante IA
- Detecta provincias y sectores afectados
- Clasifica alertas por temática
- Permite marcar alertas como revisadas o no relevantes
- Sirve como backend para una plataforma de alertas rurales

---

## Qué NO hace

- No sustituye asesoramiento legal o técnico
- No publica textos oficiales completos
- No incluye datos personales ni claves privadas
- No es un producto final cerrado (está en beta)

---

## Funcionamiento general

1. Descarga de boletines oficiales
2. Identificación de nuevos anuncios
3. Procesado mediante IA:
   - Resumen
   - Clasificación territorial
   - Clasificación sectorial
4. Almacenamiento en base de datos
5. Consulta y filtrado según preferencias del usuario

## Flujo recomendado de envío (sin spam)

Para evitar enviar muchas alertas sueltas al mismo usuario, el flujo recomendado es:

1. `/alertas/clasificar`
2. `/alertas/resumir`
3. `/alertas/revisar`
4. `/alertas/deduplicar`
5. `/alertas/preparar-digest` (genera 1 mensaje diario por usuario)
6. `/alertas/enviar-digest` (envía los digest pendientes)

La ruta legacy `/alertas/enviar-whatsapp` queda desactivada por defecto con `DIGEST_ONLY_MODE=true`.

### Requisito de base de datos para digest

Si en tu diagrama solo aparecen `users` y `alertas`, te falta crear la tabla `digests`
(y algunos indices/constraints). Aplica la migracion operativa en Supabase antes de
lanzar el pipeline de digest.

### Cron recomendado (pipeline completo)

Todas las rutas de cron validan `?token=CRON_TOKEN` por compatibilidad.
Para llamadas internas o scripts propios, preferir el header `x-cron-token`.

El cron recomendado es un unico golpe diario al pipeline completo:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$PUBLIC_BASE_URL/tareas/pipeline-diario"
```

Ese endpoint ejecuta scrapers BOE/autonomicos, fuentes complementarias
provinciales, FEGA si esta activado, cotejo de listados, IA por lotes,
deduplicacion, digest y resumen free.

Detalle y comandos listos para copiar:

- `docs/cron_digest_setup.md`
- Guia rapida de Render: `docs/render_quick_start.md`

---

## Estados de las alertas

- `procesando IA`
- `no importa`
- `pendiente de revisión`
- `revisada`

Las alertas se revisan automáticamente salvo que se marquen como no relevantes.

---

## Tecnologías utilizadas

- Node.js
- Express
- Supabase
- OpenAI API
- Cron jobs
- WordPress (frontend externo)

Requisito de runtime: Node.js `>=20.18.1`.

---

## Estructura del proyecto

El código sigue una organización **modular por dominio** (modular monolith).
Mapa rápido:

```text
src/
├─ server.js              # entrypoint: arranca el servidor (app.listen)
├─ app.js                 # construye la app Express (seguridad, /health, /stats)
├─ routes.js              # registro central de todas las rutas
├─ config/                # planes de suscripción y configuración
├─ middleware/            # requireAdmin, cronToken
├─ platform/              # clientes de infraestructura: supabase, whatsapp, ia/, http
├─ shared/                # utilidades puras (fechas, similitud, html/pdf, teléfono…)
├─ services/              # servicios de negocio transversales (listas oficiales, planes)
└─ modules/               # un dominio por carpeta:
   ├─ boletines/          #   scrapers + rutas de cada fuente oficial (BOE, BOJA, DOG…)
   ├─ alertas/            #   alta/revisión/dedup + motor de selección (seleccion/)
   ├─ digest/             #   mensaje diario por usuario (routes + service)
   ├─ feedback/           #   webhooks de feedback y tracking de clics
   ├─ aprendizaje/        #   aprendizaje por keywords/score + perfilado (cerebro)
   ├─ mia/                #   agente conversacional (decisión, outbox, conocimiento…)
   ├─ usuarios/           #   usuarios, auth y preferencias
   ├─ admin/              #   panel de administración (5 sub-rutas + helpers)
   ├─ tareas/             #   orquestación del pipeline diario
   ├─ embeddings/         #   generación de embeddings de alertas
   └─ taxonomy/           #   taxonomía rural (sectores/subsectores)
```

Para entender cómo encaja todo (ciclo de vida de una petición, el pipeline
diario y la frontera entre `aprendizaje` y `mia`), ver **[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)**.
Convenciones de código y dónde va cada cosa: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Arranque local

```bash
npm install
cp .env.example .env   # y rellena las variables
npm start              # o: node src/server.js
```

Comprobaciones de salud: `GET /health` (incluye estado de Supabase y de las env)
y `GET /stats` (cifras públicas).

## Variables de entorno

Todas las variables están documentadas en **[.env.example](.env.example)**.
Las imprescindibles para arrancar:

| Variable | Para qué sirve |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Acceso a la base de datos (backend) |
| `OPENAI_API_KEY` | Resúmenes, clasificación y embeddings |
| `JWT_SECRET` | Firma de tokens de sesión |
| `CRON_TOKEN` | Autoriza las rutas de cron (`?token=` o header `x-cron-token`) |
| `ULTRAMSG_INSTANCE_ID`, `ULTRAMSG_TOKEN` | Envío de WhatsApp vía UltraMsg |
| `ULTRAMSG_WEBHOOK_TOKEN` | Valida el webhook entrante `/webhooks/ultramsg/feedback` |
| `PUBLIC_BASE_URL` | URL pública (enlaces de tracking, cron internos) |

El resto (lotes de IA, ajustes de digest, timeouts de scrapers, etc.) son
opcionales y tienen valores por defecto sensatos.

## Pruebas

```bash
npm run test:local   # suite local (tests unitarios, sin red)
npm run check:core   # invariantes de lógica de negocio
```

## Estado del proyecto

Beta activa con usuarios reales y ajustes continuos en clasificación, resúmenes
y experiencia del digest.

## Licencia

MIT. Las contribuciones son bienvenidas mediante issues o pull requests.

> Nota: este repositorio contiene únicamente la lógica del sistema (backend).
