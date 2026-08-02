# Feedback y clics

Captura las señales que deja el usuario después de recibir un digest. Alimenta aprendizaje y MIA sin tratar cada interacción como una orden absoluta.

## Archivos

| Archivo | Función |
| --- | --- |
| `clicks.routes.js` | Enlaces de tracking, redirección al documento y consulta reciente |
| `feedback.routes.js` | Webhook, parser, simulación y diagnóstico |
| `feedback.service.js` | Persistencia y aplicación de la valoración |

## Clics

Cada enlace usa un token opaco asociado a usuario, digest y alerta. Al abrirlo:

1. se valida el token;
2. se registra el clic de forma idempotente;
3. se redirige a la URL oficial;
4. el aprendizaje recibe una señal positiva moderada, no una preferencia definitiva.

Las rutas `/?a=`, `/a/:token` y `/alerta/:token` se registran antes que otras rutas raíz.

## Respuestas

El webhook acepta mensajes como valoraciones numéricas, referencias a posiciones y lenguaje natural. La clasificación conserva:

- alerta o alertas referidas;
- valor/señal;
- categoría;
- confianza;
- fragmento y contexto;
- si necesita aclaración.

Una respuesta ambigua no debe repartir una señal fuerte a todas las alertas.

Las conversaciones siguen cerrando al final de cada día. Si la respuesta llega
después, solo se recupera el último digest `DELIVERED` o `READ` de las 72 horas
anteriores cuando el mensaje identifica sin duda un número de item. Una fecha,
una frase genérica o una conversación nueva no se asocian al digest anterior.

La señal se guarda como memoria atómica en `user_memory`: respuesta explícita
por encima de clic, con ámbito y polaridad limitados. Un error de envío,
`FAILED` o `UNDELIVERED` es un hecho de transporte y no actualiza preferencias.

## ACK de entrega

`POST /webhooks/ultramsg/feedback` distingue primero los eventos de entrega y
solo después intenta interpretar un mensaje humano. El ACK se correlaciona con
`provider_message_id`, se deduplica y avanza sin retrocesos:

```text
pending -> PROVIDER_ACCEPTED
server  -> SENT_TO_WHATSAPP
device  -> DELIVERED
read    -> READ
```

Un HTTP 200 al enviar no marca `digests.enviado`. Ese campo solo pasa a `true`
con `DELIVERED` o `READ`. Los ACK sin correspondencia también dejan una traza
sanitizada para diagnóstico.

## Seguridad

- Validar `ULTRAMSG_WEBHOOK_TOKEN`.
- Deduplicar eventos del proveedor.
- Normalizar teléfono y evitar PII en logs.
- No confiar en campos de identidad enviados por el cliente.
- Mantener endpoints de prueba protegidos para admin/cron.

Pruebas: `feedbackParser`, `feedbackClassifier`, `clickLearningWeight`,
`ultramsgParser`, `atomicMemory`, `whatsappDelivery` y pruebas de inbound/webhook
de MIA.
