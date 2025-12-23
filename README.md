# 🌾 Ruralicos

![Status](https://img.shields.io/badge/status-beta-green)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.x-brightgreen)
![API](https://img.shields.io/badge/type-REST_API-orange)
![IA](https://img.shields.io/badge/IA-OpenAI-purple)
![Made in Spain](https://img.shields.io/badge/made%20in-Spain-red)

**Ruralicos** es una plataforma digital de alertas e información para el **sector agrario, ganadero y rural**.  
Convierte boletines oficiales (BOE, boletines autonómicos, etc.) en **resúmenes claros**, filtrados y personalizados.

---

## 🚜 Problema que resuelve

Los boletines oficiales son largos, técnicos y difíciles de seguir a diario.

Ruralicos:
- Filtra lo relevante
- Resume en lenguaje claro
- Avisa solo de lo que importa a cada usuario

---

## ✨ Funcionalidades

- 📄 Procesado automático de boletines oficiales
- 🤖 Resúmenes mediante IA
- 🗺️ Detección de provincias
- 🌱 Clasificación por sectores y subsectores
- 🔔 Alertas personalizadas
- 🧠 Revisión automática de alertas
- 📊 Base preparada para planes Free / Pro

---

## 👨‍🌾 Público objetivo

- Agricultores
- Ganaderos
- Técnicos agrarios
- Comunidades de regantes
- Cooperativas
- Gestorías rurales

---

## 🧩 Cómo funciona

1. Descarga de boletines oficiales  
2. Detección de nuevas resoluciones  
3. Procesado por IA (resumen + clasificación)  
4. Guardado en base de datos  
5. Envío de alertas según filtros del usuario  

---

## 🔔 Estados de las alertas

- `procesando IA`
- `no importa`
- `pendiente de revisión`
- `revisada`

El sistema revisa automáticamente todo lo que no sea **no importa**.

---

## 🧑‍💻 Tecnologías

- Node.js
- Express
- Supabase
- OpenAI
- Cron Jobs
- WordPress (frontend)
- CSS personalizado

---

## 📂 Estructura del proyecto

ruralicos-api/
│
├── src/
│ ├── boletines/
│ ├── alertas/
│ ├── ia/
│ ├── cron/
│ ├── supabaseClient.js
│ └── index.js
│
└── README.md

yaml
Copiar código

---

## 🔐 Variables de entorno

```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=...
🚧 Estado del proyecto
🟢 Beta pública activa

Proyecto en desarrollo continuo con usuarios reales y mejoras constantes.

🗺️ Roadmap
Más boletines autonómicos

Alertas fitosanitarias

Resúmenes mensuales y anuales

Panel Pro avanzado

Históricos y estadísticas

Escalado de usuarios

📜 Licencia
Este proyecto está bajo licencia MIT.

🤝 Contribuciones
Las contribuciones son bienvenidas.
Abre un issue o envía un pull request.

🌍 Filosofía
Información rural clara, útil y accesible.

Menos BOE.
Más campo.

ℹ️ Nota
Este repositorio no incluye claves privadas ni datos personales.

sql
Copiar código

---

## 📄 LICENSE (MIT)

```txt
MIT License

Copyright (c) 2025 Ruralicos

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
📄 CONTRIBUTING.md
md
Copiar código
# Contribuir a Ruralicos

Gracias por tu interés en contribuir a **Ruralicos**.

## Cómo contribuir

1. Haz un fork del repositorio
2. Crea una rama nueva (`feature/nueva-funcionalidad`)
3. Realiza tus cambios de forma clara y documentada
4. Envía un Pull Request explicando el cambio

## Reglas básicas

- No subir claves privadas ni datos sensibles
- Mantener el código claro y legible
- Explicar bien el objetivo del cambio

## Reportar errores

Si encuentras un error:
- Abre un Issue
- Describe qué ocurre y cómo reproducirlo

---

Gracias por ayudar a mejorar la información rural.
