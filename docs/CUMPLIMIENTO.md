# Cumplimiento (RGPD / LOPDGDD) — estado y pendientes

Documento operativo de proteccion de datos de Ruralicos. Ultima revision: 2026-07-09.
No sustituye asesoramiento juridico; es el inventario tecnico sobre el que apoyarlo.

## 1. Datos personales tratados

| Dato | Donde | Finalidad | Base juridica |
| --- | --- | --- | --- |
| Telefono (verificado por WhatsApp) | `users.phone` | Envio del digest y conversacion MIA | Ejecucion de contrato (art. 6.1.b) |
| Nombre legal (nombre + apellidos) | `users.first_name/last_name_*/legal_name` | Deteccion en listados oficiales (FEGA, boletines) | Ejecucion de contrato |
| Email (opcional) | `users.email` | Contacto y recuperacion de cuenta | Ejecucion de contrato |
| Preferencias e intereses (declarados y aprendidos) | `users.preferences`, `user_interest_profile`, `user_memory`, `perfil_embedding` | Personalizacion del digest | Ejecucion de contrato + interes legitimo (mejora) |
| Conversaciones WhatsApp entrantes | `mia_inbound_messages`, `user_conversations` | Responder al usuario (agente MIA) y feedback | Ejecucion de contrato |
| Clicks en alertas (con `ip_hash`, ya anonimizada con sal) | `alerta_clicks` | Medir interes y aprender | Interes legitimo |
| Datos de socios aportados por cooperativas | `organization_clients`, `users.organization_id` | Servicio B2B a la cooperativa | La cooperativa es responsable; Ruralicos encargado (necesita contrato de encargo, ver §5) |

## 2. Encargados de tratamiento (procesadores)

| Proveedor | Que recibe | Region | DPA |
| --- | --- | --- | --- |
| Supabase (BD) | Toda la BD | UE (eu-north-1, Estocolmo) ✅ | Aceptar el DPA en el dashboard (Legal → DPA). **Pendiente de confirmar.** |
| Render (backend) | Trafico y logs de la API | Region del servicio (verificar; ideal Frankfurt) | DPA incluido en ToS; verificar region y SCCs. **Pendiente.** |
| UltraMsg (WhatsApp no oficial) | Telefonos + contenido de TODOS los mensajes | Desconocida | ⚠️ **Riesgo principal**: sin DPA verificable y contrario a ToS de WhatsApp. Mitigacion real: migrar a WhatsApp Business Cloud API cuando haya alta de autonomo/empresa. Mientras tanto: minimizar contenido personal en mensajes y documentar el riesgo. |
| OpenAI (IA) | Textos de alertas (publicos) + textos de feedback/conversacion del usuario + preferencias para embeddings | EE.UU. | Firmar el DPA de OpenAI (https://openai.com/policies/data-processing-addendum). La API no entrena con datos por defecto. **Pendiente.** |
| Vercel (frontends) | Trafico web | Global (edge) | DPA estandar de Vercel. **Pendiente de confirmar.** |
| Sentry (si se activa SENTRY_DSN) | Errores con request_id (sin cuerpos de peticion) | UE si se elige region EU al crear el proyecto | Elegir data residency UE + DPA. |

## 3. Retencion de datos

Politica implementada en `src/services/retencionDatos.js`, ejecutable con
`GET /tareas/retencion-datos` (cron token). Doble seguro: solo borra con
`RETENTION_ENABLED=true` en el env **y** `?dry_run=false` explicito; en
cualquier otro caso informa sin tocar nada. Cron recomendado: semanal.

| Tabla | Retencion | Motivo |
| --- | --- | --- |
| `webhook_events` | 90 dias | Log tecnico de webhooks (contiene payloads con telefono) |
| `logs` | 180 dias | Log operativo (telefonos enmascarados) |
| `whatsapp_logs` | 180 dias | Log de envios |
| `ia_runs` | 180 dias | Metricas de llamadas IA (sin datos personales) |
| `scraper_runs` / `pipeline_runs` | 365 dias | Historial operativo |
| `mia_inbound_messages` | — v2 pendiente | `mia_agent_cases.inbound_id` la referencia sin `on delete set null`; purgar requiere tratar antes los casos. Objetivo: 12 meses. |
| Datos de cuenta y aprendizaje | mientras exista la cuenta | Se eliminan con el derecho al olvido (abajo) |

## 4. Derechos de los interesados (ya implementado)

- **Supresion (olvido):** `DELETE /me` borra la cuenta y todas las filas del
  usuario (`USER_OWNED_TABLES`, cubierto por `tests/userDeletionTables.test.js`).
- **Acceso / portabilidad:** `GET /me/export` devuelve los datos del usuario.
- **Rectificacion:** `PUT /me` y `PUT /me/preferences`.
- **Memoria explicable:** `GET /me/memory` + `DELETE /me/memory/:id` (el usuario
  ve y borra lo aprendido sobre el).

## 5. Pendientes (por orden)

1. **Aceptar/firmar DPAs**: Supabase, OpenAI, Vercel, Render (checklist §2) y
   archivar los PDFs/confirmaciones.
2. **Contrato de encargo B2B**: plantilla de encargo de tratamiento entre la
   cooperativa (responsable) y Ruralicos (encargado) antes de salir de beta con
   organizaciones reales. Sin el, los datos de `organization_clients` no tienen
   cobertura.
3. **Registro de consentimiento explicito**: hoy el opt-in de WhatsApp se
   evidencia con el registro + verificacion del telefono (`phone_verified`,
   `created_at`, log `password_reset_done`...). Anadir en el alta un checkbox
   con texto legal y guardar `consent_at` + version del texto aceptado.
4. **Politica de privacidad publica** en ruralicos.es coherente con este
   inventario (proveedores, plazos, derechos y como ejercerlos).
5. **Retencion v2**: purga de `mia_inbound_messages` consciente de FKs.
6. **UltraMsg → WhatsApp Cloud API** cuando exista la figura legal (autonomo).
