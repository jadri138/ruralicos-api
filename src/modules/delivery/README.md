# Entrega de WhatsApp

Este módulo separa la aceptación de UltraMsg de la entrega real al teléfono.

## Estados

`DRAFT → APPROVED → QUEUED → PROVIDER_ACCEPTED → SENT_TO_WHATSAPP → DELIVERED → READ`

Los cierres de error son `FAILED` y `UNDELIVERED`. Un ACK repetido no vuelve a
aplicar efectos y un ACK antiguo nunca hace retroceder el estado.

UltraMsg se interpreta así:

| ACK UltraMsg | Estado Ruralicos |
| --- | --- |
| `pending` | `PROVIDER_ACCEPTED` |
| `server` | `SENT_TO_WHATSAPP` |
| `device` | `DELIVERED` |
| `read` / `played` | `READ` |

`digests.enviado` solo pasa a `true` con `DELIVERED` o `READ`, no con el HTTP
200 del envío.

## Webhook y conciliación

- Webhook: `POST /webhooks/ultramsg/feedback?token=...`.
- En UltraMsg deben estar activos `webhook_message_received` y
  `webhook_message_ack`.
- Conciliación: `POST /tareas/whatsapp-reconcile`, autenticado con el token de
  cron. Acepta `limit` y `dry_run=true`.

La conciliación consulta mensajes por ID de proveedor. Los tests siempre
inyectan un `fetch` falso y no contactan UltraMsg.

## Seguridad operativa

- Las comunicaciones automaticas entran por `mia_outbox`; `encolarComunicacionWhatsApp`
  permite reutilizar la misma cola para digest, FREE y exploracion.
- Cada outbox conserva `idempotency_key`, `message_version` e ID del proveedor.
- Un item aceptado o posterior no vuelve a enviarse: se concilia.
- Un reinicio durante el envío se considera ambiguo y tampoco reenvía a ciegas.
- Las preguntas de aprendizaje crean memoria y conversación solo tras el primer
  `DELIVERED` o `READ`; un ACK repetido no repite esos efectos. Si el proceso cae
  durante ese postproceso, un lease vencido permite que otro ACK lo complete de
  forma idempotente.
- Los eventos guardan un payload sanitizado, sin teléfono, texto ni tokens.

## Límite de este cambio

Los avisos de listados oficiales vinculados a fuentes y boletines conservan su
flujo actual. Este trabajo no modifica esos notificadores porque la captura y
los módulos de boletines están expresamente fuera de alcance.
