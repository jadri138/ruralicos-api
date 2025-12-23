# Ruralicos

![Status](https://img.shields.io/badge/status-beta-green)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.x-brightgreen)
![API](https://img.shields.io/badge/type-REST_API-orange)
![IA](https://img.shields.io/badge/IA-OpenAI-purple)

Ruralicos es un sistema de **procesado y filtrado de boletines oficiales** orientado al sector agrario y rural.

El objetivo del proyecto es **extraer, resumir y clasificar información relevante** de boletines oficiales y generar alertas personalizadas para los usuarios.

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

yaml
Copiar código

---

## 4️⃣ Resultado

Con este README:
- ✅ Se ve bien en GitHub
- ✅ No suena a marketing
- ✅ Es creíble como proyecto técnico
- ✅ No promete más de lo que hace
- ✅ Protege legalmente


