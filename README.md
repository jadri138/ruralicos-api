# Ruralicos

![Status](https://img.shields.io/badge/status-beta-green)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.x-brightgreen)
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
4. `/alertas/preparar-digest` (genera 1 mensaje diario por usuario)
5. `/alertas/enviar-digest` (envía los digest pendientes)

La ruta legacy `/alertas/enviar-whatsapp` queda desactivada por defecto con `DIGEST_ONLY_MODE=true`.

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

---

## Estructura del proyecto

```text
ruralicos-api
├─ src
│  ├─ boletines
│  ├─ alertas
│  ├─ ia
│  ├─ cron
│  ├─ supabaseClient.js
│  └─ index.js
│
├─ README.md
├─ LICENSE
└─ CONTRIBUTING.md
Variables de entorno
env
Copiar código
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=...
Estado del proyecto
Beta activa con usuarios reales y ajustes continuos en clasificación y resúmenes.

Licencia
MIT

Contribuciones
Las contribuciones son bienvenidas mediante issues o pull requests.

Nota: este repositorio contiene únicamente la lógica del sistema.
